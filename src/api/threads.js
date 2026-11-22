/**
 * App 的「群」与背后的编排层/需求引擎的接线。
 *
 * 名词：App 里的「群」就是这个文件里的 thread，也是编排层的 groupId。
 * 群是容器，需求是群里跑的那条 flow。一个群先当聊天用，@ 一下需求 bot
 * 才开始跑需求——见 src/im/router.js 的规则说明。
 *
 * 拆分后的两种运行形态：
 *   - 单机（src/index.js）：dispatch 直接调 flowBridge，进程内完成；
 *   - 拆分（src/im.js + src/engine.js）：dispatch 只往事件队列里塞一条，
 *     远处的引擎长轮询拿到再跑。
 * 这个文件不关心是哪一种，它只保证「消息落库 + 交给 dispatch」。
 *
 * 状态文件（.state/group-<id>.json）在拆分形态下由 IM 独占：群名、模式、
 * 引擎报回来的阶段都在里面。引擎自己另有一份状态目录存 flow 细节。
 */
import { newSecret } from '../account/auth.js'
import { mentionsOf, routeMessage, stripBotMention } from '../im/router.js'

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
 * 判断一个 .state 里的键是不是 App 建的 thread。
 *
 * 判据是「t 开头且不是纯数字」，而不是「有没有 flow」：QQ 通道删掉了，
 * 但跑过 QQ 的老机器上 .state/ 里还留着 group-<群号>.json，那些有 flow、
 * 也能被当会话跑起来。要是列表里漏出它们，用户在 App 里发言会真的
 * 写进那个群号对应的状态文件和消息库——一个已经不存在的群。
 */
export function isAppThread(threadId) {
  const s = String(threadId ?? '')
  return s.length > 2 && s.startsWith('t') && !/^\d+$/.test(s)
}

/**
 * @param {object} o
 * @param {object} [o.machine]   GroupStateMachine（单机模式有，拆分模式没有）
 * @param {import('../state.js').SessionStore} [o.store]  群状态文件（machine.store 的别名）
 * @param {import('../store/messages.js').MessageStore} o.messages
 * @param {(o:object)=>Promise<object>} [o.buildSnapshot]  有编排层时才有
 * @param {(ev:object)=>Promise<object>} o.dispatch  把一条消息交给引擎（进程内或事件队列）
 * @param {(action:string, threadId:string, userId:string)=>Promise<{ok:boolean,roleLabel?:string}>} o.can
 * @param {import('../store/members.js').MemberStore} o.members  群成员表
 * @param {{id:string,nickname:string,role?:string,isBot?:boolean}} [o.botUser]  机器人账号（自动群管理员）
 * @param {(...a:any[])=>void} o.log
 * @param {string} [o.botName]
 */
export function createThreadService({ machine, store, messages, buildSnapshot, dispatch, can, members, botUser, log, botName }) {
  const groups = store ?? machine?.store ?? null
  if (!groups) throw new Error('createThreadService 需要 store 或 machine')
  // 成员表是「能不能看见这个群」的唯一判据。缺了它就只剩「所有人可见」，
  // 那是一种更难发现的错误，所以宁可启动时报错。
  if (!members) throw new Error('createThreadService 需要 members（群成员表）')

  const get = (id) => {
    try {
      return groups.get(id)
    } catch {
      return null
    }
  }

  const exists = (saved) => Boolean(saved) && Object.keys(saved).length > 0

  /**
   * 老群补成员表：功能上线前建的群没有成员文件，用群状态的 initiator 当群主，
   * 机器人补管理员。放在读路径上而不是写一次迁移脚本——迁移脚本漏跑一次，
   * 群里的人就全看不见了。
   */
  const ensureMembers = (threadId, saved) => {
    const owner = saved?.initiator?.userId
      ? { userId: saved.initiator.userId, nickname: saved.initiator.nickname, at: saved.initiator.at }
      : null
    return members.ensure(threadId, { owner, bot: botUser })
  }

  /**
   * 列表/详情都要带上的成员信息；myRole 让 App 决定显不显示管理者操作。
   *
   * unread 是「别人发的、我读到哪儿之后还有多少条」：列表页靠它点红点。
   * 自己发的不算（store 里按 userId 排除），否则自己说句话就冒红点。
   */
  const withMembers = (thread, userId) => {
    const lastReadSeq = userId ? members.lastReadOf(thread.threadId, userId) : 0
    const preview = messages.preview?.(thread.threadId) ?? null
    return {
      ...thread,
      memberCount: members.count(thread.threadId),
      myRole: userId ? members.roleOf(thread.threadId, userId) : null,
      lastReadSeq,
      unread: userId ? messages.unreadCount(thread.threadId, { after: lastReadSeq, userId }) : 0,
      // 列表卡片第二行：最后一条消息摘要。没有消息时是 null，App 自己降级成
      // 「群聊」之类的占位，服务端不替它编文案。
      lastMessage: preview
        ? {
            seq: preview.seq,
            role: preview.role,
            userId: preview.userId,
            nickname: preview.nickname,
            kind: preview.kind,
            text: preview.text,
          }
        : null,
    }
  }

  /**
   * 把落盘的群状态翻译成 App 的形状。
   *
   * 拆分形态下没有编排层快照，阶段信息全靠引擎回写到 st.engine；
   * 单机形态下用 buildSnapshot 覆盖它（那份更全，还带十个阶段格子）。
   */
  const fromSaved = (threadId, saved) => {
    const en = saved?.engine && typeof saved.engine === 'object' ? saved.engine : {}
    const pending = !en.reqId && !saved?.reqId
    const stageStatus = pending
      ? '待提需求'
      : (en.stageStatus ?? (saved?.reqId ? '旧版需求' : '进行中'))
    return {
      threadId,
      name: en.reqName ?? null,
      groupName: saved?.name ?? null,
      mode: saved?.mode ?? 'chat',
      pending,
      reqId: en.reqId ?? saved?.reqId ?? null,
      stage: en.stage ?? null,
      stageStatus,
      status: en.running ? (stageStatus === '等你确认' ? 'waiting' : 'running') : 'idle',
      waitingLabel: en.waitingLabel ?? '',
      turn: saved?.turn ?? 0,
      initiator: saved?.initiator
        ? { userId: saved.initiator.userId, nickname: saved.initiator.nickname }
        : null,
      lastActiveAt: saved?.lastActiveAt ?? Date.now(),
      running: Boolean(en.running),
      // 「等我确认」——App 列表页要靠它决定置顶和红色角标
      needsMe: stageStatus === '等你确认',
      stages: [],
      featureBranch: en.featureBranch ?? null,
    }
  }

  /** 编排层快照的一条（单机模式），补上群名和模式 */
  const fromSnapshot = (g, saved) => ({
    ...fromSaved(g.groupId, saved),
    name: g.name ?? null,
    pending: false,
    reqId: g.reqId ?? null,
    stage: g.stage ?? null,
    stageStatus: g.stageStatus ?? null,
    status: g.status ?? null,
    waitingLabel: g.waitingLabel ?? null,
    turn: g.turn ?? 0,
    initiator: g.initiator
      ? { userId: g.initiator.userId, nickname: g.initiator.nickname }
      : null,
    lastActiveAt: g.lastActiveAt ?? null,
    running: Boolean(g.activeTurn),
    needsMe: g.stageStatus === '等你确认',
    stages: g.stages ?? [],
    featureBranch: g.featureBranch ?? null,
  })

  /**
   * 需求列表。
   *
   * 只列 App 建的 thread（isAppThread）：跑过 QQ 群的老机器上，.state 里
   * 躺着一堆真实群记录，带出来用户会看到自己从没建过的群。
   */
  async function listThreads({ userId = null } = {}) {
    const threads = new Map()
    if (typeof buildSnapshot === 'function') {
      const snap = await buildSnapshot({ full: true })
      for (const g of snap.groups ?? []) {
        if (!isAppThread(g.groupId) || g.legacy) continue
        const saved = get(g.groupId)
        ensureMembers(g.groupId, saved)
        threads.set(g.groupId, fromSnapshot(g, saved))
      }
    }

    // 落盘兜底：没有编排层（IM 单独跑）时列表就只有这一条路径；
    // 单机模式下它负责补上「刚建好、快照里还没 flow」的那几十毫秒窗口。
    for (const id of groups.allGroupIds?.() ?? []) {
      if (!isAppThread(id) || threads.has(id)) continue
      const saved = get(id)
      if (!exists(saved)) continue
      ensureMembers(id, saved)
      threads.set(id, { ...fromSaved(id, saved), lastSeq: messages.lastSeq(id) })
    }

    // 群是私有的：只回自己加入的群。系统管理员也一样——
    // 「能管所有账号」不等于「能偷看所有群」。
    const visible = [...threads.values()]
      .filter((t) => members.isMember(t.threadId, userId))
      .map((t) => withMembers(t, userId))
    return visible.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
  }

  /** 单个群的详情 */
  async function threadInfo(threadId, { userId = null } = {}) {
    if (!isAppThread(threadId)) return null
    const saved = get(threadId)
    const valid = exists(saved)
    ensureMembers(threadId, saved)

    if (typeof buildSnapshot === 'function') {
      const snap = await buildSnapshot({ full: true })
      const g = (snap.groups ?? []).find((x) => x.groupId === threadId)
      if (g && !g.legacy) return withMembers(fromSnapshot(g, saved), userId)
    }
    // 还没有需求、或没有编排层：靠落盘状态兜底，别让详情页 404
    if (!valid) return null
    return withMembers(fromSaved(threadId, saved), userId)
  }

  /**
   * 建群。
   *
   * 只建容器、不建需求：群建好之后在里面 @ 需求 bot 说第一句话，
   * 那条消息才是需求描述。建群要写盘再返回，App 建完立刻 GET 详情必须能查到。
   */
  async function createGroup({ name, user }) {
    const threadId = newThreadId()
    const initiator = {
      userId: user.id,
      nickname: user.nickname || user.username,
      at: Date.now(),
    }
    const groupName = String(name ?? '').trim() || '新群'
    // 显式写全字段，不依赖 machine.peek 的默认值：拆分形态下没有编排层，
    // 这里存的形状就是 IM 看到的全部。
    groups.save(threadId, {
      status: 'idle',
      mode: 'chat',
      name: groupName,
      initiator,
      lastActiveAt: initiator.at,
    })
    // 建群的人自动是群主；机器人跟着进群当管理员（它要能发消息、也要出现在成员里）
    ensureMembers(threadId, { initiator })

    log(`[api] ${user.username} 新建群 ${threadId}：${groupName}`)

    return {
      ok: true,
      threadId,
      thread: withMembers(
        fromSaved(threadId, {
          mode: 'chat',
          name: groupName,
          initiator,
          lastActiveAt: initiator.at,
        }),
        user.id,
      ),
    }
  }

  /**
   * 加入群。
   *
   * 幂等：重复扫码、重复点「加入」都只当一次。已经在群里就原样返回，
   * 不做任何降级——有人被指定成管理员后又扫了一次码，不该掉回普通成员。
   */
  async function joinGroup({ threadId, user }) {
    if (!isAppThread(threadId)) return { ok: false, notFound: true }
    const saved = get(threadId)
    if (!exists(saved)) return { ok: false, notFound: true }
    ensureMembers(threadId, saved)
    const before = members.isMember(threadId, user.id)
    if (!before) {
      members.add(threadId, {
        id: user.id,
        nickname: user.nickname || user.username,
        isBot: false,
        // 从进群这一刻开始算未读：一进来就把历史全标成红点，那是 99+，
        // 相当于告诉用户「你错过了一堆你没参与过的对话」。
        lastReadSeq: messages.lastSeq(threadId),
      })
      log(`[api] ${user.username} 加入群 ${threadId}`)
    }
    const info = await threadInfo(threadId, { userId: user.id })
    return { ok: true, joined: !before, thread: info }
  }

  /**
   * 改群名。
   *
   * 权限：系统管理员或群管理员。群主也在 members 里记成 owner，
   * 所以这里只问成员表，不用再比 initiator——两处判据迟早会不一致。
   */
  async function renameGroup({ threadId, name, user }) {
    if (!isAppThread(threadId)) return { ok: false, notFound: true }
    const saved = get(threadId)
    if (!exists(saved)) return { ok: false, notFound: true }
    ensureMembers(threadId, saved)
    if (!members.isMember(threadId, user.id)) {
      return { ok: false, forbidden: true, error: '你还没加入这个群' }
    }
    const myRole = members.roleOf(threadId, user.id)
    if (user.role !== 'admin' && myRole !== 'owner' && myRole !== 'admin') {
      return { ok: false, forbidden: true, error: '只有群管理员能改群名' }
    }
    const groupName = String(name ?? '').trim()
    if (!groupName) return { ok: false, error: '群名不能为空' }
    if (groupName.length > 40) return { ok: false, error: '群名太长了，40 字以内' }

    const next = { ...saved, name: groupName }
    groups.save(threadId, next)
    log(`[api] ${user.username} 把群 ${threadId} 改名为「${groupName}」`)
    const info = await threadInfo(threadId, { userId: user.id })
    return { ok: true, thread: info, groupName }
  }

  /**
   * 群成员列表。
   *
   * isBot 交给存储层记（机器人是账号表里的真实账号，但界面上要能区分
   * 「不能改角色」的那一个），canManage 只有群主为真——指定管理员是群主专属。
   */
  async function membersOf({ threadId, user }) {
    if (!isAppThread(threadId)) return { ok: false, notFound: true }
    const saved = get(threadId)
    if (!exists(saved)) return { ok: false, notFound: true }
    ensureMembers(threadId, saved)
    if (!members.isMember(threadId, user.id)) {
      return { ok: false, forbidden: true, error: '你还没加入这个群' }
    }
    const myRole = members.roleOf(threadId, user.id)
    return {
      ok: true,
      ownerId: members.get(threadId)?.ownerId ?? null,
      canManage: myRole === 'owner',
      canRename: user.role === 'admin' || myRole === 'owner' || myRole === 'admin',
      members: members.list(threadId),
    }
  }

  /** 群主指定/取消群管理员（bot 与群主由存储层拒绝） */
  async function setMemberRole({ threadId, userId, role, user }) {
    if (!isAppThread(threadId)) return { ok: false, notFound: true }
    const saved = get(threadId)
    if (!exists(saved)) return { ok: false, notFound: true }
    ensureMembers(threadId, saved)
    if (members.roleOf(threadId, user.id) !== 'owner') {
      return { ok: false, forbidden: true, error: '只有群主能指定群管理员' }
    }
    const result = members.setRole(threadId, userId, role)
    if (!result.ok) return result
    const info = await threadInfo(threadId, { userId: user.id })
    return { ok: true, thread: info, members: members.list(threadId) }
  }

  /**
   * 往群里投一条消息。
   *
   * 四种归宿（见 src/im/router.js）：
   *   chat    —— 普通聊天，落库就完事，不惊动引擎
   *   start   —— @ 了需求 bot 且群还是聊天模式：开需求，权限同建群
   *   message —— 需求群里 @ 了 bot 的话，转给引擎
   *
   * 唯一的例外是 through=force：通过/打回是界面上的按钮，不是打字，
   * 不该要求用户再去 @ 一次；权限已经由路由层（confirm）判过了。
   * 提交提问卡片（answers）也走 force：点选不是打字，同样不该再 @ 一次。
   */
  async function deliver({
    threadId,
    text,
    user,
    mentions = [],
    replyTo = null,
    force = false,
    answers = null,
    askSeq = null,
  }) {
    const saved = get(threadId)
    if (!exists(saved)) return { ok: false, notFound: true, error: '没有这个群' }
    // 老群在这里补一次成员表，否则群里的人自己发言会被路层的成员判断挡住
    ensureMembers(threadId, saved)
    if (members && !members.isMember(threadId, user.id)) {
      return { ok: false, forbidden: true, error: '你还没加入这个群' }
    }

    const initiator = {
      userId: user.id,
      nickname: user.nickname || user.username,
      at: Date.now(),
    }
    const picked = Array.isArray(answers) && answers.length ? answers : null
    const missed = mentionsOf({ mentions, text, botName })
    const route =
      force || picked
        ? { action: 'message', atBot: false, needsStart: false }
        : routeMessage({ mode: saved.mode ?? 'chat', mentions: missed })

    if (route.action === 'start') {
      // 权限判断放在落库和发事件之前：被拒的话群里不留痕，引擎也不会跑
      const perm = await can('startRequirement', threadId, user.id)
      if (!perm?.ok) {
        return {
          ok: false,
          forbidden: true,
          error: '提需求需要群主、群管理员或系统管理员权限',
          roleLabel: perm?.roleLabel ?? null,
        }
      }
    }

    // 点提问卡片提交 = 通过/打回/答决策，和原来的按钮是同一件事，
    // 权限口径也得一样：只有能确认的人才放行。
    if (picked) {
      const perm = await can('confirm', threadId, user.id)
      if (!perm?.ok) {
        return {
          ok: false,
          forbidden: true,
          error: '通过和打回只有群主、群管理员或系统管理员能操作',
          roleLabel: perm?.roleLabel ?? null,
        }
      }
    }

    // /release 会把工作目录、会话、并发槽一起放掉，文档写的是管理员专属。
    // 编排层自己不看身份（它按对话工作），所以这道闸必须留在 IM 这边。
    if (route.action !== 'chat' && /^\/release\b/i.test(stripBotMention(text, botName))) {
      const perm = await can('confirm', threadId, user.id)
      if (!perm?.ok) {
        return {
          ok: false,
          forbidden: true,
          error: '只有群主、群管理员或系统管理员能释放会话',
          roleLabel: perm?.roleLabel ?? null,
        }
      }
    }

    // 落库用户这条：App 刷新后要能看见自己说过什么。
    // 聊天、需求、通过/打回都先落库再分发——用户的输入不该因为引擎挂了而消失。
    messages.append(threadId, {
      role: 'user',
      kind: 'text',
      payload: {
        text,
        ...(missed.length ? { mentions: missed } : {}),
        // 从哪张提问卡片上点的（App 用它把卡片标成「已回答」，引擎用它对齐问题）
        ...(Number.isFinite(askSeq) ? { askSeq } : {}),
        ...(picked ? { answers: picked } : {}),
        // 群里可能有好几个人，App 靠 userId 判断气泡该靠左还是靠右
        userId: initiator.userId,
        nickname: initiator.nickname,
      },
      at: initiator.at,
    })

    if (route.action === 'chat') {
      // 普通聊天只记「最后说话的人」，不发事件：这条路径是 IM 独立
      // 部署的核心——没有引擎的时候，群照样能一直聊下去
      groups.save(threadId, { ...saved, initiator, lastActiveAt: initiator.at })
      return { ok: true, action: 'chat' }
    }

    groups.save(threadId, {
      ...saved,
      // 群一旦变成需求群就不再变回去：需求跑完还是可以继续聊、
      // 继续补需求，来回切换只会让「这句话发给谁」变得不可预测。
      // 但聊天群里的通过/打回不该顺手把它变成需求群，所以只在 start 时置位。
      mode: route.action === 'start' ? 'requirement' : (saved.mode ?? 'chat'),
      initiator,
      lastActiveAt: initiator.at,
    })

    log(`[api] ${user.username} → ${threadId}（${route.action}）：${text.slice(0, 60)}`)

    try {
      await dispatch({
        type: route.action,
        threadId,
        // @ 只是触发器，不该进需求名、也不该成为 agent 看到的第一句废话
        text: stripBotMention(text, botName),
        mentions: missed,
        ...(picked ? { answers: picked } : {}),
        // 哪张卡片被回答了：引擎侧靠它把「这句话是对哪次提问的答复」对上号
        ...(Number.isFinite(askSeq) ? { askSeq } : {}),
        user: { userId: initiator.userId, nickname: initiator.nickname },
        replyTo,
      })
    } catch (err) {
      log(`[api] 群 ${threadId} 投递失败：${err.message}`)
      return { ok: false, error: err.message }
    }

    return { ok: true, action: route.action, accepted: true }
  }

  /**
   * 记「我读到哪儿了」，用来消列表页的红点。
   *
   * 不校验 seq 是否真实存在：App 拿到的 lastSeq 就是它看到的最后一条，
   * 多报一点只是把红点提前消掉，少报才会让红点一直挂着。
   * 只进不退（存储层保证），所以并发刷新不会把已读位置冲回去。
   */
  async function markRead({ threadId, user, seq }) {
    if (!isAppThread(threadId)) return { ok: false, notFound: true }
    const saved = get(threadId)
    if (!exists(saved)) return { ok: false, notFound: true }
    ensureMembers(threadId, saved)
    if (!members.isMember(threadId, user.id)) {
      return { ok: false, forbidden: true, error: '你还没加入这个群' }
    }
    members.markRead(threadId, user.id, seq)
    return { ok: true, lastReadSeq: members.lastReadOf(threadId, user.id) }
  }

  return { listThreads, threadInfo, createGroup, deliver, joinGroup, renameGroup, membersOf, setMemberRole, markRead }
}
