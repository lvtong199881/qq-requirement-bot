/**
 * 实例注册表：让面板知道「有哪些 bridge 在跑、各自的端口和身份」。
 *
 * 每个 bridge 启动时写 .instances/<pid>.json，退出时删。
 * 面板扫描这个目录就能聚合多个实例（多 profile / 多项目）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 进程是否还活着（不发信号，只探测） */
export function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM' // 存在但无权限，也算活着
  }
}

export class InstanceRegistry {
  /** @param {string} repoRoot */
  constructor(repoRoot) {
    this.dir = join(repoRoot, '.instances')
    this.file = null
  }

  #ensure() {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
  }

  /**
   * 注册本实例。返回要写盘的路径。
   * 顺带做单实例检查：同一 projectDir 已有活着的实例时返回它，交给调用方决定。
   */
  register({ pid, port, profile, projectDir, logFile, gitCommit, version }) {
    this.#ensure()
    const record = {
      pid,
      port,
      profile,
      projectDir,
      logFile,
      gitCommit,
      version,
      startedAt: Date.now(),
      cwd: process.cwd(),
      nodeVersion: process.version,
    }
    this.file = join(this.dir, `${pid}.json`)
    writeFileSync(this.file, JSON.stringify(record, null, 2), 'utf8')
    return record
  }

  /** 列出所有实例记录，剔除已死的进程 */
  list({ cleanup = false } = {}) {
    this.#ensure()
    const out = []
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue
      const file = join(this.dir, name)
      let rec
      try {
        rec = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        continue
      }
      const alive = isAlive(rec.pid)
      if (!alive && cleanup) {
        try {
          unlinkSync(file)
        } catch {
          /* ignore */
        }
        continue
      }
      out.push({ ...rec, alive })
    }
    return out.sort((a, b) => a.startedAt - b.startedAt)
  }

  /** 找出正在服务同一项目的其他实例（用于多开告警） */
  findSiblings(projectDir, selfPid) {
    return this.list().filter((x) => x.alive && x.pid !== selfPid && x.projectDir === projectDir)
  }

  unregister() {
    if (!this.file) return
    try {
      if (existsSync(this.file)) unlinkSync(this.file)
    } catch {
      /* ignore */
    }
    this.file = null
  }
}
