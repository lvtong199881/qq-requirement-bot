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
    // detached：bridge 重启/退出时不要连带杀掉正在跑的回合。
    // 回合的结果靠读回执文件拿，不依赖这个子进程的 stdout 活着——
    // 所以父进程死了，它继续把活干完反而更好。
    // stdout/stderr 仍走管道（日志要用），父进程不在时写入会 EPIPE，
    // 下面的 error 处理会把这类错误吞掉。
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  onChild?.(child)
  // 父进程退出后管道会断，子进程继续写 stdout 时这里会收到 EPIPE。
  // 那是预期情况（回合还在跑），不要让它变成未捕获异常。
  child.stdout?.on('error', () => {})
  child.stderr?.on('error', () => {})
  child.stdin?.on('error', () => {})

  let sid = sessionId ?? null
  let finalText = ''
  let timedOut = false
  let stderrTail = ''
  let turnError = null
  let runnerClassify = null

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

    // turn_end 带 error 时（429 限流、凭证失效等），把关键信息提出来。
    // 这类错误 Agent 自己不会说，bridge 必须能识别并在群里讲人话。
    if (ev.type === 'status' && ev.phase === 'turn_end' && ev.reason?.kind === 'error') {
      turnError = ev.reason.error?.message ?? '未知错误'
    }
    onEvent?.(ev)
  })

  // 从错误文本里提取「人能看懂」的原因
  function classifyError(msg) {
    if (!msg) return null
    if (/429|rate.?limit|频率限制|限流|quota/i.test(msg)) {
      const reset = msg.match(/(\d{4}-\d{2}-\d{2}[^，,]*?重置)/)?.[1]
      return reset
        ? `模型额度用完了（429 限流），${reset}重置。期间可以先做别的，稍后发「继续」。`
        : '模型额度用完了（429 限流），稍后发「继续」重试。'
    }
    if (/Insufficient Balance|余额不足|QUOTA|402/i.test(msg)) {
      return '模型账号余额不足（402），充值或换 API key 后发「继续」。'
    }
    if (/already owned by an active write handle/i.test(msg)) {
      return '会话被上一个未退出的进程占用（session 写锁未释放）。'
    }
    if (/MISSING_CREDENTIAL|API key|凭证/i.test(msg)) {
      return '模型凭证失效或缺失（API key 问题），检查 DEEPSEEK_API_KEY 后再试。'
    }
    if (/ECONNREFUSED|ETIMEDOUT|network/i.test(msg)) {
      return '网络错误，连不上模型服务，稍后发「继续」重试。'
    }
    if (/EPERM|EACCES|operation not permitted/i.test(msg)) {
      return '文件权限不足（EPERM）：dsh 进程被沙箱限制，写不了 ~/.dsh。' +
        '请从普通终端启动 bridge，不要在受限环境里跑。'
    }
    if (/ENOENT.*dsh|spawn dsh/i.test(msg)) {
      return '找不到 dsh 可执行文件：检查 bot.config.json 的 dshBin 是否指向真实路径。'
    }
    return `回合异常终止：${msg.slice(0, 200)}`
  }
  runnerClassify = classifyError

  const abortHandler = () => {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
  signal?.addEventListener('abort', abortHandler, { once: true })

  return new Promise((resolve) => {
    // spawn 失败（dsh 不在 PATH、路径配错、没有执行权限）不会触发 close，
    // 只会发一个 error 事件。不接这个事件就是未捕获异常，整个 bridge 进程直接死——
    // 试跑第一轮就这么崩过一次。转成一次失败的回合，交给上层返工/报错逻辑。
    let settled = false
    const done = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abortHandler)
      resolve(payload)
    }

    child.on('error', (err) => {
      done({
        sessionId: sid,
        finalText,
        exitCode: null,
        timedOut: false,
        stderr: stderrTail,
        turnError: err.message,
        errorSummary: `启动 dsh 失败（${err.code ?? 'ERROR'}）：${err.message}`,
        sessionLocked: false,
        spawnFailed: true,
      })
    })

    child.on('close', (code) => {
      // 有些错误不会产生 turn_end 事件，只会打到 stderr 然后进程退出
      //（比如 session 写锁被占用）。所以两类来源都要看。
      const fatal = turnError ?? (code !== 0 ? stderrTail : null)
      const sessionLocked = /already owned by an active write handle/i.test(fatal ?? '')
      // 沙箱/权限类错误重试一万次也不会好，标记出来让上层直接报错，别烧三轮返工
      const envFailed = /EPERM|EACCES|operation not permitted/i.test(fatal ?? '')

      done({
        sessionId: sid,
        finalText,
        exitCode: code,
        timedOut,
        stderr: stderrTail,
        turnError: fatal,
        // session 被锁有专门的重试路径，不走通用异常播报
        errorSummary: sessionLocked ? null : (runnerClassify?.(fatal) ?? null),
        sessionLocked,
        envFailed,
      })
    })
  })
}
