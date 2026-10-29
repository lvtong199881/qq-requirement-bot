/**
 * 模拟器服务的客户端。
 *
 * 编排层和面板都用它访问模拟器服务，不直接 import 实现——
 * 服务在哪台机器、用什么工具启动模拟器，调用方不需要知道。
 * 配置里只认一个地址：config.emulatorService.url。
 */

const DEFAULT_URL = 'http://127.0.0.1:7880'

export class EmulatorClient {
  constructor({ url = DEFAULT_URL, timeoutMs = 10_000 } = {}) {
    this.base = String(url).replace(/\/$/, '')
    this.timeoutMs = timeoutMs
  }

  async #req(method, path, body) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    try {
      const r = await fetch(`${this.base}${path}`, {
        method,
        signal: ac.signal,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const data = await r.json().catch(() => ({ ok: false, error: '响应不是合法 JSON' }))
      return { status: r.status, ...data }
    } catch (err) {
      // 服务没起来是常见情况（用户没启动模拟器服务），给出可读原因而不是 ECONNREFUSED
      const reason =
        err.name === 'AbortError'
          ? '模拟器服务响应超时'
          : `连不上模拟器服务（${this.base}）：服务没启动？`
      return { ok: false, error: reason, offline: true }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 服务是否可用（不抛错，返回布尔） */
  async alive() {
    const r = await this.#req('GET', '/healthz')
    return r.ok === true
  }

  /** 存活信息 */
  health() {
    return this.#req('GET', '/healthz')
  }

  /** 平台能力（编译/测试/装包命令） */
  capabilities() {
    return this.#req('GET', '/api/capabilities')
  }

  /** 全部模拟器（含运行状态和租约）。可按平台或仓库过滤 */
  list({ platform, repoId } = {}) {
    const q = new URLSearchParams()
    if (platform) q.set('platform', platform)
    if (repoId) q.set('repo', repoId)
    const qs = q.toString()
    return this.#req('GET', `/api/emulators${qs ? '?' + qs : ''}`)
  }

  start(name, { reset = false } = {}) {
    return this.#req('POST', '/api/emulators/start', { name, reset })
  }

  stop(name) {
    return this.#req('POST', '/api/emulators/stop', { name })
  }

  wipe(name) {
    return this.#req('POST', '/api/emulators/wipe', { name })
  }

  remove(name) {
    return this.#req('POST', '/api/emulators/delete', { name })
  }

  /**
   * 申请一台可用设备。
   * 返回 { ok:true, deviceId } 或 { ok:false, error }（没有可用设备时 status=409）。
   */
  lease({ reqId, stage, platform, repoId }) {
    return this.#req('POST', '/api/lease', { reqId, stage, platform, repoId })
  }

  release(deviceId) {
    return this.#req('DELETE', `/api/lease/${encodeURIComponent(deviceId)}`)
  }
}

/** 从配置构造客户端；配置里没写就当服务在默认地址 */
export function createEmulatorClient(config) {
  return new EmulatorClient({ url: config?.emulatorService?.url ?? DEFAULT_URL })
}
