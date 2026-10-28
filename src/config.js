/**
 * 配置加载 + skillDir 动态解析。
 *
 * 设计要点：skillDir 默认不写死。config 里留空时按固定优先级探测，
 * 这样换机器、换目录、多人共用同一份仓库都不用改配置。
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')

/** 探测 skill 目录时依次尝试的候选路径 */
function skillCandidates() {
  const names = ['requirement-spec']
  const roots = [
    process.env.QQ_RS_SKILL_ROOT,
    join(homedir(), '.agents', 'skills'),
    join(homedir(), '.dsh', 'skills'),
    join(REPO_ROOT, '..', 'skills'),
    join(REPO_ROOT, 'skills'),
  ].filter(Boolean)

  const out = []
  for (const root of roots) {
    for (const name of names) out.push(join(root, name))
  }
  return out
}

/** 一个目录算不算 requirement-spec skill：有 SKILL.md 且 frontmatter 里 name 对得上 */
function looksLikeSkill(dir) {
  const skillMd = join(dir, 'SKILL.md')
  if (!existsSync(skillMd)) return false
  try {
    const head = readFileSync(skillMd, 'utf8').slice(0, 2000)
    return /^name:\s*requirement-spec\s*$/m.test(head)
  } catch {
    return false
  }
}

/**
 * 解析 skill 目录。
 * @param {string|undefined} configured config 里显式写的路径（可为空）
 * @returns {string} 绝对路径
 */
export function resolveSkillDir(configured) {
  if (configured && configured.trim()) {
    const dir = expandHome(configured.trim())
    if (!looksLikeSkill(dir)) {
      throw new Error(
        `config 里指定的 skillDir 不是有效的 requirement-spec skill：${dir}\n` +
          `（需要该目录下存在 SKILL.md，且 frontmatter 含 name: requirement-spec）`,
      )
    }
    return dir
  }
  for (const dir of skillCandidates()) {
    if (looksLikeSkill(dir)) return dir
  }
  throw new Error(
    '找不到 requirement-spec skill。\n' +
      '可以用环境变量 QQ_RS_SKILL_ROOT 指向 skills 根目录，\n' +
      '或在 bot.config.json 里显式写 skillDir。\n' +
      `已尝试：\n${skillCandidates()
        .map((p) => '  - ' + p)
        .join('\n')}`,
  )
}

/** 取正整数，非法值回退默认 */
function posInt(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

export function expandHome(p) {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/** 读 bot.config.json */
/** 从 profile 的 cordis.patch.yml 里读 agent-default-model，拼成 "provider/model" */
function readModelLabel(profile) {
  if (!profile) return null
  try {
    const f = join(homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml')
    if (!existsSync(f)) return null
    const text = readFileSync(f, 'utf8')
    // 找 agent-default-model 下面最近的 provider/model 两行
    const idx = text.lastIndexOf('agent-default-model')
    if (idx < 0) return null
    const tail = text.slice(idx, idx + 400)
    const provider = tail.match(/^\s*provider:\s*(\S+)/m)?.[1]
    const model = tail.match(/^\s*model:\s*(\S+)/m)?.[1]
    return provider && model ? `${provider}/${model}` : null
  } catch {
    return null
  }
}

export function loadConfig(configPath) {
  const path = configPath
    ? resolve(expandHome(configPath))
    : join(REPO_ROOT, 'bot.config.json')

  if (!existsSync(path)) {
    throw new Error(
      `没有找到配置文件：${path}\n` +
        `先复制样例：cp bot.config.example.json bot.config.json，然后改成本机实际值。`,
    )
  }

  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`配置文件不是合法 JSON：${path}\n${err.message}`)
  }

  const projectDir = resolve(expandHome(raw.projectDir ?? ''))
  if (!raw.projectDir) throw new Error('config 缺少 projectDir（需求要落到的项目根目录）')
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    throw new Error(`projectDir 不存在或不是目录：${projectDir}`)
  }

  return {
    ...raw,
    configPath: path,
    repoRoot: REPO_ROOT,
    projectDir,
    skillDir: resolveSkillDir(raw.skillDir),
    dshBin: raw.dshBin || 'dsh',
    profile: raw.profile || 'qqbot',
    bot: {
      qq: String(raw.bot?.qq ?? ''),
      name: raw.bot?.name || '产品同学',
    },
    onebot: {
      ws: raw.onebot?.ws || 'ws://127.0.0.1:3001',
      token: raw.onebot?.token || process.env.ONEBOT_TOKEN || '',
      reconnectMs: raw.onebot?.reconnectMs ?? 3000,
    },
    // 群不再手填：默认自动发现 bot 所在的所有群。
    // 想限制范围时才写 groups，留空表示「全自动」。
    groups: (raw.groups ?? []).map((g) => ({
      groupId: String(g.groupId),
      projectDir: g.projectDir ? resolve(expandHome(g.projectDir)) : projectDir,
      approval: g.approval === 'auto' ? 'auto' : 'manual',
    })),
    groupPolicy: normalizeGroupPolicy(raw.groupPolicy),
    // 排除名单：auto 模式下也不服务的群（个人闲聊群之类）。
    // 这是 auto 模式的补丁，填了就不用为了排除几个群而改用 allowlist。
    excludeGroups: (raw.excludeGroups ?? []).map((x) => String(x)),
    // 顶层 approval 是 auto 模式下所有群的默认批准方式
    approval: raw.approval === 'auto' ? 'auto' : 'manual',
    // 所有限流/并发上限收在这一个对象里。
    // 以前有人复制出第二个 limits 定义，后一个把前一个整个覆盖掉，
    // 结果 maxMessagesPerMinute 变成 undefined —— 每条群消息都白等 60 秒。
    limits: {
      maxMessagesPerMinute: raw.limits?.maxMessagesPerMinute ?? 10,
      // QQ 单条消息的实际上限约 4500 字（含转义余量），
      // 超出才拆条；正常情况下一条发完，别让用户收到 N 条。
      chunkChars: raw.limits?.chunkChars ?? 3000,
      maxChunksPerTurn: raw.limits?.maxChunksPerTurn ?? 4,
      // 并发上限：执行槽 = 同时跑的回合数；worktree 池 = 同时开发中的需求数
      maxConcurrentTurns: posInt(raw.limits?.maxConcurrentTurns, 2),
      maxWorktrees: posInt(raw.limits?.maxWorktrees, 12),
    },
    // 静默心跳：多久没动静才在群里报一次进展
    heartbeat: {
      enabled: raw.heartbeat?.enabled !== false,
      idleMinutes: raw.heartbeat?.idleMinutes ?? 5,
    },
    upload: {
      enabled: raw.upload?.enabled !== false,
      patterns: raw.upload?.patterns ?? ['**/*.md', '**/*.png', '**/*.jpg'],
      maxFiles: raw.upload?.maxFiles ?? 8,
      maxFileMB: raw.upload?.maxFileMB ?? 20,
    },
    // 分阶段超时（分钟）。dev/test/acceptance 要跑构建、装包、逐条核对，留够时间；
    // 其余阶段大多是读文档写文档，半小时足够。旧的全局 turnTimeoutMs 仍然生效，
    // 作为 stageTimeouts.default 的兜底。
    stageTimeouts: {
      default: minutes(raw.stageTimeouts?.default, raw.turnTimeoutMs ? raw.turnTimeoutMs / 60000 : 30),
      dev: minutes(raw.stageTimeouts?.dev, 60),
      test: minutes(raw.stageTimeouts?.test, 60),
      acceptance: minutes(raw.stageTimeouts?.acceptance, 60),
    },
    turnTimeoutMs: raw.turnTimeoutMs ?? 30 * 60 * 1000,
    verbose: raw.verbose === true,
    // 本机环境提示：注入到每回合 prompt，避免 agent 靠猜（比如工具链不在 PATH）
    envHints: typeof raw.envHints === 'string' ? raw.envHints.trim() : '',
    // 群消息文案覆盖：{ ack: '...', heartbeat: '...' }，缺的走内置默认
    messageTemplates:
      raw.messageTemplates &&
      typeof raw.messageTemplates === 'object' &&
      !Array.isArray(raw.messageTemplates)
        ? Object.fromEntries(
            Object.entries(raw.messageTemplates)
              .filter(([, v]) => typeof v === 'string' && v.trim())
              .map(([k, v]) => [k, v]),
          )
        : {},
    // 超级管理员：不受群角色与白名单限制，任何群都能驱动 bot。
    // 只能改配置文件——面板不提供编辑入口，避免把自己锁出去。
    superAdmin: (Array.isArray(raw.superAdmin) ? raw.superAdmin : raw.superAdmin ? [raw.superAdmin] : []).map(
      (x) => String(x),
    ),
    // 指令白名单：面板可编辑，额外放行非群管的 QQ 号
    adminUsers: Array.isArray(raw.adminUsers)
      ? raw.adminUsers.map((x) => String(x))
      : raw.adminUsers
        ? [String(raw.adminUsers)]
        : [],
    // 面板展示用的模型名：配置优先，否则从 profile 的 agent-default-model 推断
    modelLabel: raw.modelLabel ?? readModelLabel(raw.profile),
    // ── 仓库与工作区 ──
    // bot 不持有主工作区：只有裸仓库 + 按需求创建的 worktree。
    repoDir: expandHome(typeof raw.repoDir === 'string' && raw.repoDir.trim() ? raw.repoDir.trim() : '~/.qq-bot/repo.git'),
    worktreeRoot: expandHome(
      typeof raw.worktreeRoot === 'string' && raw.worktreeRoot.trim() ? raw.worktreeRoot.trim() : '~/.qq-bot/worktrees',
    ),
    dataRoot: expandHome(
      typeof raw.dataRoot === 'string' && raw.dataRoot.trim() ? raw.dataRoot.trim() : '~/.qq-bot/data',
    ),
    // 裸仓库的远端地址；空则从 projectDir 的 origin 推断
    remoteUrl: typeof raw.remoteUrl === 'string' ? raw.remoteUrl.trim() : '',
    // ── 设备（模拟器/真机）──
    // 开发、测试、验收都要往设备上装包，设备是独占资源，按台分配。
    // platform 决定怎么发现设备，devices 为空时按平台自动探测。
    platform: ['harmony', 'android', 'ios'].includes(raw.platform) ? raw.platform : 'harmony',
    devices: Array.isArray(raw.devices) ? raw.devices : [],
    tools: {
      hdc: typeof raw.tools?.hdc === 'string' ? raw.tools.hdc : 'hdc',
      adb: typeof raw.tools?.adb === 'string' ? raw.tools.adb : 'adb',
      xcrun: typeof raw.tools?.xcrun === 'string' ? raw.tools.xcrun : 'xcrun',
    },

    // 模拟器服务地址：设备发现、启停、租约都在那个服务里，编排层只调接口
    emulatorService: {
      url:
        typeof raw.emulatorService?.url === 'string' && raw.emulatorService.url.trim()
          ? raw.emulatorService.url.trim().replace(/\/$/, '')
          : 'http://127.0.0.1:7880',
    },

    // 并发上限：执行槽 = 同时跑的回合数；worktree 池 = 同时开发中的需求数

    // 管理面板 / 本地 HTTP API
    panel: {
      enabled: raw.panel?.enabled !== false,
      port: Number(raw.panel?.port ?? 7878),
      publicPort: Number(raw.panel?.publicPort ?? 7879),
      token: typeof raw.panel?.token === 'string' ? raw.panel.token : '',
    },
  }
}

/**
 * 群策略。三种模式：
 *   auto     —— bot 被拉进的任何群都接受（默认，推荐）
 *   allowlist —— 只接受 groups 里列出的群
 *   deny      —— 全部拒绝
 */
function normalizeGroupPolicy(policy) {
  const p = policy?.mode
  if (p === 'allowlist') return { mode: 'allowlist' }
  if (p === 'deny') return { mode: 'deny' }
  if (p === 'auto') return { mode: 'auto' }
  return { mode: 'auto' }
}

/**
 * 取 DEEPSEEK_API_KEY：优先环境变量，其次从 DSH 凭证文件读。
 * headless profile 只认环境变量，所以这里必须帮忙补上。
 */
export function resolveApiKey(name = 'DEEPSEEK_API_KEY') {
  if (process.env[name]) return process.env[name]

  const file = join(homedir(), '.dsh', '.credentials.yaml')
  if (!existsSync(file)) return undefined

  const text = readFileSync(file, 'utf8')
  // 只取 refs 段里的 key，避免误读 records 里的 token
  const refsIdx = text.search(/^refs:\s*$/m)
  const scope = refsIdx >= 0 ? text.slice(refsIdx) : text
  const re = new RegExp(`^\\s+${name}:\\s*["']?([^\\s"']+)["']?\\s*$`, 'm')
  return text && scope.match(re)?.[1]
}

/**
 * 本机模型 provider 需要的全部凭证环境变量。
 * dsh 的 llm-pi-ai 按 apiKeyEnv 读对应变量，所以这里一次备齐。
 */
export function resolveModelEnv() {
  const names = ['DEEPSEEK_API_KEY', 'OPENCODE_GO_API_KEY']
  const env = {}
  for (const n of names) {
    const v = resolveApiKey(n)
    if (v) env[n] = v
  }
  return env
}

/** 阶段超时分钟数：非法值退回默认，夹在 1..180 之间 */
function minutes(v, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return Math.round(fallback)
  return Math.min(180, Math.max(1, Math.round(n)))
}
