/**
 * 回合执行器：spawn `dsh --profile <p> --json [--session-id <sid>] <prompt>`，
 * 解析 NDJSON 事件流，把 text / final 交给回调。
 *
 * 为什么用子进程而不是常驻 API：headless 是一次性任务模型，进程边界天然隔离，
 * 卡死可直接杀，且不需要碰 Web GUI 的鉴权链路。
 */
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'

/**
 * 杀掉回合子进程及其后代。
 *
 * Windows 上 child.kill 只结束直接子进程，dsh 拉起的 hvigor / node 构建
 * 会变成孤儿继续跑，占着 CPU 和文件锁。必须 taskkill /T 按进程树杀。
 * POSIX 保持 SIGTERM 语义，让 dsh 有机会收尾。
 */
function killChildTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* 进程可能已经退出 */
    }
  } else {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
}

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
 * @param {() => object|null} [o.receiptProbe] 提前结算探针：进程还在跑时定期调用，
 *   返回非空（回执已合法落盘）就按成功提前收工并终止进程。实测 agent 写完
 *   回执后进程可能挂住几十秒到分钟级，硬等进程退出会占满阶段超时。
 * @param {number} [o.finalGraceMs] final 事件后的宽限期（默认 10s）：收到 final
 *   说明 agent 已答完，进程还不退就视为挂住，探一次回执后强杀收工。
 * @returns {Promise<{sessionId: string|null, finalText: string, exitCode: number|null, timedOut: boolean}>}
 */
/**
 * 拼 Windows 下交给 cmd.exe 的命令串。
 *
 * 为什么 dshBin 只在含路径分隔符时才加引号：cmd 对 `"dsh" ...` 会把带引号的
 * 第一个词当路径解析，在项目目录里向上找，结果找到的是 DeepSeek Harness.exe，
 * 报「不是内部或外部命令」。裸命令名 dsh 不加引号才能走 PATH 找到 dsh.cmd。
 * 带空格的绝对路径（...\DeepSeek Harness\...）则必须加引号，否则会被拆开。
 */
export function buildWinCommand(dshBin, args) {
  const bin = /[\\/]/.test(dshBin) ? `"${dshBin}"` : dshBin
  const quoteArg = (a) => (/\s/.test(a) ? `"${a}"` : a)
  return `${bin} ${args.map(quoteArg).join(' ')}`
}

export function runTurn({
  dshBin,
  profile,
  projectDir,
  sessionId,
  prompt,
  env,
  timeoutMs,
  approvalPolicy,
  permissionMode,
  onEvent,
  signal,
  onChild,
  receiptProbe,
  receiptProbeMs,
  finalGraceMs,
}) {
  const args = ['--profile', profile, '--json']
  if (sessionId) args.push('--session-id', sessionId)
  // 审批策略透传给 dsh headless：dev/test/acceptance 这类要跑构建的无人值守
  // 回合用 never，不然沙箱的默认审批会把 flutter test / gradle 全挡掉。
  // ask 是 dsh 默认值，不传参数行为不变。
  if (approvalPolicy === 'never') args.push('--approval-policy', 'never')
  // approval-policy 只管「要不要弹审批」，沙箱预设是另一层：默认预设下 agent
  // 会话派生子进程会被拒（CreateFile failed 5），flutter/java/git 全跑不了。
  // 无人值守的构建回合必须显式给宽预设，否则只能交出没验证过的代码。
  if (permissionMode) args.push('--permission-mode', permissionMode)
  // 用 "-" 从 stdin 读 prompt，避免超长需求被命令行长度限制截断
  args.push('-')

  // Windows 上 dsh 是 .cmd，必须经 cmd.exe；参数拼进命令字符串、args 传空数组，
  // 顺带避开 shell:true + args 的 DEP0190。
  const isWin = process.platform === 'win32'
  const spawnTarget = isWin ? buildWinCommand(dshBin, args) : dshBin

  const child = spawn(spawnTarget, isWin ? [] : args, {
    cwd: projectDir,
    env,
    // detached：bridge 重启/退出时不要连带杀掉正在跑的回合。
    // 回合的结果靠读回执文件拿，不依赖这个子进程的 stdout 活着——
    // 所以父进程死了，它继续把活干完反而更好。
    // stdout/stderr 仍走管道（日志要用），父进程不在时写入会 EPIPE，
    // 下面的 error 处理会把这类错误吞掉。
    detached: true,
    shell: isWin,
    // detached 在 Windows 上会新建控制台窗口，不加这个每次回合都弹黑框。
    windowsHide: true,
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
  // final 事件是否已到（决定要不要启动宽限计时器）
  let sawFinal = false

  const timer = setTimeout(() => {
    timedOut = true
    killChildTree(child)
    // 给 5 秒优雅退出，否则强杀
    setTimeout(() => {
      if (child.exitCode === null) {
        // Windows 的 taskkill /F 已经是强杀，重复调用是幂等的
        if (process.platform === 'win32') killChildTree(child)
        else child.kill('SIGKILL')
      }
    }, 5000).unref?.()
    // 超时即结算：不再依赖 close 事件。Windows 上 cmd 外壳死了，
    // 孙子进程还握着 stdout 管道，close 永远不来，调用方会被卡死。
    settleTimedOut()
  }, timeoutMs)

  // 超时结算的幂等入口，done 会去重
  let settleTimedOut = () => {}

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
    if (ev.type === 'final' && typeof ev.text === 'string') {
      finalText = ev.text
      // final 到了就允许宽限计时器接管：它只对「final 之后还挂住」生效
      sawFinal = true
    }

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
      // 群里必须 @ bot 才会进引擎（im/router.js routeMessage 只认 @），
      // 提示不带 @ 的话用户照着发纯文本「继续」，消息落库但引擎根本收不到。
      return reset
        ? `模型额度用完了（429 限流），${reset}重置。期间可以先做别的，稍后 @我 发「继续」。`
        : '模型额度用完了（429 限流），稍后 @我 发「继续」重试。'
    }
    if (/Insufficient Balance|余额不足|QUOTA|402/i.test(msg)) {
      return '模型账号余额不足（402），充值或换 API key 后 @我 发「继续」。'
    }
    if (/already owned by an active write handle/i.test(msg)) {
      return '会话被上一个未退出的进程占用（session 写锁未释放）。'
    }
    if (/MISSING_CREDENTIAL|API key|凭证/i.test(msg)) {
      return '模型凭证失效或缺失（API key 问题），检查 DEEPSEEK_API_KEY 后再试。'
    }
    if (/ECONNREFUSED|ETIMEDOUT|network/i.test(msg)) {
      return '网络错误，连不上模型服务，稍后 @我 发「继续」重试。'
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
    killChildTree(child)
  }
  signal?.addEventListener('abort', abortHandler, { once: true })

  return new Promise((resolve) => {
    // spawn 失败（dsh 不在 PATH、路径配错、没有执行权限）不会触发 close，
    // 只会发一个 error 事件。不接这个事件就是未捕获异常，整个 bridge 进程直接死——
    // 试跑第一轮就这么崩过一次。转成一次失败的回合，交给上层返工/报错逻辑。
    let settled = false
    let probeTimer = null
    const done = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (probeTimer) {
        clearInterval(probeTimer)
        probeTimer = null
      }
      clearInterval(graceTimer)
      signal?.removeEventListener('abort', abortHandler)
      resolve(payload)
    }

    // 提前结算：agent 写完回执后进程可能挂住（实测会白耗到阶段超时）。
    // 进程还活着时定期探回执，回执合法落盘就按成功收工、终止进程树。
    // 默认 15s 一次足够快——首次命中也要等一个周期，相对挂住的分钟级
    // 损耗可忽略；测试用 receiptProbeMs 调快。
    if (receiptProbe) {
      probeTimer = setInterval(() => {
        if (child.exitCode !== null) return // 进程自己退了，交给 close 事件
        let found = null
        try {
          found = receiptProbe()
        } catch {
          /* 探针失败（文件竞态等）不当回事，下轮再探 */
        }
        if (!found) return
        killChildTree(child)
        setTimeout(() => {
          if (child.exitCode === null) {
            if (process.platform === 'win32') killChildTree(child)
            else child.kill('SIGKILL')
          }
        }, 5000).unref?.()
        probeTimer = null
        done({
          sessionId: sid,
          finalText,
          exitCode: null,
          timedOut: false,
          // 标记「按回执收工」：进程是被杀的，exitCode 不可作准，
          // 上层要按成功处理，不能拿 exitCode 判失败。
          settledByReceipt: true,
          stderr: stderrTail,
          turnError: null,
          errorSummary: null,
          sessionLocked: false,
          spawnFailed: false,
        })
      }, receiptProbeMs ?? 15000)
      probeTimer.unref?.()
    }

    // final 宽限杀：final 事件到达 = agent 已经把答案说完（回执在这前后
    // 一两秒内落盘）。实测 headless 模式下 dsh 写完 final 后经常不退出
    // （真实需求 11 个成功回合 10 个挂住），硬等 close 会白耗到探针周期
    // 或阶段超时。宽限几秒还没退就杀：先探一次回执——有回执按
    // settledByReceipt 收工（和探针同款结算），没有也照杀（final 都说完
    // 还挂着就是挂住），后续由 close 事件正常结算。
    const graceMs = finalGraceMs ?? 10000
    const graceTimer = setInterval(() => {
      if (!sawFinal || child.exitCode !== null) return
      let found = null
      try {
        found = receiptProbe?.() ?? null
      } catch {
        /* 同探针：竞态不当回事 */
      }
      killChildTree(child)
      setTimeout(() => {
        if (child.exitCode === null) {
          if (process.platform === 'win32') killChildTree(child)
          else child.kill('SIGKILL')
        }
      }, 5000).unref?.()
      clearInterval(graceTimer)
      done({
        sessionId: sid,
        finalText,
        exitCode: null,
        timedOut: false,
        settledByReceipt: found != null,
        stderr: stderrTail,
        turnError: null,
        errorSummary: null,
        sessionLocked: false,
        spawnFailed: false,
      })
    }, graceMs)
    graceTimer.unref?.()

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

    settleTimedOut = () => {
      done({
        sessionId: sid,
        finalText,
        exitCode: null,
        timedOut: true,
        stderr: stderrTail,
        turnError: turnError ?? '回合超时被强杀',
        errorSummary: runnerClassify?.(turnError ?? '回合超时被强杀') ?? null,
        sessionLocked: false,
        envFailed: false,
      })
    }

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
