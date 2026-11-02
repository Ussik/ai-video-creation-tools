import { managedPromptBlockNames, stripManagedPromptBlocks } from './prompt-document.js'
import { parsePromptSectionDocument, type PromptSectionDocument } from './prompt-section-document.js'

/** Keep the persisted marker stable while the editor presents this as the main task. */
export const VISUAL_BOARD_PRIMARY_SECTION = '设定图固定要求' as const

export type VisualBoardPromptParts = {
  primary: string[]
  supplement: string
  context: string[]
}

/** Only complete, active sections in the serialized document are authoritative. */
export function visualBoardPromptParts(document: string): VisualBoardPromptParts {
  const sections = parsePromptSectionDocument(document).blocks.filter(block => block.kind === 'managed' && !block.deleted)
  const opening = `【${VISUAL_BOARD_PRIMARY_SECTION}】`
  const ending = `【${VISUAL_BOARD_PRIMARY_SECTION}结束】`
  return {
    primary: sections.filter(block => block.name === VISUAL_BOARD_PRIMARY_SECTION)
      .map(block => block.text.slice(opening.length, -ending.length).trim()),
    supplement: stripManagedPromptBlocks(document),
    context: sections.filter(block => block.name !== VISUAL_BOARD_PRIMARY_SECTION).map(block => block.text),
  }
}

/** Reference, style and generation-parameter sections cannot stand in for a creative task. */
export function hasVisualBoardPromptContent(document: string): boolean {
  const { primary, supplement } = visualBoardPromptParts(document)
  return primary.some(content => content.trim().length > 0) || supplement.trim().length > 0
}

/** Complete saved documents without a primary have deliberately omitted it.
 * Older drafts may lack the tombstone metadata needed by source reconciliation. */
export function preserveAbsentVisualBoardPrimary(document: PromptSectionDocument, nextTemplate: string): PromptSectionDocument {
  if (document.blocks.some(block => block.kind === 'managed' && block.name === VISUAL_BOARD_PRIMARY_SECTION)) return document
  const primary = parsePromptSectionDocument(nextTemplate).blocks.filter(block => block.kind === 'managed'
    && !block.deleted && block.name === VISUAL_BOARD_PRIMARY_SECTION)
  if (!primary.length) return document
  const reserved = new Set(document.blocks.map(block => block.id))
  let sequence = 1
  const tombstones = primary.map(block => {
    let id: string
    do { id = `managed-visual-board-primary-${sequence++}` } while (reserved.has(id))
    reserved.add(id)
    return { ...block, id, text: '', sourceText: block.text, deleted: true }
  })
  return { ...document, blocks: [...document.blocks, ...tombstones] }
}

/** Apply a reviewed main task without rebuilding any saved context from project facts. */
export function replaceVisualBoardPromptContent(document: string, content: string): string {
  const sections = parsePromptSectionDocument(document).blocks.filter(block => block.kind === 'managed' && !block.deleted)
  const primary = sections.filter(block => block.name === VISUAL_BOARD_PRIMARY_SECTION)
  if (primary.length > 1) throw new Error('存在多个设定图内容区块，请先明确要整理的区块')
  if (new RegExp(`【(?:${managedPromptBlockNames.join('|')})(?:结束)?】`).test(content)) {
    throw new Error('设定图内容不能包含系统区块标记，请仅提供内容正文')
  }
  if (!primary.length) return [content, ...sections.map(block => block.text)].filter(Boolean).join('\n\n')
  return sections.map(block => block.name === VISUAL_BOARD_PRIMARY_SECTION
    ? `【${VISUAL_BOARD_PRIMARY_SECTION}】\n${content}\n【${VISUAL_BOARD_PRIMARY_SECTION}结束】`
    : block.text).join('\n\n')
}
