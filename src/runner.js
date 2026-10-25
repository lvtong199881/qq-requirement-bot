/**
 * 回合执行器：spawn `dsh --profile <p> --json [--session-id <sid>] <prompt>`，
 * 解析 NDJSON 事件流，把 text / final 交给回调。
 *
 * 为什么用子进程而不是常驻 API：headless 是一次性任务模型，进程边界天然隔离，
 * 卡死可直接杀，且不需要碰 Web GUI 的鉴权链路。
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * @param {object} o
 * @param {string} o.dshBin
 * @param {string} o.profile
 * @param {string} o.projectDir
 * @param {string|undefined} o.sessionId 有则续跑同一会话
 * @param {string} o.prompt
 * @param {Record<string,string>} o.env
 * @param {number} o.timeoutMs
 * @param {(ev: object) => void} o.onEvent 每个 NDJSON 事件
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{sessionId: string|null, finalText: string, exitCode: number|null, timedOut: boolean}>}
 */
export function runTurn({
  dshBin,
  profile,
  projectDir,
  sessionId,
  prompt,
  env,
  timeoutMs,
  onEvent,
  signal,
  onChild,
}) {
  const args = ['--profile', profile, '--json']
  if (sessionId) args.push('--session-id', sessionId)
  // 用 "-" 从 stdin 读 prompt，避免超长需求被命令行长度限制截断
  args.push('-')

  const child = spawn(dshBin, args, {
    cwd: projectDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  onChild?.(child)

  let sid = sessionId ?? null
  let finalText = ''
  let timedOut = false
  let stderrTail = ''

  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    // 给 5 秒优雅退出，否则强杀
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, 5000).unref?.()
  }, timeoutMs)

  child.stdin.on('error', () => {
    /* 子进程提前退出时写 stdin 会 EPIPE，忽略 */
  })
  child.stdin.end(prompt)

  child.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-4000)
  })

  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) return
    let ev
    try {
      ev = JSON.parse(trimmed)
    } catch {
      return
    }
    if (ev.type === 'session' && ev.sessionId) sid = ev.sessionId
    if (ev.type === 'final' && typeof ev.text === 'string') finalText = ev.text
    onEvent?.(ev)
  })

  const abortHandler = () => {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
  signal?.addEventListener('abort', abortHandler, { once: true })

  return new Promise((resolve) => {
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abortHandler)
      resolve({
        sessionId: sid,
        finalText,
        exitCode: code,
        timedOut,
        stderr: stderrTail,
      })
    })
  })
}
