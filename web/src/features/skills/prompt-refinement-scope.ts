import { extractPromptBody, managedPromptBlockNames, validateManagedPromptDocument, type ManagedPromptBlockName } from '@video-studio/shared/visuals/prompt-document'
import { serializePromptSectionDocument, type PromptSectionBlock, type PromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'
import { VISUAL_BOARD_PRIMARY_SECTION, visualBoardPromptParts } from '@video-studio/shared/visuals/visual-board-document'
import { canvasPromptSectionDocument } from '../canvas/canvas-prompt-composition'

export type PromptRefinementSource = {
  document: PromptSectionDocument
  content: string
  protectedNames: ManagedPromptBlockName[]
  visualBoard: boolean
  error: string
}

/** A refinement candidate owns creative prose only; current sections own context. */
export function promptRefinementContent(prompt: string, visualBoard: boolean): string {
  if (!visualBoard) return extractPromptBody({ prompt })
  const parts = visualBoardPromptParts(prompt)
  if (parts.primary.length > 1) throw new Error('存在多个设定图内容区块，请先明确要整理的区块。')
  return [...parts.primary, parts.supplement].map(value => value.trim()).filter(Boolean).join('\n\n')
}

export function promptRefinementSource(input: {
  prompt: string
  promptBody?: string
  promptTemplate?: string
  promptSections?: PromptSectionDocument
  visualBoard?: boolean
  promptDocument?: boolean
}): PromptRefinementSource {
  const document = canvasPromptSectionDocument(input.prompt, { previousDocument: input.promptSections, sourceText: input.promptTemplate })
  const visualBoard = !!input.visualBoard
  const protectedNames = [...new Set(document.blocks.filter(block => block.kind === 'managed' && !block.deleted
    && (!visualBoard || block.name !== VISUAL_BOARD_PRIMARY_SECTION)).map(block => block.name!))]
  try {
    validateManagedPromptDocument(input.prompt)
    const content = visualBoard ? promptRefinementContent(input.prompt, true)
      : extractPromptBody({ prompt: input.prompt, prompt_body: input.promptDocument === false ? input.promptBody : undefined, prompt_template: input.promptTemplate })
    return { document, content, protectedNames, visualBoard, error: '' }
  } catch (error) {
    return { document, content: '', protectedNames, visualBoard, error: error instanceof Error ? error.message : String(error) }
  }
}

export function promptRefinementContentError(content: string): string {
  return new RegExp(`【(?:${managedPromptBlockNames.join('|')})(?:结束)?】`).test(content)
    ? '草稿只能包含主要创作内容，请移除设定与生成要求的区块标记。' : ''
}

function boundaries(text: string): [string, string] {
  if (!text.trim()) return ['', text]
  return [text.match(/^\s*/)?.[0] || '', text.match(/\s*$/)?.[0] || '']
}

/** Replace only the editable content, retaining every current context identity. */
export function applyPromptRefinementContent(source: PromptRefinementSource, content: string): {
  prompt: string; body: string; document: PromptSectionDocument
} {
  if (source.error) throw new Error(source.error)
  const error = promptRefinementContentError(content)
  if (error) throw new Error(error)
  if (!content.trim()) throw new Error('主要创作内容不能为空。')
  const candidate = content.trim()
  const primary = source.visualBoard ? source.document.blocks.filter(block => block.kind === 'managed' && !block.deleted
    && block.name === VISUAL_BOARD_PRIMARY_SECTION) : []
  if (primary.length > 1) throw new Error('存在多个设定图内容区块，请先明确要整理的区块。')
  const bodies = source.document.blocks.filter(block => block.kind === 'body')
  const target = primary[0] || bodies.find(block => block.text.trim()) || bodies[0]
  let blocks: PromptSectionBlock[] = source.document.blocks.map(block => {
    if (block === primary[0]) return { ...block, text: `【${VISUAL_BOARD_PRIMARY_SECTION}】\n${candidate}\n【${VISUAL_BOARD_PRIMARY_SECTION}结束】` }
    if (block.kind !== 'body') return { ...block }
    const [leading, trailing] = boundaries(block.text)
    if (block === target) return { ...block, text: leading + candidate + trailing }
    return block.text.trim() ? { ...block, text: leading + trailing } : { ...block }
  })
  if (!target) {
    const reserved = new Set(blocks.map(block => block.id))
    let number = 1
    while (reserved.has(`refinement-body-${number}`)) number++
    blocks = [{ id: `refinement-body-${number}`, kind: 'body', text: candidate + (blocks.some(block => !block.deleted && block.text) ? '\n\n' : '') }, ...blocks]
  }
  const document: PromptSectionDocument = { ...source.document, blocks }
  const prompt = serializePromptSectionDocument(document)
  return { prompt, body: extractPromptBody({ prompt }), document }
}
