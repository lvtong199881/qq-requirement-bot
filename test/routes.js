/**
 * 消息路由模板：渲染、校验、自定义覆盖。
 *   node test/routes.js
 */
import { ROUTES, ROUTE_VARS, renderRoute, validateRouteTemplate, validateAllRoutes } from '../src/routes.js'
import { routedPrompt, INTENT } from '../src/router.js'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

const vals = {
  target: '需求 demo',
  stage: '设计',
  userText: '用户原话',
  rejectReason: '主按钮改成蓝色',
  waitingLabel: '等你确认配色',
}

console.log('\n== 五条路由都在 ==')
{
  check('approve', !!ROUTES.approve)
  check('reject', !!ROUTES.reject)
  check('continue', !!ROUTES.continue)
  check('new_req', !!ROUTES.new_req)
  check('content', !!ROUTES.content)
  check('每条都有 label/desc/template', Object.values(ROUTES).every((r) => r.label && r.desc && r.template))
}

console.log('\n== 渲染：变量替换 ==')
{
  const t = renderRoute('approve', vals)
  check('替换 target', t.includes('需求 demo'))
  check('替换 stage', t.includes('「设计」'))
  check('不留占位符', !/\{\{\w+\}\}/.test(t))

  const r = renderRoute('reject', vals)
  check('打回带修改意见', r.includes('主按钮改成蓝色'))
  check('打回含「修改意见如下」', r.includes('修改意见如下'))

  const c = renderRoute('content', vals)
  check('内容路由带等待事项', c.includes('等你确认配色'))
  check('内容路由带用户原话', c.includes('用户原话'))
}

console.log('\n== 自定义覆盖 ==')
{
  const custom = { continue: '自定义继续 {{target}}' }
  check('用自定义模板', renderRoute('continue', vals, custom) === '自定义继续 需求 demo')
  check('其他路由不受影响', renderRoute('approve', vals, custom).includes('执行准出流转'))
}

console.log('\n== 校验 ==')
{
  const bad = (name, key, input, kw) => {
    const r = validateRouteTemplate(key, input)
    check(name, !r.ok && (!kw || r.error.includes(kw)), r.ok ? '竟然通过' : r.error)
  }
  const good = (name, key, input) => {
    const r = validateRouteTemplate(key, input)
    check(name, r.ok, r.error)
  }

  bad('空模板', 'continue', '')
  bad('纯空白', 'continue', '   ')
  bad('null', 'continue', null)
  bad('未知占位符', 'continue', '{{bogus}}', 'bogus')
  bad('未知路由', 'nope', '任意内容', '未知路由')
  bad('过长', 'continue', 'x'.repeat(4001), '太长')

  good('最小合法', 'continue', '继续推进')
  good('用已知占位符', 'continue', '继续推进{{target}}')
  good('默认模板本身', 'continue', ROUTES.continue.template)
}

console.log('\n== 批量校验 ==')
{
  check('全部合法', validateAllRoutes({ continue: 'a', approve: 'b' }).ok)
  const bad = validateAllRoutes({ continue: 'a', reject: '{{bad}}' })
  check('一条非法就整体拒绝', !bad.ok && bad.error.includes('打回'), bad.error)
  check('非对象拒绝', !validateAllRoutes('nope').ok)
}

console.log('\n== routedPrompt 接入 ==')
{
  const base = { userText: '原文', bind: { reqId: 'demo', stage: '设计', waitingLabel: '', rejectReason: '' } }

  check('approve 走模板', routedPrompt({ ...base, intent: INTENT.APPROVE }).includes('用户批准了需求 demo'))
  check('continue 走模板', routedPrompt({ ...base, intent: INTENT.CONTINUE }).includes('继续推进需求 demo'))
  check('new_req 带原话', routedPrompt({ ...base, intent: INTENT.NEW_REQ }).includes('原文'))

  // 没有等待事项时，普通内容原样透传（不套模板）
  check('content 无等待时透传', routedPrompt({ ...base, intent: INTENT.CONTENT }) === '原文')

  // 有等待事项才套 content 模板
  const withWait = {
    userText: '选 A',
    bind: { reqId: 'demo', stage: '设计', waitingLabel: '等你选 A/B', rejectReason: '' },
    intent: INTENT.CONTENT,
  }
  const out = routedPrompt(withWait)
  check('content 有等待时套模板', out.includes('等你选 A/B') && out.includes('选 A'))

  // 自定义覆盖生效
  const customOut = routedPrompt({
    ...base,
    intent: INTENT.CONTINUE,
    routes: { continue: '【改过的】{{target}}' },
  })
  check('自定义模板生效', customOut === '【改过的】需求 demo', customOut)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
