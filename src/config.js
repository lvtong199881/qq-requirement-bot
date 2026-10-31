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
 * v2 编排读的是仓库内 skills/<角色>/SKILL.md，这里的 requirement-spec
 * 只是 v1 遗留；找不到时默认返回 null，不阻塞启动。
 * @param {string|undefined} configured config 里显式写的路径（可为空）
 * @param {{required?: boolean}} [opts] required=true 时找不到仍抛错
 * @returns {string|null} 绝对路径，或 null
 */
export function resolveSkillDir(configured, { required = false } = {}) {
  if (configured && configured.trim()) {
    const dir = expandHome(configured.trim())
    if (!looksLikeSkill(dir)) {
      if (!required) return null
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
  if (!required) return null
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

export function pick(...vals) {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return expandHome(v.trim())
  // 最后一个参数如果不是字符串，就是默认值
  const last = vals[vals.length - 1]
  return typeof last === 'string' ? last : null
}

function expandHome(p) {
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

/**
 * 就地刷新配置对象：面板改完 bot.config.json 后调它，
 * 不用重启进程——引用不变，内容换成新的。
 *
 * 就地改而不是返回新对象，是因为 bridge 创建时把 config 解构进了闭包，
 * 换引用它看不到；改内容能立刻生效。
 */
/** 取某个平台的工具配置 */
export function toolsFor(config, platform) {
  return config.tools?.[platform] ?? {}
}

export function reloadConfigInto(target, configPath) {
  const fresh = loadConfig(configPath)
  const keep = target.configPath
  for (const k of Object.keys(target)) {
    if (!(k in fresh)) delete target[k]
  }
  Object.assign(target, fresh)
  target.configPath = fresh.configPath ?? keep
  return target
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

  // 仓库只有一种配法：repos 数组。单仓库就是一个元素，不需要第二套入口——
  // 以前同时认 projectDir 和 repos，两套配置迟早会不一致。
  if (!Array.isArray(raw.repos) || raw.repos.length === 0) {
    throw new Error(
      'config 缺少 repos（需求要落到的仓库列表）。单仓库写一项即可：\n' +
        '  "repos": [{ "id": "app", "path": "~/your-project" }]',
    )
  }

  const PLATFORM_IDS = ['harmony', 'android', 'ios']
  const checkoutRoot = expandHome(raw.checkoutRoot?.trim?.() || '~/.qq-bot/checkouts')
  const repos = raw.repos.map((r, i) => {
    // id 是内部标识，建出来就不再变（路径都按它派生）；name 才是给人看的，
    // 可以随时改。id 缺省时生成一个随机的。
    const id = String(r.id ?? `r${Math.random().toString(36).slice(2, 10)}`)
    const name = String(r.name ?? r.id ?? `项目${i + 1}`)
    // 配 git 链接就够了：本地目录由 bot 克隆出来，不要求每台机器先手动 clone。
    // path 仍然认（老配置、或指向一个已有的本地仓库），两者都没有就报错。
    const url = typeof r.url === 'string' && r.url.trim() ? r.url.trim() : null
    const path = r.path ? resolve(expandHome(r.path)) : url ? join(checkoutRoot, id) : null
    if (!path) throw new Error(`repos 里的 ${id} 既没有 url 也没有 path`)
    return {
      id,
      name,
      url,
      path,
      // 兼容旧字段；真正的项目选择由需求内容决定，这里只是列表顺序
      primary: i === 0,
      // 平台是仓库属性，不是全局属性：同一个团队里鸿蒙、安卓仓库并存很正常
      platform: PLATFORM_IDS.includes(r.platform) ? r.platform : (raw.platform ?? 'harmony'),
    }
  })

  for (const r of repos) {
    // 配了 url 的还没克隆也算合法；只有纯本地路径才要求必须存在
    if (!r.url && (!r.path || !existsSync(r.path))) {
      throw new Error(`repos 里的 ${r.id} 路径不存在：${r.path}`)
    }
  }

  // 第一个仓库只用于兜底（实例标识、日志），不再代表「默认项目」
  const primaryRepo = repos[0]
  // projectDir 是从 repos 派生的，不是独立配置项：下游大量代码按单仓库写，
  // 主仓库的路径就继续叫这个名，省得全项目改一遍。
  const projectDir = primaryRepo.path

  // 每个仓库一套裸仓库与工作区根目录。单仓库沿用原来的固定路径
  // （~/.qq-bot/repo.git、~/.qq-bot/worktrees），不破坏已经跑起来的数据；
  // 多仓库按 id 分目录，互不干扰。
  const single = repos.length === 1
  const repoBase = expandHome(raw.repoDir?.trim?.() || '~/.qq-bot/repo.git')
  const wtBase = expandHome(raw.worktreeRoot?.trim?.() || '~/.qq-bot/worktrees')
  const reposRoot = join(dirname(repoBase), 'repos')
  const wtRoot = dirname(wtBase)
  for (const r of repos) {
    r.repoDir = single ? repoBase : join(reposRoot, `${r.id}.git`)
    r.worktreeRoot = single ? wtBase : join(wtRoot, `${r.id}`)
  }
  // 主仓库还没克隆时不做目录校验（第一次用到会 clone）；配了 url 就合法
  if (primaryRepo.url && !existsSync(projectDir)) {
    // 交给 ensureCheckout
  } else if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    throw new Error(`主仓库路径不存在或不是目录：${projectDir}`)
  }

  return {
    ...raw,
    configPath: path,
    repoRoot: REPO_ROOT,
    projectDir,
    repos,
    primaryRepo,
    checkoutRoot,
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
      // 群级可以指向另一个已配置的仓库（不同群服务不同产品线），
      // 但必须出现在 repos 里——不允许凭空多出一个仓库
      projectDir: g.repo
        ? (repos.find((r) => r.id === String(g.repo))?.path ??
          (() => {
            throw new Error(`群 ${g.groupId} 指定了未配置的仓库：${g.repo}`)
          })())
        : g.projectDir
          ? resolve(expandHome(g.projectDir))
          : projectDir,
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
    // 默认平台：仓库自己没写 platform 时用它；各仓库以自己的为准
    platform: ['harmony', 'android', 'ios'].includes(raw.platform) ? raw.platform : 'harmony',
    devices: Array.isArray(raw.devices) ? raw.devices : [],
    // 工具按平台分组：同一个团队鸿蒙、安卓并存时，两套工具路径不一样。
    // 老的扁平写法（tools.hdc）自动归到 harmony，不破坏已有配置。
    tools: {
      harmony: {
        hdc: pick(raw.tools?.harmony?.hdc, raw.tools?.hdc, 'hdc'),
      },
      android: {
        adb: pick(raw.tools?.android?.adb, raw.tools?.adb, 'adb'),
        bin: pick(raw.tools?.android?.bin, raw.tools?.emulator, 'emulator'),
        avdmanager: pick(raw.tools?.android?.avdmanager, raw.tools?.avdmanager, 'avdmanager'),
        sdkHome: pick(raw.tools?.android?.sdkHome, raw.tools?.sdkHome, null),
      },
      ios: {
        xcrun: pick(raw.tools?.ios?.xcrun, raw.tools?.xcrun, 'xcrun'),
      },
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
