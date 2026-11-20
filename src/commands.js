/**
 * 文本指令：让用户在极端情况下能直接操作整个需求，不用靠自然语言猜。
 *
 * 这套指令原本是给 QQ 群用的（那时唯一的输入方式是发消息），App 化之后
 * 依然留着：用户在对话框里打 /stop 比找按钮快，而且不需要给每个动作
 * 都在界面上开一个入口。
 *
 * 白名单机制：每条指令声明 scope。标 admin 的只有系统管理员能执行，
 * 后续加危险操作（清库、改配置）直接标 admin 即可，不用改分发逻辑。
 */

/** 指令表。desc 用于 /help，scope 决定谁能用 */
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
