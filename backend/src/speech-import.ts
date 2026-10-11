export interface SpeechSceneSource {
  id: string
  dialogue: string
  narration: string
}

export interface SpeechSceneEntry {
  name: string
  text: string
  instructions: string
  key: string
}

const maxLineCharacters = 5000
const unresolvedRole = '待分配角色'
const suffixCue = /[（(]([^（）()\r\n]{1,200})[）)]\s*$/
const prefixCue = /^[（(]([^（）()\r\n]{1,200})[）)]\s*/

function labelDelimiter(text: string): number {
  let parentheses = 0
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (character === '（' || character === '(') parentheses++
    else if (character === '）' || character === ')') parentheses = Math.max(0, parentheses - 1)
    else if ((character === '：' || character === ':') && parentheses === 0) return index
  }
  return -1
}

function speakerLabel(raw: string): { name: string; cues: string[] } | null {
  let name = raw.replace(/\*\*/g, '').trim()
  const cues: string[] = []
  let matched: RegExpExecArray | null
  while ((matched = suffixCue.exec(name))) {
    cues.unshift(matched[1]!.trim())
    name = name.slice(0, matched.index).trim()
  }
  if (!name || name.length > 40 || /[：:\r\n（）()]/.test(name)) return null
  return { name, cues }
}

function leadingCues(raw: string): { text: string; cues: string[] } {
  let text = raw
  const cues: string[] = []
  let matched: RegExpExecArray | null
  while ((matched = prefixCue.exec(text))) {
    cues.push(matched[1]!.trim())
    text = text.slice(matched[0].length)
  }
  return { text, cues }
}

function safeBoundary(text: string, max: number): number {
  let limit = max
  const before = text.charCodeAt(limit - 1), after = text.charCodeAt(limit)
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) limit--
  for (let index = limit - 1; index >= 0; index--) {
    const character = text[index]!
    if (!/[。！？!?；;\n]/.test(character) && !(character === '.' && /[\s”’"'」』]/.test(text[index + 1] || ''))) continue
    let end = index + 1
    while (end < limit && /[\s”’"'」』】）)]/.test(text[end]!)) end++
    return end
  }
  return limit
}

/** Split without truncating text or separating the two halves of a Unicode surrogate pair. */
function chunks(text: string): string[] {
  const result: string[] = []
  let offset = 0
  while (text.length - offset > maxLineCharacters) {
    const end = safeBoundary(text.slice(offset), maxLineCharacters)
    result.push(text.slice(offset, offset + end))
    offset += end
  }
  if (offset < text.length) result.push(text.slice(offset))
  return result
}

/** Only explicit speaker labels assign a role. Unlabeled continuation lines require user review. */
export function parseSpeechSceneEntries(scene: SpeechSceneSource): SpeechSceneEntry[] {
  const entries: SpeechSceneEntry[] = []
  const add = (name: string, text: string, cues: string[], key: string) => {
    const instructions = cues.filter(Boolean).join('；')
    for (const [index, part] of chunks(text).entries()) {
      entries.push({ name, text: part, instructions, key: `${key}:part:${index}` })
    }
  }
  for (const [index, raw] of scene.dialogue.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line) continue
    const candidate = line.replace(/^[-*+]\s+/, '')
    const colon = labelDelimiter(candidate)
    const label = colon >= 0 ? speakerLabel(candidate.slice(0, colon)) : null
    if (!label) {
      const performance = leadingCues(line)
      add(unresolvedRole, performance.text, performance.cues, `${scene.id}:dialogue:${index}`)
      continue
    }
    // Supports both **林晚**：台词 and **林晚：**台词 Markdown speaker labels.
    const markerCount = candidate.slice(0, colon).match(/\*\*/g)?.length || 0
    let rawText = candidate.slice(colon + 1).trim()
    if (markerCount % 2 === 1) rawText = rawText.replace(/^\*\*\s*/, '')
    const performance = leadingCues(rawText)
    add(label.name, performance.text, [...label.cues, ...performance.cues], `${scene.id}:dialogue:${index}`)
  }
  const narration = leadingCues(scene.narration.trim())
  add('旁白', narration.text, narration.cues, `${scene.id}:narration`)
  return entries
}
