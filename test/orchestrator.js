/**
 * 编排执行器单测：任务包组装、回执校验、产物核对。
 *
 * 这三件事决定「agent 到底收到了什么」和「bridge 相不相信它说的」，
 * 是重构后最容易悄悄坏掉的地方（坏了不会报错，只会让群里的消息变得不对）。
 *   node test/orchestrator.js
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  RECEIPT_FILE,
  ROLE_LABEL,
  readSkill,
  resolveInputs,
  buildPrompt,
  readReceipt,
  validateReceipt,
  verifyOutputs,
  clearReceipt,
} from '../src/orchestrator.js'
import { getCheckpoint } from '../src/flow.js'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

const root = mkdtempSync(join(tmpdir(), 'orch-'))
const skillsDir = join(root, 'skills')
const reqDir = join(root, 'docs/requirements/demo')
mkdirSync(join(skillsDir, 'req'), { recursive: true })
mkdirSync(reqDir, { recursive: true })

const writeSkill = (role, text) => {
  mkdirSync(join(skillsDir, role), { recursive: true })
  writeFileSync(join(skillsDir, role, 'SKILL.md'), text)
}

console.log('\n== readSkill ==')
{
  writeSkill('req', '# 需求 agent\n\n你是需求侧产品经理。')
  const ok = readSkill(skillsDir, 'req')
  check('读到角色卡', ok.ok && ok.text.includes('需求侧产品经理'))
  check('不存在的角色报错', !readSkill(skillsDir, 'nope').ok)
  check('报错里带路径', /nope/.test(readSkill(skillsDir, 'nope').reason))

  writeSkill('empty', '   ')
  check('空角色卡报错', !readSkill(skillsDir, 'empty').ok)
}

console.log('\n== resolveInputs ==')
{
  const out = resolveInputs(['<userRequest>', 'AGENTS.md', '<screenshots>'], {
    userRequest: '首页加个欢迎弹窗',
    screenshots: 'docs/ui-screenshots/',
  })
  check('替换占位符', out[0] === '首页加个欢迎弹窗', out[0])
  check('固定项原样保留', out[1] === 'AGENTS.md')
  check('有值的都替换', out[2] === 'docs/ui-screenshots/')
}

console.log('\n== resolveInputs：没提供的原样留着 ==')
{
  const out = resolveInputs(['<debugPackage>'], {})
  check('未提供时保留占位符', out[0] === '<debugPackage>', out[0])
}

console.log('\n== buildPrompt ==')
{
  const cp = getCheckpoint('design')
  const prompt = buildPrompt({
    checkpoint: cp,
    state: { reqId: 'demo' },
    skillText: '# 设计 agent\n\n你是 UI 设计师。',
    vars: { screenshots: 'docs/ui-screenshots/' },
  })
  check('头部有角色和需求标识', prompt.startsWith('设计 agent｜demo'), prompt.slice(0, 30))
  check('写明本回合只做这一步', /【本回合只做这一步】设计（design）/.test(prompt))
  check('注入角色卡全文', prompt.includes('你是 UI 设计师'))
  check('输入清单带真实路径', prompt.includes('- docs/ui-screenshots/'))
  check('未解析的占位符会露出来', !prompt.includes('<screenshots>'), '占位符没替换')
  check('有硬约束段', /【硬约束】/.test(prompt))
  check('有回执要求', prompt.includes('_receipt-design.json'), prompt.slice(0, 200))
  check('回执在最后', prompt.trimEnd().endsWith('status 判定：做完 = done；只做了一部分 = partial；做不下去 = blocked；需要用户先回答 = needs_input。'))
  check('角色称呼取自映射', ROLE_LABEL.design === '设计 agent')
}

console.log('\n== buildPrompt：开发阶段不写死输入路径 ==')
{
  const cp = getCheckpoint('dev')
  const prompt = buildPrompt({
    checkpoint: cp,
    state: { reqId: 'demo' },
    skillText: '# 开发 agent',
    vars: { projectTree: 'entry/、tools/' },
  })
  check('项目结构替换成功', prompt.includes('entry/、tools/'))
  check('上游文档按名字列出', prompt.includes('- 技术方案.md'))
}

console.log('\n== validateReceipt ==')
{
  check('合法回执通过', validateReceipt({ status: 'done', artifacts: [{ path: 'a.md' }] }) === null)
  check('status 非法被拒', /status/.test(validateReceipt({ status: 'finished' }) ?? ''))
  check('缺 status 被拒', /status/.test(validateReceipt({}) ?? ''))
  check('artifacts 不是数组被拒', /artifacts/.test(validateReceipt({ status: 'done', artifacts: {} }) ?? ''))
  check('artifact 缺 path 被拒', /path/.test(validateReceipt({ status: 'done', artifacts: [{}] }) ?? ''))
  check('decisions 缺 q 被拒', /q/.test(validateReceipt({ status: 'done', decisions: [{}] }) ?? ''))
  check('blockers 不是数组被拒', /blockers/.test(validateReceipt({ status: 'done', blockers: 'x' }) ?? ''))
  check('最外层不是对象被拒', validateReceipt([]) !== null)
}

console.log('\n== readReceipt ==')
{
  check('没有回执时报错', !readReceipt(reqDir).ok)

  writeFileSync(join(reqDir, RECEIPT_FILE), '{ 坏掉的 json')
  check('JSON 坏掉时报错', /解析失败/.test(readReceipt(reqDir).reason))

  writeFileSync(join(reqDir, RECEIPT_FILE), JSON.stringify({ status: 'done', summary: 'ok' }))
  const ok = readReceipt(reqDir)
  check('正常回执读出来', ok.ok && ok.receipt.status === 'done')

  writeFileSync(join(reqDir, RECEIPT_FILE), JSON.stringify({ status: 'whatever' }))
  check('结构非法时报错', !readReceipt(reqDir).ok)
}

console.log('\n== clearReceipt ==')
{
  writeFileSync(join(reqDir, RECEIPT_FILE), '{}')
  clearReceipt(reqDir)
  check('回执被删掉', !existsSync(join(reqDir, RECEIPT_FILE)))
  clearReceipt(reqDir) // 再删一次不能抛错
  check('重复删除不抛错', true)
}

console.log('\n== verifyOutputs：文件模式 ==')
{
  const cp = getCheckpoint('req-prd') // output = 需求卡片.md、PRD.md
  rmSync(join(reqDir, '需求卡片.md'), { force: true })
  rmSync(join(reqDir, 'PRD.md'), { force: true })

  let r = verifyOutputs({ checkpoint: cp, reqDir })
  check('两个都缺时报两个', r.missing.length === 2, r.missing.join())

  writeFileSync(join(reqDir, '需求卡片.md'), '内容')
  writeFileSync(join(reqDir, 'PRD.md'), '')
  r = verifyOutputs({ checkpoint: cp, reqDir })
  check('空文件也算缺', r.missing.includes('PRD.md') && !r.missing.includes('需求卡片.md'))

  writeFileSync(join(reqDir, 'PRD.md'), '内容')
  r = verifyOutputs({ checkpoint: cp, reqDir })
  check('都齐了通过', r.ok, r.reason)
}

console.log('\n== verifyOutputs：目录模式 ==')
{
  const cp = getCheckpoint('design') // output 含 figma-import/
  for (const f of ['设计说明.md']) writeFileSync(join(reqDir, f), '内容')
  mkdirSync(join(reqDir, 'design-images'), { recursive: true })
  writeFileSync(join(reqDir, 'design-images/a.png'), 'x')

  let r = verifyOutputs({ checkpoint: cp, reqDir })
  check('空目录算缺', r.missing.includes('figma-import/'), r.missing.join())

  mkdirSync(join(reqDir, 'figma-import'), { recursive: true })
  r = verifyOutputs({ checkpoint: cp, reqDir })
  check('空目录仍然算缺（要看里面有没有文件）', !r.ok && r.missing.includes('figma-import/'))

  writeFileSync(join(reqDir, 'figma-import/design-spec.json'), '{}')
  r = verifyOutputs({ checkpoint: cp, reqDir })
  check('目录里有文件就通过', r.ok, r.reason)
}

console.log('\n== verifyOutputs：gitDiff 模式 ==')
{
  const cp = getCheckpoint('dev')
  check('没有 diff 判失败', !verifyOutputs({ checkpoint: cp, reqDir, gitDiff: '' }).ok)
  check('空白 diff 判失败', !verifyOutputs({ checkpoint: cp, reqDir, gitDiff: '  \n ' }).ok)
  check('有 diff 通过', verifyOutputs({ checkpoint: cp, reqDir, gitDiff: '+++ b/a.js' }).ok)
  check('失败原因说清是没改动', /没有检测到代码改动/.test(verifyOutputs({ checkpoint: cp, reqDir, gitDiff: '' }).reason))
}

rmSync(root, { recursive: true, force: true })
console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
