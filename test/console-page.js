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
  globalThis.location = { pathname: '/console' }
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

console.log('\n== 页面内部调用的函数都有定义 ==')
{
  // 删代码时把 loadBoard 的定义删了，但三处调用还在——模板检查抓不到，
  // 因为它不在模板里，结果整个页面白屏。
  const scriptStart = html.lastIndexOf('<script>')
  const script = html.slice(scriptStart)
  const defined = new Set()
  for (const m of script.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1])
  for (const m of script.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1])
  for (const m of script.matchAll(/^\s{4}([A-Za-z_$][\w$]*)\s*,?\s*$/gm)) defined.add(m[1])

  // 关键字、语言内置、Vue/浏览器全局都不算「未定义」
  const SKIP = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await', 'new',
    'async', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date', 'Promise',
    'Set', 'Map', 'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent',
    'setTimeout', 'setInterval', 'clearInterval', 'clearTimeout', 'fetch', 'confirm', 'alert',
    // Vue 与浏览器全局
    'createApp', 'setup', 'ref', 'reactive', 'computed', 'watch', 'watchEffect',
    'onMounted', 'onUnmounted', 'nextTick', 'requestAnimationFrame', 'cancelAnimationFrame',
    'document', 'window', 'console', 'localStorage', 'URLSearchParams', 'Blob', 'URL',
  ])
  const called = new Set()
  for (const m of script.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!SKIP.has(m[2])) called.add(m[2])
  }
  const undef = [...called].filter((n) => !defined.has(n))
  check('内部调用的函数都已定义', undef.length === 0, undef.join(' '))
}

console.log('\n== 直接访问非大盘视图（/console/xxx）会加载数据 ==')
{
  // 用 hash=#emulators 进入时，watch(view) 不会触发（view 没有「变化」），
  // onMounted 必须自己按当前视图拉一次数据，否则页面永远是空的。
  const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  const code = blocks.reduce((a, b) => (b.length > a.length ? b : a), '')

  const mounted = []
  const fetched = []
  const noop = () => {}
  let localCtx = null

  globalThis.Vue = {
    createApp: (o) => ({ mount() { localCtx = o.setup ? o.setup() : {} } }),
    ref: (v) => ({ value: v }),
    computed: (fn) => ({ get value() { try { return fn() } catch { return undefined } } }),
    watch: noop,
    onMounted: (fn) => mounted.push(fn),
    onUnmounted: noop, reactive: (v) => v, watchEffect: noop, nextTick: async () => {},
  }
  globalThis.location = { pathname: '/console/emulators' }
  globalThis.history = { replaceState: noop }
  globalThis.fetch = async (url) => {
    fetched.push(String(url))
    return { json: async () => ({ ok: true, label: '鸿蒙', items: [], platform: 'harmony' }) }
  }

  try {
    new Function(code)()
    for (const fn of mounted) fn()
  } catch (e) {
    check('执行挂载没有抛错', false, e.message)
  }
  check('以 /console/emulators 进入时请求了模拟器接口', fetched.some((u) => u.includes('/api/emulators')), fetched.join(', '))
  check('ctx 拿到了', !!localCtx)
}

console.log('\n== 路径路由映射 ==')
{
  const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  const code = blocks.reduce((a, b) => (b.length > a.length ? b : a), '')
  const noop = () => {}

  async function viewFor(pathname) {
    let ctx = null
    globalThis.Vue = {
      createApp: (o) => ({ mount() { ctx = o.setup ? o.setup() : {} } }),
      ref: (v) => ({ value: v }),
      computed: (fn) => ({ get value() { try { return fn() } catch { return undefined } } }),
      watch: noop, onMounted: noop, onUnmounted: noop, reactive: (v) => v, watchEffect: noop, nextTick: async () => {},
    }
    globalThis.location = { pathname }
    globalThis.history = { pushState: noop, replaceState: noop }
    globalThis.fetch = async () => ({ json: async () => ({ ok: true, items: [] }) })
    globalThis.window = { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }) }
    globalThis.document = { addEventListener: noop, querySelector: () => null }
    new Function(code)()
    return ctx?.view?.value
  }

  check('/console → 大盘', (await viewFor('/console')) === 'board')
  check('/console/ 也 → 大盘', (await viewFor('/console/')) === 'board')
  check('/console/emulators → 模拟器', (await viewFor('/console/emulators')) === 'emulators')
  check('/console/settings → 设置', (await viewFor('/console/settings')) === 'settings')
  check('/console/projects → 项目', (await viewFor('/console/projects')) === 'projects')
  check('未知路径退回大盘', (await viewFor('/console/nonsense')) === 'board')
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
