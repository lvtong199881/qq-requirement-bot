/**
 * 选项文案的唯一出处。
 *
 * agent 常常自己就在选项文字里写了「（推荐）」，服务端再拼一次就成
 * 「（推荐）（推荐）」——真机卡上出现过，一眼就是 bug。这里统一去重：
 * 标了 recommended 才拼，且拼之前先把文字末尾重复的标记摘掉。
 *
 * 放在独立小文件里是因为 flow-bridge（卡片）和 board（面板看板）都要用，
 * 让 board 反过来 import flow-bridge 会形成循环依赖。
 */
export function optionLabel(text, recommended = false) {
  const body = String(text ?? '').trim()
  // 没标 recommended 就原样返回：文字里的「推荐」是 agent 唯一的表态，别吞掉。
  if (!recommended) return body
  return `${body.replace(/[（(]\s*推荐\s*[）)]$/, '').trim()}（推荐）`
}
