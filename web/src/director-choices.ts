import { readDirectorInteraction, type DirectorInteraction } from './script-workflow'

export type MessageChoice = { label: string; title: string; text: string; kind?: 'direction' | 'custom'; requires_details?: boolean }
export type InputField = { id: string; label: string; suggestions?: string[] }
export type ParsedMessageChoices = { intro: string; question: string; options: MessageChoice[]; trailing: string; fields?: InputField[]; confirmation?: boolean;
  questions?: Array<ParsedMessageChoices & { id: string }>; interaction?: DirectorInteraction }

export function confirmationChoices(question: string): MessageChoice[] {
  return [{ label: 'agree', title: '同意', text: `同意：${question}。按上述提议推进，沿用已确认的设定。` },
    { label: 'adjust', title: '需要调整', text: `暂不按上述提议推进：${question}。请继续讨论需要调整的部分，不开始文档生成。` }]
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
  const parsedInteraction = readDirectorInteraction(payload.interaction)
  const metadata = parsedInteraction ? { interaction: parsedInteraction } : {}
  if (typeof payload.question !== 'string' || !payload.question.trim()) return null
  if (payload.kind === 'confirmation') return { ...metadata, question: payload.question.trim(), confirmation: true, options: confirmationChoices(payload.question.trim()),
    intro: typeof payload.intro === 'string' ? payload.intro.trim() : '', trailing: typeof payload.trailing === 'string' ? payload.trailing.trim() : '' }
  if (payload.kind === 'question_set') {
    if (!Array.isArray(payload.questions) || payload.questions.length < 2 || payload.questions.length > 4) return null
    const questions: Array<ParsedMessageChoices & { id: string }> = []
    for (const raw of payload.questions) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const item = raw as Record<string, unknown>
      if (!['confirmation', 'choices', 'input_request'].includes(String(item.kind)) || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 80) return null
      const parsed = parseMessageChoices(JSON.stringify(item))
      if (!parsed) return null
      questions.push({ ...parsed, id: item.id.trim() })
    }
    if (new Set(questions.map(item => item.id)).size !== questions.length) return null
    return { ...metadata, question: payload.question.trim(), questions, options: [], intro: typeof payload.intro === 'string' ? payload.intro.trim() : '', trailing: typeof payload.trailing === 'string' ? payload.trailing.trim() : '' }
  }
  if (payload.kind === 'input_request') {
    if (!Array.isArray(payload.fields) || payload.fields.length < 1 || payload.fields.length > 4) return null
    const fields: InputField[] = []
    for (const raw of payload.fields) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const field = raw as Record<string, unknown>
      if (typeof field.id !== 'string' || !field.id.trim() || field.id.length > 80 || typeof field.label !== 'string' || !field.label.trim() || field.label.length > 100) return null
      if (field.suggestions !== undefined && (!Array.isArray(field.suggestions) || field.suggestions.length > 8 || field.suggestions.some(s => typeof s !== 'string' || !s.trim() || s.length > 80))) return null
      fields.push({ id: field.id.trim(), label: field.label.trim(), ...(Array.isArray(field.suggestions) ? { suggestions: field.suggestions.map(s => (s as string).trim()) } : {}) })
    }
    if (new Set(fields.map(field => field.id)).size !== fields.length) return null
    return { ...metadata, question: payload.question.trim(), fields, options: [], intro: typeof payload.intro === 'string' ? payload.intro.trim() : '', trailing: typeof payload.trailing === 'string' ? payload.trailing.trim() : '' }
  }
  if (payload.kind !== 'choices' || !Array.isArray(payload.options)) return null
  const options = payload.options.flatMap((entry, index): MessageChoice[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const option = entry as Record<string, unknown>
    if (typeof option.text !== 'string' || !option.text.trim()) return []
    const text = option.text.trim()
    const label = typeof option.id === 'string' && option.id.trim() ? option.id.trim() : String(index + 1)
    const title = typeof option.title === 'string' && option.title.trim() ? option.title.trim().slice(0, 80) : choiceTitle(text)
    return [{ label, title, text, ...(option.kind === 'custom' ? { kind: 'custom' as const } : {}), ...(option.requires_details === true ? { requires_details: true } : {}) }]
  })
  if (options.length < 2 || options.length > 8 || new Set(options.map(option => option.label)).size !== options.length) return null
  return {
    ...metadata,
    question: payload.question.trim(), options,
    intro: typeof payload.intro === 'string' ? payload.intro.trim() : '',
    trailing: typeof payload.trailing === 'string' ? payload.trailing.trim() : '',
  }
}
