export type MessageChoice = { label: string; title: string; text: string }
export type ParsedMessageChoices = { intro: string; question: string; options: MessageChoice[]; trailing: string }

export function isCustomChoice(text: string): boolean {
  return /^(?:我有)?(?:别的|其他)(?:想法|方向|选择)[。！!]?$/u.test(text.trim())
}

export function choiceTitle(text: string): string {
  const plain = text.replace(/[*#`]/g, '').trim()
  const heading = plain.match(/^([^：:\n]{1,36})[：:]/)?.[1]
  if (heading) return heading.trim()
  const sentence = plain.split(/[。\n]/)[0] || plain
  return sentence.length > 64 ? `${sentence.slice(0, 64)}…` : sentence
}

export function parseMessageChoices(text: string): ParsedMessageChoices | null {
  const trimmed = text.trim()
  const source = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] || trimmed
  let value: unknown
  try { value = JSON.parse(source) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const payload = value as Record<string, unknown>
  if (payload.kind !== 'choices' || typeof payload.question !== 'string' || !payload.question.trim() || !Array.isArray(payload.options)) return null
  const options = payload.options.flatMap((entry, index): MessageChoice[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const option = entry as Record<string, unknown>
    if (typeof option.text !== 'string' || !option.text.trim()) return []
    const text = option.text.trim()
    const label = typeof option.id === 'string' && option.id.trim() ? option.id.trim() : String(index + 1)
    const title = typeof option.title === 'string' && option.title.trim() ? option.title.trim().slice(0, 80) : choiceTitle(text)
    return [{ label, title, text }]
  })
  if (options.length < 2 || options.length > 8 || new Set(options.map(option => option.label)).size !== options.length) return null
  return {
    question: payload.question.trim(), options,
    intro: typeof payload.intro === 'string' ? payload.intro.trim() : '',
    trailing: typeof payload.trailing === 'string' ? payload.trailing.trim() : '',
  }
}
