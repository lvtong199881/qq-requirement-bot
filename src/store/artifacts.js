/**
 * 产物存储：App 侧要能下载设计稿和各种交付文件。
 *
 * 设计要点是安全：我把文件**复制**进 .state/artifacts/<thread>/
 * 再按 token 提供下载，而不是记录绝对路径后原样读出来。
 *
 * 为什么要复制：如果按记录的绝对路径直接读，一旦有个环节能控制
 * 那个路径（或有人手工改了 sidecar），就是任意文件读取——公网 API
 * 上一个任意文件读取等于把整台机器交出去。复制进来的文件只会出现在
 * 这个受控目录里，下载时再校验解析出的真实路径确实在目录内，
 * 两道锁都不依赖「上游传进来的路径是干净的」。
 *
 * 为什么不复制整个 worktree：只有明确的产物（图片、交付文件）会走这里，
 * 量不大。真正的源码目录不进下载通道。
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 单文件上限 50MB：团队内部的设计稿/安装包够用，再大就该走别的通道 */
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024

export class ArtifactStore {
  /** @param {string} dir 通常是 join(repoRoot, '.state', 'artifacts') */
  constructor(dir) {
    this.dir = dir
    this.#ensureDir()
  }

  #ensureDir() {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    } catch {
      /* 真建不了让后续写入报错 */
    }
  }

  /** threadId 进文件名前必须收敛，理由同 MessageStore */
  #threadDir(threadId) {
    return join(this.dir, String(threadId).replace(/[^A-Za-z0-9._-]/g, '_'))
  }

  /**
   * 存一个产物。
   * @param {string} threadId
   * @param {{name?:string, buffer:Buffer}} o
   * @returns {{token:string, name:string, size:number, url:string}}
   */
  put(threadId, { name, buffer }) {
    this.#ensureDir()
    const dir = this.#threadDir(threadId)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const size = buffer.length
    if (size > MAX_ARTIFACT_BYTES) {
      throw new Error(`产物 ${name ?? ''} 超过 ${Math.round(MAX_ARTIFACT_BYTES / 1024 / 1024)}MB，未保存`)
    }

    // 文件名只留最基础的安全字符：中文名可以保留，路径分隔符必须去掉，
    // 否则 `../../x.png` 会写到 artifacts 目录之外
    const raw = basename(String(name ?? 'file'))
    const safeName = raw.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'file'
    const token = `a${randomBytes(8).toString('hex')}`
    writeFileSync(join(dir, `${token}-${safeName}`), buffer)

    return {
      token,
      name: safeName,
      size,
      url: `/api/threads/${encodeURIComponent(threadId)}/artifacts/${token}`,
    }
  }

  /**
   * 把 token 解析回一个可读的绝对路径。
   *
   * 返回前再校验一次 dirname 仍是本 thread 的目录：即使前面哪里漏了，
   * 这里也会把穿越挡掉。校验用 resolve 后的字符串前缀比较，
   * 末位补上 sep 是为了避免 `/a/bc` 被 `/a/b` 前缀匹配上。
   */
  resolve(threadId, token) {
    if (!/^a[0-9a-f]{16}$/.test(String(token))) return null
    const dir = this.#threadDir(threadId)
    if (!existsSync(dir)) return null

    let names
    try {
      names = readdirSync(dir)
    } catch {
      return null
    }
    const hit = names.find((n) => n.startsWith(`${token}-`))
    if (!hit) return null

    const path = resolve(dir, hit)
    const root = resolve(dir)
    if (!path.startsWith(root + sep)) return null
    try {
      if (!statSync(path).isFile()) return null
    } catch {
      return null
    }
    return { path, name: hit.slice(token.length + 1), size: statSync(path).size }
  }

  stream(threadId, token) {
    const hit = this.resolve(threadId, token)
    if (!hit) return null
    return createReadStream(hit.path)
  }
}
