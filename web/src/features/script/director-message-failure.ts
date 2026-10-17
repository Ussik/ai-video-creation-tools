import type { ScriptExecution } from './director-activity'

type Reply = { role: 'assistant' | 'user'; text: string; pending?: boolean; failed?: boolean; has_reply_text?: boolean; execution?: ScriptExecution }

/** Keep the stored text intact, including partial output and legacy failures.
 * Only presentation separates the diagnostic from the actual reply. */
export function directorMessageFailure(message: Reply) {
  const outcome = message.execution?.outcome
  if (message.role !== 'assistant' || message.pending || outcome?.kind === 'cancelled') return null
  const marker = [...message.text.matchAll(/(?:^|\n\n)对话失败[：:][ \t]*/g)].at(-1)
  if (!message.failed && outcome?.kind !== 'failed' && marker?.index !== 0) return null
  if (marker) return { body: message.text.slice(0, marker.index).trimEnd(), detail: message.text.slice(marker.index! + marker[0].length).trim() }
  if (!outcome && /(?:^|\n\n)已停止生成[。]?\s*$/.test(message.text)) return null
  if (message.has_reply_text && outcome?.summary) return { body: message.text, detail: outcome.summary }
  return { body: '', detail: message.text.trim() || outcome?.summary || '本轮尚未返回完整结果，请检查已有草稿后继续。' }
}

export function directorFailureText(message: Pick<Reply, 'text' | 'has_reply_text'>, reason: string) {
  const detail = reason.replace(/^对话失败[：:][ \t]*/, '')
  const failure = `对话失败：${detail}`
  const text = message.text.trimEnd()
  return text && (message.has_reply_text || !/^正在/.test(text)) && text !== failure && text !== detail ? `${text}\n\n${failure}` : failure
}
