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

export function expandHome(p) {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/** 读 bot.config.json */
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
    limits: {
      maxMessagesPerMinute: raw.limits?.maxMessagesPerMinute ?? 10,
      // QQ 单条消息的实际上限约 4500 字（含转义余量），
      // 超出才拆条；正常情况下一条发完，别让用户收到 N 条。
      chunkChars: raw.limits?.chunkChars ?? 3000,
      maxChunksPerTurn: raw.limits?.maxChunksPerTurn ?? 4,
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
    turnTimeoutMs: raw.turnTimeoutMs ?? 45 * 60 * 1000,
    verbose: raw.verbose === true,
    // 本机环境提示：注入到每回合 prompt，避免 agent 靠猜（比如工具链不在 PATH）
    envHints: typeof raw.envHints === 'string' ? raw.envHints.trim() : '',
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
export function resolveApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY

  const file = join(homedir(), '.dsh', '.credentials.yaml')
  if (!existsSync(file)) return undefined

  const text = readFileSync(file, 'utf8')
  // 只取 refs 段里的 DEEPSEEK_API_KEY，避免误读 records 里的 token
  const refsIdx = text.search(/^refs:\s*$/m)
  const scope = refsIdx >= 0 ? text.slice(refsIdx) : text
  const m = scope.match(/^\s+DEEPSEEK_API_KEY:\s*["']?([^\s"']+)["']?\s*$/m)
  return m?.[1]
}
