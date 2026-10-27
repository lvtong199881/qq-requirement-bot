/**
 * 迁移脚本：把改造前的需求状态迁到「文档在仓库外」的新布局。
 *
 * 改造前：需求文档在 <projectDir>/docs/requirements/<reqId>/
 * 改造后：需求文档在 dataRoot/<reqId>/，代码在 worktree 里
 *
 * 幂等：已经有 dataDir 的需求直接跳过，可以重复执行。
 *
 *   node src/migrate.js            # 只看会做什么（dry-run）
 *   node src/migrate.js --apply    # 真的动手
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { SessionStore } from './state.js'

const apply = process.argv.includes('--apply')
const config = loadConfig()
const store = new SessionStore(config.repoRoot)

function log(...a) {
  console.log(apply ? '[迁移]' : '[预演]', ...a)
}

/** 把仓库内的需求目录复制到数据目录（不删原目录，旧路径还要兼容读） */
function migrateFlow(groupId, flow) {
  if (!flow?.reqId) return null
  if (flow.dataDir && existsSync(flow.dataDir)) return null // 已经是新布局

  const oldDir = join(flow.projectDir ?? config.projectDir, 'docs/requirements', flow.reqId)
  const dataDir = join(config.dataRoot, flow.reqId)

  if (!existsSync(oldDir)) {
    // 没有历史产物：只补一个空数据目录，让后续回合有地方写
    if (apply) mkdirSync(dataDir, { recursive: true })
    log(`群 ${groupId} / ${flow.reqId}：没有历史产物，创建空数据目录 ${dataDir}`)
    return { ...flow, dataDir }
  }

  const count = readdirSync(oldDir).length
  log(`群 ${groupId} / ${flow.reqId}：搬运 ${count} 个文件 ${oldDir} → ${dataDir}`)
  if (apply) {
    mkdirSync(dataDir, { recursive: true })
    cpSync(oldDir, dataDir, { recursive: true, force: true })
  }
  return { ...flow, dataDir, legacyDocsDir: oldDir }
}

let touched = 0
for (const groupId of store.allGroupIds()) {
  const st = store.get(groupId)
  if (!st?.flow) continue

  const next = migrateFlow(groupId, st.flow)
  if (!next) continue

  touched++
  if (apply) store.save(groupId, { ...st, flow: next })
}

console.log(
  apply
    ? `\n完成：迁移了 ${touched} 个需求。仓库内的旧目录保留着（兼容历史需求继续跑），确认无误后可以手动删。`
    : `\n预演结束：有 ${touched} 个需求需要迁移。加 --apply 真正执行。`,
)
