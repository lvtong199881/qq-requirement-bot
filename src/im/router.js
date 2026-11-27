/**
 * IM 的对话路由：一条消息到底归谁处理。
 *
 * 拆分背景：IM（聊天 + 账号 + 消息）要能独立部署，需求引擎（dsh 编排）
 * 只是它的一个可选客户端。所以必须有一条明确的规则说清「哪些消息发给
 * 引擎」，否则在群里闲聊也会被当成需求描述、直接 spawn 一个 agent 跑
 * 半个小时——这正是拆分前的行为。
 *
 * 规则来自旧 QQ 流程（ad92147 之前）：只有 @ 了需求 bot 的那句话才归 agent。
 * 这里把 @ 一路贯彻到底——需求群里也不豁免。同一个群平时也在聊别的事，
 * 全转过去等于让 agent 把无关的话当需求上下文吃进去，一句「嗯」也可能
 * 触发一轮真金白银的回合。要不要让它听见，永远由说话的人用 @ 说清楚。
 */

import { BOT_USER_ID } from '../account/store.js'

/** 机器人在群成员列表里的 id——就是它的用户账号 id，不是另造的标记 */
export const BOT_ID = BOT_USER_ID

/** 默认的 bot 名字，config.bot?.name 可以覆盖。App 拿到这个名字再拼「@名字」 */
export const DEFAULT_BOT_NAME = 'AI员工'

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 收集「这条消息提到了谁」。
 *
 * App 会显式带 mentions（点按钮插入的），但手打「@名字」的也要认：
 * 网页端、curl、以及用户习惯性手打都在这一条路径上，认不出来就等于
 * 需求发不出去，还不会有任何报错。
 *
 * 只认当前昵称：名字从机器人账号读出来，改名后就该只认新的。旧名字继续
 * 生效等于「改个显示名」并不能真正换掉触发词，用户改了名还会被老的 @ 命中。
 */
export function mentionsOf({ mentions, text, botName = DEFAULT_BOT_NAME } = {}) {
  const out = new Set()
  for (const m of Array.isArray(mentions) ? mentions : []) {
    const id = String(m ?? '').trim()
    // 老客户端/老脚本里写的是 'bot' 这个占位符，映射到机器人的账号 id
    if (id) out.add(id === 'bot' ? BOT_ID : id)
  }
  if (typeof text === 'string') {
    for (const name of botNames(botName)) {
      if (text.includes(`@${name}`)) {
        out.add(BOT_ID)
        break
      }
    }
  }
  return [...out]
}

/** 能被 @ 到的名字：机器人账号当前的昵称，没配就用默认名 */
function botNames(botName) {
  const name = String(botName ?? '').trim()
  return [name || DEFAULT_BOT_NAME]
}

/**
 * 决定这条消息的归宿。
 *
 *   chat    纯聊天，IM 自己留着，不惊动引擎
 *   message @ 了 bot 的话，转给引擎（回答、补充、拍板、「继续」都走这条）
 *
 * 判据只有一条：**有没有 @ bot**。群里同时在聊别的事（谁去拿快递、这个
 * 按钮位置要不要换），全转给引擎就等于 agent 把无关的话当需求上下文吃进去；
 * 而且一句「嗯」也可能触发一轮真金白银的回合。所以要不要让 agent 听见，
 * 永远由说话的人用 @ 明确表示。
 *
 * 起需求不在这条路上：那是 App 的「新需求」弹窗（POST /api/requirements），
 * 仓库由弹窗显式选，不靠需求文本猜。
 */
export function routeMessage({ mentions = [] } = {}) {
  const atBot = (Array.isArray(mentions) ? mentions : []).includes(BOT_ID)
  if (!atBot) return { action: 'chat', atBot: false }
  return { action: 'message', atBot: true }
}

/**
 * 去掉文本里的 @ 名字。
 *
 * 需求名和需求描述都会被这句话带着走（makeReqName 取前 30 字），
 * 留着「@AI员工」会让每个需求的标题都以它开头。
 */
export function stripBotMention(text, botName = DEFAULT_BOT_NAME) {
  let out = String(text ?? '')
  for (const name of botNames(botName)) {
    out = out.replace(new RegExp(`@${escapeRe(name)}`, 'g'), ' ')
  }
  return out.replace(/\s+/g, ' ').trim()
}
