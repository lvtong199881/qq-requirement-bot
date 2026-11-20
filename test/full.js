/**
 * 全链路测试：真的把 src/index.js 当进程跑起来，从 App API 提一个需求，
 * 看它是否 spawn dsh、是否把回合结果落成 App 能看见的消息。
 *
 * 历史上这个测试靠 mock OneBot 注入群消息、从假群里收回复。QQ 通道删掉后
 * 改成走 App HTTP API——顺带把「用户点了 App 里那个按钮」这条真实路径也覆盖了。
 *
 *   node test/full.js          跑真 dsh（消耗 token）
 *   node test/full.js --no-llm 不跑真 dsh，只验证进程、路由、账号、消息落库
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from './helpers/bridge.js'

const noLlm = process.argv.includes('--no-llm')

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${!cond && extra ? ' — ' + extra : ''}`)
  cond ? pass++ : fail++
}

// --no-llm 用一个不存在的 dsh 路径：真需求会在 spawn 阶段就失败，
// 但进程必须活着、必须把失败播报出来。这比"什么都不发生"更能验证错误路径。
const work = mkdtempSync(join(tmpdir(), 'qqrs-dsh-'))
const missingDsh = join(work, 'definitely-not-a-real-dsh')

const b = await boot({
  name: 'full',
  turnTimeoutMs: 60_000,
  config: noLlm ? { dshBin: missingDsh } : {},
})

try {
  console.log('\n== 启动与健康检查 ==')
  {
    check('进程存活', b.child.exitCode === null)
    const hz = await b.call('GET', '/healthz')
    check('/healthz 返回 200', hz.status === 200 && hz.body?.ok === true, JSON.stringify(hz.body))
    const st = await b.call('GET', '/api/auth/status')
    check('全新实例需要第一个管理员', st.body?.needsFirstAdmin === true, JSON.stringify(st.body))
  }

  console.log('\n== 账号 ==')
  {
    const reg = await b.register('全链路管理员', 'pass1234', '产品同学')
    check('第一个注册的是管理员', reg.user?.role === 'admin', reg.user?.role)
    check('注册给了 token', typeof reg.token === 'string' && reg.token.length > 100)
    check('注册给了提示', typeof reg.notice === 'string' && reg.notice.includes('系统管理员'), reg.notice)

    const me = await b.call('GET', '/api/auth/me')
    check('/api/auth/me 返回用户', me.body?.user?.username === '全链路管理员')
    check('自己可以发起需求', me.body?.can?.startRequirement === true)
    check('自己可以通过打回', me.body?.can?.confirm === true)
  }

  console.log('\n== 建需求、驱动回合 ==')
  {
    const created = await b.createThread('首页加个欢迎弹窗')
    const threadId = created.threadId
    check('接口回了 thread 形状', Boolean(created.thread), JSON.stringify(created.thread)?.slice(0, 120))
    check('初始阶段是需求澄清', created.thread?.stage === '需求澄清', created.thread?.stage)
    check('初始阶段状态是进行中', created.thread?.stageStatus === '进行中', created.thread?.stageStatus)
    check('发起人被记下了', created.thread?.initiator?.nickname === '产品同学', JSON.stringify(created.thread?.initiator))

    const detail = await b.call('GET', `/api/threads/${threadId}`)
    check('详情立刻可见（不是 404）', detail.status === 200, String(detail.status))
    check('详情带十个阶段格子', (detail.body?.thread?.stages ?? []).length === 10, String((detail.body?.thread?.stages ?? []).length))

    const list = await b.call('GET', '/api/threads')
    const ids = (list.body?.threads ?? []).map((t) => t.threadId)
    check('列表里有这个需求', ids.includes(threadId), JSON.stringify(ids))
    check('列表里没有纯数字的旧群号', !ids.some((id) => /^\d+$/.test(id)), JSON.stringify(ids))

    // 需求开跑，落第一条播报（"收到，开始处理"）
    check(
      '有 bot 播报落库',
      await b.waitFor(async () => {
        const page = await b.messages(threadId)
        return (page?.messages ?? []).some((m) => m.role === 'bot')
      }, 30_000),
      JSON.stringify(await b.texts(threadId)),
    )

    const first = await b.messages(threadId)
    check('第一条是用户说的话', first.messages?.[0]?.role === 'user', JSON.stringify(first.messages?.[0]))
    check('第一条内容是需求原话', String(first.messages?.[0]?.payload?.text).includes('欢迎弹窗'))
    check('seq 从 1 起连续', first.messages.every((m, i) => m.seq === i + 1))

    const lastSeq = first.lastSeq
    const empty = await b.call('GET', `/api/threads/${threadId}/messages?since=${lastSeq}`)
    check('since 拉增量是空的', (empty.body?.messages ?? []).length === 0, String((empty.body?.messages ?? []).length))
  }

  if (noLlm) {
    console.log('\n== dsh 起不来时：进程活着，并把失败播报出来 ==')
    {
      const threadId = (await b.call('GET', '/api/threads')).body.threads[0].threadId
      // 缺失的 dsh 会在 spawn 时 ENOENT，编排层应当把原因说给用户听，
      // 而不是默默卡住——"界面上没反应"是这套系统最难查的故障
      check(
        '失败原因进了消息流',
        await b.waitFor(async () => {
          const texts = await b.texts(threadId)
          return texts.some((t) => /异常|失败|卡住|打不开|ENOENT|找不到/.test(t))
        }, 40_000),
        JSON.stringify(await b.texts(threadId)),
      )
      check('进程没有被一次回合失败带走', b.child.exitCode === null)
    }
  } else {
    console.log('\n== 真 dsh 跑完一整轮 ==')
    {
      const threadId = (await b.call('GET', '/api/threads')).body.threads[0].threadId
      // 真 dsh 要几十秒到几分钟。等到阶段推进（stage 变了）或出现决策播报
      const advanced = await b.waitFor(async () => {
        const d = await b.call('GET', `/api/threads/${threadId}`)
        const t = d.body?.thread
        return Boolean(t) && (t.stage !== '需求澄清' || t.needsMe === true || t.stageStatus === '卡住')
      }, 300_000)
      const d = await b.call('GET', `/api/threads/${threadId}`)
      console.log(`    当前：阶段=${d.body?.thread?.stage} 状态=${d.body?.thread?.stageStatus} 轮次=${d.body?.thread?.turn}`)
      check('回合推进了状态（不是原地不动）', advanced, JSON.stringify(d.body?.thread)?.slice(0, 200))

      const texts = await b.texts(threadId)
      console.log('    App 收到的消息：')
      texts.forEach((t, i) => console.log(`      [${i}] ${String(t).slice(0, 100).replace(/\n/g, ' ⏎ ')}`))
      check('有真实的 bot 输出', texts.some((t) => t && t.length > 20), '消息太少')
      check('没有残留闸门标记', !texts.some((t) => String(t).includes('[[')), '标记漏出来了')
    }
  }
} finally {
  if (fail > 0) {
    console.log('\n--- bridge 日志尾部 ---')
    console.log(b.logs().split('\n').slice(-40).join('\n'))
  }
  await b.stop()
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
