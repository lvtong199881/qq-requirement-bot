/**
 * 后端模块的静态冒烟检查。
 *
 * 为什么需要它：真实流程里三次崩在「函数没导入」这类错误上
 * （findLatestHap、renameSync、readReceipt），每次都要跑到那一步才暴露。
 * 前端有 test/console-page.js 兜着，后端一直是裸奔的。
 *
 * 做法：把每个源文件当成一个作用域，收集「定义的」（函数声明、const/let、
 * 导入的、以及已知全局）和「被调用的」（`name(` 形式），差额就是可疑调用。
 * 这是正则级检查，不追求 100% 准确——宁可漏报也不误报太多。
 *
 *   node test/static-check.js
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

/** 递归收集 js 文件，跳过测试和第三方 */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name.startsWith('.')) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) collect(full, out)
    else if (extname(name) === '.js') out.push(full)
  }
  return out
}

/** 语言内置与运行时全局，不算未定义 */
const BUILTIN = new Set([
  'console', 'process', 'Buffer', 'globalThis', 'global', 'require', 'module', 'exports',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask',
  'fetch', 'URL', 'URLSearchParams', 'AbortController', 'TextEncoder', 'TextDecoder',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Proxy', 'Reflect',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Math', 'JSON', 'RegExp', 'Error',
  'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AbortError',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'structuredClone', 'atob', 'btoa',
  'WebSocket', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'File',
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'new',
  'super', 'this', 'async', 'yield', 'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'finally',
])

console.log('\n== 收集源文件 ==')
const files = collect(join(root, 'src'))
check(`找到 ${files.length} 个源文件`, files.length > 0)

// 全局定义池：类方法、对象键、解构出来的名字在别的文件里也算「定义过」。
// 不这么做的话 this.foo() / { foo } / class 方法全会被误报成未定义。
const GLOBAL_DEFINED = new Set()
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  // 方法定义：name(...) {  —— 含 async / get / set / static
  for (const m of src.matchAll(/(?:^|[\s{,])(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
    GLOBAL_DEFINED.add(m[1])
  }
  // 对象键：name: value
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) GLOBAL_DEFINED.add(m[1])
}

console.log('\n== 跨文件调用必须先 import ==')
{
  // 收集全项目导出的名字
  const exported = new Set()
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) exported.add(m[1])
    for (const m of src.matchAll(/export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) exported.add(m[1])
    for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim()
        if (name) exported.add(name)
      }
    }
  }
  check(`全项目导出 ${exported.size} 个名字`, exported.size > 0)

  const problems = []
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    const rel = file.slice(root.length + 1)

    // 本文件「拥有的」名字：定义、导入、参数、解构
    const owned = new Set()
    for (const m of src.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) owned.add(m[1])
    for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) owned.add(m[1])
    for (const m of src.matchAll(/\bimport\s*\{([^}]+)\}\s*from/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim()
        if (name) owned.add(name)
      }
    }
    for (const m of src.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s+from/g)) owned.add(m[1])
    for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(':').pop().trim().replace(/=.*$/, '').trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) owned.add(name)
      }
    }
    for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().replace(/=.*$/, '').replace(/^\.\.\./, '').trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) owned.add(name)
      }
    }

    // 本文件调用、且是别处导出的名字 —— 必须在本文件的 import/定义里
    const missing = new Set()
    for (const m of src.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[2]
      if (exported.has(name) && !owned.has(name)) missing.add(name)
    }
    if (missing.size) problems.push({ file: rel, names: [...missing].sort() })
  }

  if (problems.length === 0) {
    check('没有「用了但没 import」的跨文件函数', true)
  } else {
    for (const p of problems) console.log(`  ❌ ${p.file}: ${p.names.join(', ')}`)
    check('没有「用了但没 import」的跨文件函数', false, `${problems.length} 个文件`)
  }
}

console.log('\n== 关键模块能被导入 ==')
{
  const mods = [
    'src/flow-bridge.js',
    'src/flow/flow.js',
    'src/flow/orchestrator.js',
    'src/flow/flow-runner.js',
    'src/flow/board.js',
    'src/infra/repo.js',
    'src/infra/lock.js',
    'src/infra/git.js',
    'src/infra/device.js',
    'src/infra/emulator.js',
    'src/infra/emulator-client.js',
    'src/emulator-service.js',
    'src/ui/panel.js',
    'src/ui/messages.js',
    'src/ui/format.js',
    'src/config.js',
  ]
  let bad = 0
  for (const rel of mods) {
    try {
      await import(join(root, rel))
    } catch (err) {
      bad++
      console.log(`  ❌ ${rel}: ${err.message}`)
    }
  }
  check(`${mods.length} 个模块全部导入成功`, bad === 0, `${bad} 个失败`)
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
