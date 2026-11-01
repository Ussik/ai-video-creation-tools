export interface VideoPromptIssue {
  code: string
  severity: 'warning' | 'error'
  message: string
  suggestion: string
}
export interface VideoPromptContentReview {
  primary_action: string
  secondary_actions: string[]
  start_state: string
  end_state: string
  visible_result: string
  facts: Array<{ fact: string; status: 'preserved' | 'changed' | 'missing' | 'uncertain'; evidence: string }>
  issues: VideoPromptIssue[]
  reference_findings: Array<{ image_number: number; observation: string; suggestion: string }>
}
export interface VideoPromptDiagnostics {
  generation_duration: number | null
  edit_duration: number | null
  dialogue: { source: string[]; missing: string[]; explicit_change: boolean }
  references: { mode: 'pixels' | 'text_only'; inspected_asset_ids: string[]; omitted_asset_ids: string[] }
  content_review: VideoPromptContentReview | null
  issues: VideoPromptIssue[]
}

/** Only spoken quotes are protected. Titles, quoted directions and UI labels
 * are not dialogue. The current editable draft, rather than an old shot prompt,
 * is the source of truth. */
export function spokenDialogue(text: string): string[] {
  const result: string[] = []
  const pattern = /(?:说|喊|问|答|叫|念|嘀咕|低语|对白|台词|旁白|画外音)[^。！？\n“”"「」]{0,24}[“"「]([^”"」\n]{1,1000})[”"」]/g
  for (const match of text.matchAll(pattern)) if (!result.includes(match[1]!)) result.push(match[1]!)
  return result
}
export function dialoguePreservation(source: string, candidate: string, adjustment = ''): VideoPromptDiagnostics['dialogue'] {
  const quotes = spokenDialogue(source)
  const negated = /(?:不要|不得|不能|不可|不许|不必|无需|无须|不|勿|别|禁止|避免)(?:再|随意|擅自|任意|去)?$/
  // Sentence punctuation inside an exact quoted line belongs to the quote.
  const clauses = adjustment.match(/(?:“[^”]*”|"[^"]*"|「[^」]*」|[^。！？；;\n，,])+/g) || []
  const explicit_change = clauses.some(clause => {
    if (/(?:不要|不保留|不需要|不再保留)(?:本镜|这句|任何|原有|原|现有)?的?(?:对白|台词|旁白|画外音)/.test(clause)) return true
    const actions = /删除|删掉|去掉|移除|取消|改写|替换|修改|调整|重写|改为|改成/g
    for (const match of clause.matchAll(actions)) {
      const before = clause.slice(0, match.index), after = clause.slice(match.index! + match[0].length)
      if (negated.test(before)) continue
      const object = /^(?:(?:本镜|这句|当前|原有|原|已有|现有|全部|所有|整段|既有|的|任何|一些|部分|一下|一段))*(?:对白|台词|旁白|画外音)/.test(after)
      const subject = /(?:对白|台词|旁白|画外音)(?:(?:全部|都|的措辞|的内容|内容|措辞|文字|部分|请|需要|可以|要|应|将|被))*$/.test(before)
      if (object || subject || quotes.some(quote => before.endsWith(quote) || before.endsWith(`${quote}”`)
        || before.endsWith(`${quote}"`) || after.includes(quote))) return true
    }
    return false
  })
  const targeted = quotes.some(quote => adjustment.includes(quote)) && !/(?:全部|所有|整段)(?:的)?(?:对白|台词|旁白|画外音)/.test(adjustment)
  // A request to change one quoted line does not authorize losing other lines.
  const missing = quotes.filter(quote => !candidate.includes(quote)
    && !(explicit_change && (!targeted || adjustment.includes(quote))))
  return { source: quotes, missing, explicit_change }
}
