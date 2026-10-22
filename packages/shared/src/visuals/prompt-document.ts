export const managedPromptBlockNames = ['镜头视觉设定', '图片参考图用途', '视频参考图用途', '项目画风约束', '图片生成要求', '视频生成要求',
  '基础身份参考', '设定图固定要求', '生成参数约束', '基础版本与本次状态变化', '生成参考图'] as const
const managedBlocks = managedPromptBlockNames
export type ManagedPromptBlockName = typeof managedBlocks[number]
const legacyVisualEnding = '保持上述对象的外观、比例、服装、材质与空间关系。只生成当前镜头的一幅完整画面或连续视频；不要复制设定板的多视角拼版、文字、标签或色板。'

/** Known section markers must remain paired before any rewrite protects them. */
export function validateManagedPromptDocument(document: string): void {
  let open: string | undefined
  for (const match of document.matchAll(new RegExp(`【(${managedBlocks.join('|')})(结束)?】`, 'g'))) {
    const name = match[1]!
    if (!match[2]) {
      if (open) throw new Error(`提示词系统区不支持嵌套：请先补全【${open}结束】`)
      open = name
    } else {
      if (open !== name) throw new Error(`提示词系统区标记不匹配：请核对【${name}】与【${name}结束】`)
      open = undefined
    }
  }
  if (open) throw new Error(`提示词系统区尚未结束：请补全【${open}结束】`)
}

export type ManagedPromptStripOptions = {
  /** Saved generated templates are evidence for the exact old, unbounded block. */
  legacyVisualTemplates?: string[]
  legacyTemplates?: string[]
  /** Callers rebuilding one layer must preserve other managed layers. */
  blockNames?: ManagedPromptBlockName[]
}

type ManagedPromptSection = { name: ManagedPromptBlockName; start: number; end: number; text: string }
function managedPromptSections(prompt: string): ManagedPromptSection[] {
  const sections: ManagedPromptSection[] = []
  for (const name of managedBlocks) for (const match of prompt.matchAll(new RegExp(`【${name}】[\\s\\S]*?【${name}结束】`, 'g'))) {
    sections.push({ name, start: match.index!, end: match.index! + match[0].length, text: match[0] })
  }
  // A nested heading is authored content of its enclosing section, not a
  // second independent block that can be duplicated during composition.
  return sections.sort((left, right) => left.start - right.start || right.end - left.end)
    .filter((section, index, sorted) => !sorted.slice(0, index).some(previous => previous.start <= section.start && previous.end >= section.end))
}

/** Restore the creator's exact sections after rewriting only the surrounding prose. */
export function restoreManagedPromptBlocks(body: string, document: string): string {
  if (body === stripManagedPromptBlocks(document)) return document
  const prose = stripManagedPromptBlocks(body)
  return [prose, ...managedPromptSections(document).map(section => section.text)].filter(Boolean).join('\n\n')
}

/** Update generated sections only while the creator has left their text intact. */
export function composeEditedPromptDocument(input: {
  document: string; previousTemplate?: string; nextTemplate: string; body?: string
}): string {
  // Keystrokes can temporarily remove an end marker. Do not treat that edit
  // as missing generated sections and append duplicates while typing.
  try { validateManagedPromptDocument(input.document) } catch { return input.document }
  const previous = managedPromptSections(input.previousTemplate || '')
  const next = managedPromptSections(input.nextTemplate)
  const counts = new Map<ManagedPromptBlockName, number>()
  const current = managedPromptSections(input.document)
  let cursor = 0, document = ''
  for (const section of current) {
    const occurrence = counts.get(section.name) || 0
    counts.set(section.name, occurrence + 1)
    const before = previous.filter(item => item.name === section.name)[occurrence]
    const after = next.filter(item => item.name === section.name)[occurrence]
    const replacement = before?.text === section.text ? after?.text || '' : section.text
    const separatorStart = !replacement && input.document.slice(section.start - 2, section.start) === '\n\n' ? section.start - 2 : section.start
    document += input.document.slice(cursor, Math.max(cursor, separatorStart)) + replacement
    cursor = section.end
  }
  document += input.document.slice(cursor)
  for (const section of next) {
    // An absent old section was deliberately removed. Only newly introduced
    // template layers may be added, and never replace a creator's own layer.
    if (!previous.some(item => item.name === section.name) && !current.some(item => item.name === section.name)) {
      document += `${document ? '\n\n' : ''}${section.text}`
    }
  }
  return input.body === undefined || input.body === stripManagedPromptBlocks(document)
    ? document : restoreManagedPromptBlocks(input.body, document)
}

/** Return complete managed blocks without their surrounding body separators. */
export function getManagedPromptBlocks(prompt: string, names: ManagedPromptBlockName[] = [...managedBlocks]): string[] {
  const blocks: Array<{ start: number; text: string }> = []
  for (const name of names) {
    for (const match of prompt.matchAll(new RegExp(`【${name}】[\\s\\S]*?【${name}结束】`, 'g'))) {
      blocks.push({ start: match.index!, text: match[0] })
    }
  }
  return blocks.sort((left, right) => left.start - right.start).map(block => block.text)
}

function removeExactBlock(prompt: string, block: string): string {
  let body = prompt, found = body.indexOf(block)
  while (found >= 0) {
    const from = found >= 2 && body.slice(found - 2, found) === '\n\n' ? found - 2 : found
    body = body.slice(0, from) + body.slice(found + block.length)
    found = body.indexOf(block)
  }
  return body
}

/** Remove explicitly bounded system blocks, preserving every character of body prose. */
export function stripManagedPromptBlocks(prompt: string, options: ManagedPromptStripOptions = {}): string {
  let body = prompt
  const names = options.blockNames || managedBlocks
  for (const name of names) {
    // Only the separator appended together with the block is removed. Never
    // consume trailing whitespace, which may introduce a creator's next line.
    body = body.replace(new RegExp(`(?:\\n\\n)?【${name}】[\\s\\S]*?【${name}结束】`, 'g'), '')
  }
  for (const template of [...(options.legacyVisualTemplates || []), ...(options.legacyTemplates || [])]) {
    const start = template.indexOf('【镜头视觉设定】')
    const end = template.indexOf(legacyVisualEnding, start)
    if (names.includes('镜头视觉设定') && start >= 0 && end >= 0 && template.indexOf('【镜头视觉设定结束】', start) < 0) {
      body = removeExactBlock(body, template.slice(start, end + legacyVisualEnding.length))
    }
    // Legacy parameter blocks consist only of known generated field lines.
    // A creator's following paragraph never becomes part of the match.
    const oldParameters: Array<[ManagedPromptBlockName, RegExp]> = [
      ['图片生成要求', /图片生成要求：\n(?:画面比例|清晰度要求|画质要求|背景要求)：[^\n]*(?:\n(?:画面比例|清晰度要求|画质要求|背景要求)：[^\n]*)*/g],
      ['视频生成要求', /【视频生成要求】\n视频时长：[^\n]*(?:\n(?:画面比例|清晰度要求|首帧要求)：[^\n]*)*/g],
    ]
    for (const [name, pattern] of oldParameters) {
      if (!names.includes(name) || template.includes(`【${name}结束】`)) continue
      for (const match of template.matchAll(pattern)) body = removeExactBlock(body, match[0])
    }
  }
  return body
}

/** An explicit body is authoritative; legacy final prompts need exact template evidence. */
export function extractPromptBody(input: { prompt: string; prompt_body?: string; prompt_template?: string }, options: ManagedPromptStripOptions = {}): string {
  return stripManagedPromptBlocks(input.prompt_body ?? input.prompt,
    { ...options, legacyTemplates: [...(options.legacyTemplates || []),
      ...(input.prompt_body === undefined && input.prompt_template ? [input.prompt_template] : [])] })
}
