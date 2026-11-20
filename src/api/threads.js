/**
 * App 的 thread 与现有编排层的接线。
 *
 * 核心观察：整个编排层把「会话标识」当不透明字符串用
 * （见 src/state.js:31 `#file(groupId)`），从不把它当数字。
 * 所以 App 的 threadId 可以直接塞进 handleMessage 的 groupId 参数，
 * 状态机、并发槽、worktree 池、产物校验、git 操作一行都不用改。
 *
 * 这个文件只做三件事：生成 threadId、把消息投进编排层、把内部状态
 * 翻译成 App 要的形状。所有真正的逻辑仍然在 flow-bridge 里。
 */
import { newSecret } from '../account/auth.js'

/**
 * 生成 threadId。
 *
 * 用短随机串而不是 UUID：它会出现在文件名（group-<id>.json、
 * <id>.jsonl）和 URL 里，36 位 UUID 读日志时很难一眼区分。
 * 12 位 base36 空间约 4.7e18，团队内部场景不会撞。
 */
export function newThreadId() {
  return `t${newSecret().replace(/[^a-z0-9]/gi, '').slice(0, 11)}`
}

/**
 * @param {object} o
 * @param {object} o.machine   GroupStateMachine
 * @param {object} o.flowBridge
 * @param {import('../store/messages.js').MessageStore} o.messages
 * @param {(o:object)=>Promise<object>} o.buildSnapshot  index.js 提供的快照函数
 * @param {(action:string, threadId:string, userId:string)=>Promise<{ok:boolean,role:string|null}>} o.can
 * @param {(...a:any[])=>void} o.log
 */
export function createThreadService({ machine, flowBridge, messages, buildSnapshot, can, log }) {
  /**
   * 把 snapshot 里的一条群记录翻译成 App 的 thread 形状。
   *
   * 为什么不直接用 snapshot 原样返回：那一堆字段名是给管理面板的
   * （groupName、reqId、workDir…），App 端叫 threadId/name/stage
   * 更自然，而且面板将来可能改。转一层，两边互不牵连。
   */
  const toThread = (g) => ({
    threadId: g.groupId,
    name: g.name ?? null,
    reqId: g.reqId ?? null,
    stage: g.stage ?? null,
    stageStatus: g.stageStatus ?? null,
    status: g.status ?? null,
    waitingLabel: g.waitingLabel ?? null,
    turn: g.turn ?? 0,
    initiator: g.initiator
      ? {
          userId: g.initiator.userId,
          nickname: g.initiator.nickname,
        }
      : null,
    lastActiveAt: g.lastActiveAt ?? null,
    running: Boolean(g.activeTurn),
    // 「等我确认」——App 列表页要靠它决定置顶和红色角标
    needsMe: g.stageStatus === '等你确认',
    stages: g.stages ?? [],
    featureBranch: g.featureBranch ?? null,
  })

  /** 需求列表。过滤掉没有 flow 的历史残留（旧版 QQ 群数据） */
  async function listThreads() {
    const snap = await buildSnapshot({ full: true })
    return (snap.groups ?? [])
      .filter((g) => !g.legacy)
      .map(toThread)
      .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
  }

  /** 单条需求详情 */
  async function threadInfo(threadId) {
    const snap = await buildSnapshot({ full: true })
    const g = (snap.groups ?? []).find((x) => x.groupId === threadId)
    if (!g || g.legacy) return null
    return toThread(g)
  }

  /**
   * 新建需求。
   *
   * 注意这里是**不等回合跑完**的：一次需求要走完需求→设计→方案→开发…
   * 好几个阶段，可能几十分钟。HTTP 请求等不起，App 也不该转圈半小时。
   * 所以立刻返回 threadId，让 App 去轮询消息流看进展——
   * 这和 QQ 群里「发完就看到进度播报」是同一个体验，只是换了通道。
   */
  async function createThread({ text, user }) {
    const threadId = newThreadId()

    // 先把「用户说了什么」落库，再交给编排层。
    // 顺序不能反：如果先投递、回合立刻开始播报，App 拉消息时
    // 会先看到 bot 的回复、后看到自己说的话，对话读起来是颠倒的。
    messages.append(threadId, {
      role: 'user',
      kind: 'text',
      payload: { text },
      at: Date.now(),
    })

    const st = machine.peek(threadId)
    if (!st) {
      return { ok: false, error: '这个项目当前不接受新需求（检查 groupPolicy 配置）' }
    }

    const initiator = {
      userId: user.id,
      nickname: user.nickname || user.username,
      at: Date.now(),
    }
    st.initiator = initiator
    machine.store.save(threadId, { ...st, initiator })

    log(`[api] ${user.username} 新建需求 ${threadId}：${text.slice(0, 60)}`)

    // fire-and-forget：错误必须自己吞掉并落库，
    // 否则会变成 unhandledRejection 把整个 bridge 进程带走。
    void flowBridge
      .handleMessage({
        groupId: threadId,
        text,
        replyTo: null,
        st,
        initiator,
        can: (action, uid) => can(action, threadId, uid),
      })
      .catch((err) => {
        log(`[api] 需求 ${threadId} 启动失败：${err.message}`)
        try {
          messages.append(threadId, {
            role: 'bot',
            kind: 'text',
            payload: { text: `启动失败：${err.message}` },
          })
        } catch {
          /* 落库也失败就只剩日志了 */
        }
      })

    return { ok: true, threadId, thread: await threadInfo(threadId) }
  }

  /**
   * 往已有需求里投一条消息（普通发言 / 通过 / 打回 都走这里）。
   *
   * 为什么通过/打回也走普通消息通道：agent 是按自然语言工作的，
   * 「通过」两个字它本来就能理解。为按钮单独造一套结构化协议，
   * 等于让同一件事有两套语义，将来改流程要同时改两处。
   */
  async function deliver({ threadId, text, user }) {
    const st = machine.peek(threadId)
    if (!st) return { ok: false, error: '没有这个需求' }

    const initiator = {
      userId: user.id,
      nickname: user.nickname || user.username,
      at: Date.now(),
    }
    // 记录「最后说话的人」，面板和 App 都靠它显示谁在推动
    machine.store.save(threadId, { ...st, initiator })

    log(`[api] ${user.username} → ${threadId}：${text.slice(0, 60)}`)

    void flowBridge
      .handleMessage({
        groupId: threadId,
        text,
        replyTo: null,
        st,
        initiator,
        can: (action, uid) => can(action, threadId, uid),
      })
      .catch((err) => {
        log(`[api] 需求 ${threadId} 投递失败：${err.message}`)
        try {
          messages.append(threadId, {
            role: 'bot',
            kind: 'text',
            payload: { text: `处理失败：${err.message}` },
          })
        } catch {
          /* ignore */
        }
      })

    // 立刻返回，不等回合跑完
    return { ok: true, accepted: true }
  }

  return { listThreads, threadInfo, createThread, deliver }
}
