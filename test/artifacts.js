/**
 * 群投递白名单单测：每阶段只回传一份产物。
 * 依据 requirement-spec「bot 调用模式」一节，以及 artifacts.js 的 DELIVERABLES/收尾判定。
 *   node test/artifacts.js
 */
import { isDeliverable, wrapupWritten, diffSnapshot, snapshot, relWithinReq } from '../src/artifacts.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0
let fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

const root = mkdtempSync(join(tmpdir(), 'artifacts-'))
const reqDir = join(root, 'docs/requirements/demo')
mkdirSync(join(reqDir, 'design-images'), { recursive: true })
mkdirSync(join(reqDir, 'figma-import'), { recursive: true })
const p = (name) => join(reqDir, name)
const write = (name, body = 'x') => writeFileSync(p(name), body)

const opts = { patterns: [], maxFiles: 8, maxFileMB: 20, accept: (f) => isDeliverable(f) }

console.log('\n== 相对路径解析 ==')
check('需求目录内取出相对路径', relWithinReq(p('PRD.md')) === 'PRD.md')
check('子目录保留层级', relWithinReq(p('design-images/a.png')) === 'design-images/a.png')
check('需求目录外返回 null', relWithinReq(join(root, 'src/index.js')) === null)

console.log('\n== 白名单：每阶段那唯一一份 ==')
const keep = ['待提问清单.md', 'PRD.md', '技术方案.md', '代码评审报告.md', '测试报告.md', '验收文档.md']
for (const name of keep) check(`${name} 投递`, isDeliverable(p(name)))

const drop = ['需求卡片.md', '设计说明.md', '复盘记录.md', 'design-spec.json', 'figma-import/design-spec.json']
for (const name of drop) check(`${name} 不投递`, !isDeliverable(p(name)), '不该出现在群里')

console.log('\n== 设计阶段：截图与 zip ==')
check('design-images 里的 png 投递', isDeliverable(p('design-images/home.png')))
check('需求目录里的 zip 投递', isDeliverable(p('figma-import-demo.zip')))
check('figma-import/ 里的 zip 投递', isDeliverable(p('figma-import/src.zip')))
check('其它 png 不投递', !isDeliverable(p('screenshots/home.png')))

console.log('\n== 编排记录：过程更新不发，收尾才发 ==')
{
  write('编排记录.md', ['# 编排记录：demo', '', '## 阶段进度', '| 1 产品需求 | 进行中 |', '', '## 收尾结论', '<!-- 阶段 9 写 -->', ''].join('\n'))
  check('未写收尾结论时不投递', !isDeliverable(p('编排记录.md')))
  check('wrapupWritten 为 false', !wrapupWritten(p('编排记录.md')))

  write('编排记录.md', ['# 编排记录：demo', '', '## 收尾结论', '', '- 判定：通过', '- 结论：需求完成', ''].join('\n'))
  check('写了收尾结论后投递', isDeliverable(p('编排记录.md')))
  check('wrapupWritten 为 true', wrapupWritten(p('编排记录.md')))
}

console.log('\n== diffSnapshot：先过滤再截断 ==')
{
  const empty = new Map()
  write('需求卡片.md', 'card')
  write('PRD.md', 'prd-body')
  write('figma-import-demo.zip', 'zip')
  const after = snapshot(root, 'demo')

  const got = diffSnapshot(empty, after, opts).map((f) => f.path.split('/').pop())
  check('需求卡片被过滤', !got.includes('需求卡片.md'), got.join(','))
  check('PRD 被保留', got.includes('PRD.md'), got.join(','))
  check('zip 被保留', got.includes('figma-import-demo.zip'), got.join(','))

  const narrow = diffSnapshot(empty, after, { ...opts, maxFiles: 1 })
  check('maxFiles=1 时留下的是白名单产物', narrow.length === 1 && narrow[0].path.endsWith('PRD.md') || narrow[0].path.endsWith('.zip'), JSON.stringify(narrow.map((f) => f.path)))
}

console.log('\n== 不传 accept 时行为不变（兼容旧调用） ==')
{
  const empty = new Map()
  const all = diffSnapshot(empty, snapshot(root, 'demo'), { patterns: [], maxFiles: 8, maxFileMB: 20 })
  check('无 accept 时不过滤', all.some((f) => f.path.endsWith('需求卡片.md')))
}

rmSync(root, { recursive: true, force: true })

console.log(`\n通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
