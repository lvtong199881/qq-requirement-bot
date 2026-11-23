/**
 * 配置加载：老配置兼容 + 已删键的识别。
 *
 * 删掉 QQ 通道后，老机器上的 bot.config.json 里还留着 onebot / superAdmin 这些段。
 * 这里钉死两件事：
 *   1. 这些键不能让启动失败——升级即挂比留着没用的配置更难受
 *   2. 也不能静默吞掉——用户会以为「superAdmin 配了却不生效」是 bug
 *   node test/config.js
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../src/config.js'

let pass = 0, fail = 0
const check = (n, c, e = '') => {
  console.log(`  ${c ? '✅' : '❌'} ${n}${!c && e ? ' — ' + e : ''}`)
  c ? pass++ : fail++
}

const dir = mkdtempSync(join(tmpdir(), 'config-'))
const write = (name, obj) => {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify(obj, null, 2))
  return p
}

/** 能启动的最小配置：一个存在的仓库目录 */
const projects = join(dir, 'proj')
mkdirSync(projects, { recursive: true })
const base = { repos: [{ id: 'app', name: 'app', path: projects }] }

console.log('\n== 一份干净的新配置 ==')
{
  const c = loadConfig(write('clean.json', base))
  check('没有废弃键', Array.isArray(c.obsoleteKeys) && c.obsoleteKeys.length === 0, JSON.stringify(c.obsoleteKeys))
  check('bot 只剩 name', JSON.stringify(Object.keys(c.bot)) === '["name"]', JSON.stringify(Object.keys(c.bot)))
  check('limits 只剩两项', JSON.stringify(Object.keys(c.limits)) === '["maxConcurrentTurns","maxWorktrees"]')
  check('api 默认不开', c.api.enabled === false)
  check('api 默认端口 7881', c.api.port === 7881)
}

console.log('\n== QQ 时代的老配置 ==')
{
  // 这是删通道前脚本生成的形状，用户机器上真实存在这种文件
  const c = loadConfig(write('legacy.json', {
    ...base,
    bot: { qq: '874368541', name: '产品同学' },
    onebot: { ws: 'ws://127.0.0.1:3001', token: '' },
    groupPolicy: { mode: 'auto' },
    excludeGroups: ['123'],
    adminUsers: ['10001'],
    superAdmin: ['2293983846'],
    limits: { maxMessagesPerMinute: 10, chunkChars: 3000, maxConcurrentTurns: 3 },
  }))
  check('启动不报错', !!c)
  check('报出全部已删键', c.obsoleteKeys.length === 6, c.obsoleteKeys.join('、'))
  check('认得 onebot', c.obsoleteKeys.includes('onebot'))
  check('认得 bot.qq', c.obsoleteKeys.includes('bot.qq'))
  check('认得 groupPolicy', c.obsoleteKeys.includes('groupPolicy'))
  check('认得 superAdmin', c.obsoleteKeys.includes('superAdmin'))
  check('bot.qq 不再出现在结果里', c.bot.qq === undefined)
  check('限速字段被忽略', c.limits.maxMessagesPerMinute === undefined && c.limits.chunkChars === undefined)
  check('剩下的并发上限仍然生效', c.limits.maxConcurrentTurns === 3)
}

console.log('\n== 只写了部分废弃键 ==')
{
  const c = loadConfig(write('partial.json', { ...base, superAdmin: ['1'] }))
  check('只报写了的那个', JSON.stringify(c.obsoleteKeys) === '["superAdmin"]', JSON.stringify(c.obsoleteKeys))
}

console.log('\n== 空数组也照样报 ==')
{
  // 有人把 adminUsers 清成 [] 但键还留着。提一句不亏——他要的是「删掉这个段落」，
  // 而不是「让它看起来是空的」，下次动配置时还是会踩到。
  const c = loadConfig(write('empty.json', { ...base, adminUsers: [], excludeGroups: [] }))
  check('空数组仍然算键还在', c.obsoleteKeys.includes('adminUsers'))
  check('两个空数组都报', c.obsoleteKeys.length === 2, JSON.stringify(c.obsoleteKeys))
}

console.log('\n== toolPaths：子进程 PATH 补充目录 ==')
{
  const c = loadConfig(write('tools.json', { ...base, toolPaths: ['C:\\Program Files\\Git\\cmd', '  ', 'C:\\src\\flutter\\bin'] }))
  check('字符串目录保留', c.toolPaths.length === 2 && c.toolPaths[0] === 'C:\\Program Files\\Git\\cmd', JSON.stringify(c.toolPaths))
  const blank = loadConfig(write('tools-blank.json', base))
  check('没配是空数组', Array.isArray(blank.toolPaths) && blank.toolPaths.length === 0)
  const junk = loadConfig(write('tools-junk.json', { ...base, toolPaths: [42, null, 'ok'] }))
  check('非字符串项被过滤', JSON.stringify(junk.toolPaths) === '["ok"]', JSON.stringify(junk.toolPaths))
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
