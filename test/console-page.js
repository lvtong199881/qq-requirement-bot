/**
 * 面板页面的冒烟检查。
 *
 * 前端没有构建步骤，改了 HTML 直接生效——好处是快，坏处是「少定义一个函数」
 * 这种错误只有打开浏览器才发现。这个脚本用假的 Vue API 把 setup() 跑一遍，
 * 能在命令行抓到「xxx is not defined」这类运行时错误。
 *   node test/console-page.js
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync(join(root, 'static/console.html'), 'utf8')

let pass = 0, fail = 0
let setupCtx = null // setup() 的返回值，跨检查块复用
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

console.log('\n== 结构完整性 ==')
{
  check('有 style 块', (html.match(/<style>/g) ?? []).length === 1)
  check('style 标签闭合', (html.match(/<\/style>/g) ?? []).length === 1)
  check('script 标签成对', (html.match(/<script/g) ?? []).length === (html.match(/<\/script>/g) ?? []).length)
  check('有挂载点 #app', html.includes('<div id="app"'))
  check('引入了 vue.js', html.includes('src="/vue.js"'))
}

console.log('\n== setup() 能跑通 ==')
{
  const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  const code = blocks.reduce((a, b) => (b.length > a.length ? b : a), '')

  const noop = () => {}
  let setupError = null
  globalThis.Vue = {
    createApp: (o) => ({
      mount() {
        try {
          setupCtx = o.setup ? o.setup() : {}
        } catch (e) {
          setupError = e
        }
      },
    }),
    ref: (v) => ({ value: v }),
    computed: (fn) => ({
      get value() {
        try {
          return fn()
        } catch {
          return undefined
        }
      },
    }),
    watch: noop,
    onMounted: noop,
    onUnmounted: noop,
    reactive: (v) => v,
    watchEffect: noop,
    nextTick: async () => {},
  }
  globalThis.location = { hash: '#board' }
  globalThis.history = { replaceState: noop }
  globalThis.fetch = async () => ({ json: async () => ({}) })
  globalThis.window = { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }) }
  globalThis.document = { addEventListener: noop, querySelector: () => null }

  try {
    new Function(code)()
  } catch (e) {
    setupError = e
  }

  check('setup 没有抛错', !setupError, setupError && `${setupError.name}: ${setupError.message}`)
  check('拿到了 setup 返回值', !!setupCtx)
}

console.log('\n== 模板引用的函数都有定义 ==')
{
  // 只查「调用形式」的函数名：在 @click / @change 里被调用的那种
  const tpl = html.split('<script src="/vue.js">')[0]
  const called = new Set()
  for (const m of tpl.matchAll(/@[a-z]+="([^"]+)"/g)) {
    for (const fn of m[1].matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)) called.add(fn[1])
  }
  const missing = [...called].filter((f) => setupCtx && !(f in setupCtx))
  check('事件处理函数都已导出', missing.length === 0, missing.join(', '))
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
