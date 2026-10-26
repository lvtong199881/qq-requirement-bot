/**
 * 群内指令：让用户在极端情况下能直接操作整个需求，不用靠自然语言猜。
 *
 * 白名单机制：每条指令声明 scope。标 admin 的只有 adminUsers 里的人能执行，
 * 后续加危险操作（清库、改配置）直接标 admin 即可，不用改分发逻辑。
 */

/** 指令表。desc 用于 /help，scope 决定谁能用 */
import { renderMessage } from './messages.js'

export const COMMANDS = {
  help: {
    desc: '查看所有可用指令',
    scope: 'user',
  },
  resume: {
    desc: '继续推进当前需求',
    scope: 'user',
  },
  stop: {
    desc: '停止当前正在跑的任务',
    scope: 'user',
  },
  release: {
    desc: '释放当前会话与进程（会丢失本回合上下文）',
    scope: 'admin',
    confirm: true,
  },
}

/**
 * 解析指令。不是指令返回 null。
 * @param {string} text 已去掉 @ 的正文
 * @returns {null | {name: string, arg: string, unknown?: boolean, def?: object}}
 */
export function parseCommand(text) {
  const t = (text ?? '').trim()
  if (!t.startsWith('/')) return null
  const body = t.slice(1).trim()
  if (!body) return { name: '', arg: '', def: null, unknown: true }

  const [rawName, ...rest] = body.split(/\s+/)
  const name = rawName.toLowerCase()
  const def = COMMANDS[name]
  return {
    name,
    arg: rest.join(' ').trim(),
    def: def ?? null,
    unknown: !def,
  }
}

/**
 * 生成 /help 的回复正文。标出哪些指令需要管理员。
 * @param {{isAdmin: boolean, state?: object, stages?: Array}} o
 */
export function helpText({ isAdmin, statusLine, templates }) {
  const list = Object.entries(COMMANDS)
    .map(([name, def]) => `/${name}${def.scope === 'admin' ? '（管理员）' : ''}  ${def.desc}`)
    .join('\n')

  return renderMessage(
    'help',
    {
      list,
      statusLine: statusLine ? `\n\n${statusLine}` : '',
      permissionNote: '只有群主和群管理员能让 bot 干活，其他成员的 @ 会被静默忽略。',
    },
    templates,
  )
}

/** /release 的二次确认文案 */
export function releaseConfirmText({ reqId, stage, templates }) {
  return renderMessage(
    'releaseAsk',
    {
      target: reqId ? `「${reqId}」` : '当前需求',
      stage: stage || '当前',
    },
    templates,
  )
}

/** 指令权限不足时的提示 */
export function deniedText(name, templates) {
  return renderMessage('denied', { cmd: name }, templates)
}
