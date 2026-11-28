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
    // 预设管理员在启动时就建好了，所以这里不再是「需要人注册」的状态。
    // 但首屏要能把初始账号告诉用户，否则新装机根本不知道用什么登。
    check('首屏给出了预设账号', st.body?.presetAdmin === 'admin', JSON.stringify(st.body))
    check('首屏给出了预设密码', st.body?.presetPassword === '123456', JSON.stringify(st.body))
  }

  console.log('\n== 账号 ==')
  {
    // bridge 启动时已经建了预设管理员 admin / 123456，
    // 所以「第一个注册的人」这个位置被占了，新注册的只会是普通成员。
    const st = await b.call('GET', '/api/auth/status')
    check('/api/auth/status 可用', st.body?.ok === true)
    check('预设管理员已被占用', st.body?.needsFirstAdmin === false)

    const admin = await b.asAdmin()
    check('预设管理员能登录', admin.user?.role === 'admin', admin.user?.role)
    check('登录给了 token', typeof admin.token === 'string' && admin.token.length > 100)
    check('昵称是「管理员」', admin.user?.nickname === '管理员', admin.user?.nickname)

    const me = await b.call('GET', '/api/auth/me')
    check('/api/auth/me 返回用户', me.body?.user?.username === 'admin')
    check('自己可以发起需求', me.body?.can?.startRequirement === true)
    check('自己可以通过打回', me.body?.can?.confirm === true)

    // 注册入口仍然要能注册，只是拿不到管理员
    const reg = await b.register('产品同学', 'pass1234', '产品同学')
    check('新注册的是普通成员', reg.user?.role === 'member', reg.user?.role)
    check('注册给了 token', typeof reg.token === 'string' && reg.token.length > 100)
    check('没有「成为管理员」的提示', !String(reg.notice ?? '').includes('系统管理员'), reg.notice)

    // 真实用起来就是这样：产品同学要自己提需求，得先让管理员提权。
    // 顺手把提权接口也覆盖掉。
    const memberId = reg.user.id
    await b.asAdmin()
    const up = await b.call('POST', `/api/users/${memberId}/role`, { role: 'admin' })
    check('管理员能给别人提权', up.status === 200 && up.body?.ok === true, JSON.stringify(up.body))
    await b.login('产品同学', 'pass1234')
    const meAgain = await b.call('GET', '/api/auth/me')
    check('提权后旧 token 立刻生效', meAgain.body?.can?.startRequirement === true, JSON.stringify(meAgain.body?.can))
  }

  console.log('\n== 建群、在群里提需求、驱动回合 ==')
  {
    const created = await b.createThread('首页加个欢迎弹窗', { name: '欢迎弹窗' })
    const threadId = created.threadId
    check('接口回了 thread 形状', Boolean(created.thread), JSON.stringify(created.thread)?.slice(0, 120))
    check('群名是用户起的', created.thread?.groupName === '欢迎弹窗', created.thread?.groupName)
    // 建群接口本身不带需求：刚建好的群没有任何阶段，需求要等群里第一句话
    check('刚建好的群标着待提需求', created.thread?.pending === true, JSON.stringify(created.thread)?.slice(0, 160))
    check('发起人被记下了', created.thread?.initiator?.nickname === '产品同学', JSON.stringify(created.thread?.initiator))

    const detail = await b.call('GET', `/api/threads/${threadId}`)
    check('详情立刻可见（不是 404）', detail.status === 200, String(detail.status))
    // 第一句话发出去之后 flow 才被建出来，阶段格子是异步出现的
    const staged = await b.waitFor(async () => {
      const d = await b.call('GET', `/api/threads/${threadId}`)
      return (d.body?.thread?.stages ?? []).length === 10
    }, 30_000)
    check('详情带十个阶段格子', staged, '')

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
    // 需求原文只由发起卡片承载：群里第一屏就是那张卡片，不再先垫一条用户气泡
    check('第一条是发起卡片', first.messages?.[0]?.kind === 'requirement', JSON.stringify(first.messages?.[0]))
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
