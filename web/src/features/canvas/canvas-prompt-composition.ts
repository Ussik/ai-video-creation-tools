import { extractPromptBody } from '@video-studio/shared/visuals/prompt-document'
import { VISUAL_BOARD_PRIMARY_SECTION } from '@video-studio/shared/visuals/visual-board-document'
import { rebasePromptDraft } from './canvas-prompt-draft'
import { isPromptSectionDocument, parsePromptSectionDocument, serializePromptSectionDocument, type PromptSectionBlock, type PromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'

const boardSeparatorPrefix = 'visual-board-editor-separator-'

/** Reorder the one editable board task, preserving every authored character and
 * source identity. The editor uses this same order for display, copy and save. */
export function visualBoardEditorDocument(document: PromptSectionDocument): PromptSectionDocument {
  const primaries = document.blocks.filter(block => block.kind === 'managed' && !block.deleted && block.name === VISUAL_BOARD_PRIMARY_SECTION)
  if (primaries.length !== 1) return document
  const primary = primaries[0]!
  // A serialized/parsed editor document can merge adjacent body segments. Once
  // its visible order is correct, do not move structural auxiliary separators
  // into the supplement again or add blank lines on every parent echo.
  if (document.blocks[0] === primary) {
    let auxiliary = false
    const alreadyOrdered = document.blocks.slice(1).every(block => {
      if (block.kind === 'managed' && !block.deleted) auxiliary = true
      return block.kind !== 'body' || !block.text.trim() || !auxiliary
    })
    if (alreadyOrdered) return document
  }
  const bodies = document.blocks.filter(block => block.kind === 'body')
  const auxiliaries = document.blocks.filter(block => block.kind === 'managed' && block !== primary)
  const blocks: PromptSectionBlock[] = [primary]
  const reserved = new Set(document.blocks.map(block => block.id))
  let sequence = 1, serialized = primary.text
  const addGroup = (group: PromptSectionBlock[]) => {
    const text = group.filter(block => !block.deleted).map(block => block.text).join('')
    if (text) {
      const trailing = serialized.match(/\n*$/)![0].length
      const leading = text.match(/^\n*/)![0].length
      const missing = Math.max(0, 2 - trailing - leading)
      if (missing && serialized) {
        let id: string
        do { id = `${boardSeparatorPrefix}${sequence++}` } while (reserved.has(id))
        reserved.add(id)
        const separator: PromptSectionBlock = { id, kind: 'body', text: '\n'.repeat(missing) }
        blocks.push(separator); serialized += separator.text
      }
    }
    blocks.push(...group); serialized += text
  }
  addGroup(bodies)
  for (const block of auxiliaries) addGroup([block])
  return { ...document, blocks }
}

/** An authored document owns its identities; deleted sections are not candidates
 * for matching new content that happens to have the same section name. */
export function canvasPromptSectionDocument(value: string, options: {
  previousDocument?: PromptSectionDocument; sourceText?: string
} = {}): PromptSectionDocument {
  const previous = isPromptSectionDocument(options.previousDocument) ? options.previousDocument : undefined
  if (!previous) return parsePromptSectionDocument(value, { sourceText: options.sourceText })
  if (serializePromptSectionDocument(previous) === value) return previous
  const deleted = previous.blocks.filter(block => block.kind === 'managed' && block.deleted)
  const active = previous.blocks.filter(block => !deleted.includes(block))
  const next = parsePromptSectionDocument(value, { previousDocument: { ...previous, blocks: active }, sourceText: options.sourceText })
  const previousById = new Map(active.map(block => [block.id, block]))
  const deletedIds = new Set(deleted.map(block => block.id))
  const reservedIds = new Set([...previous.blocks, ...next.blocks].map(block => block.id))
  for (const block of next.blocks) {
    // A pasted block can intentionally have no generated source. A legacy
    // template must not attach a removed section's baseline to that identity.
    const before = previousById.get(block.id)
    if (before && before.sourceText === undefined) delete block.sourceText
    if (!deletedIds.has(block.id)) continue
    let number = 1
    while (reservedIds.has(`authored-${block.kind}-${number}`)) number++
    block.id = `authored-${block.kind}-${number}`; reservedIds.add(block.id)
  }
  const survivingIds = new Set(next.blocks.map(block => block.id))
  for (const before of deleted) {
    const following = previous.blocks.slice(previous.blocks.indexOf(before) + 1)
      .find(block => !block.deleted && survivingIds.has(block.id))
    const index = following ? next.blocks.findIndex(block => block.id === following.id) : -1
    next.blocks.splice(index < 0 ? next.blocks.length : index, 0, { ...before })
  }
  return next
}

/** References have the same identity in authored text and its source snapshots. */
export function rewriteCanvasPromptSections(document: PromptSectionDocument | undefined, rewrite: (text: string) => string): PromptSectionDocument | undefined {
  if (!isPromptSectionDocument(document)) return undefined
  return { ...document, blocks: document.blocks.map(block => ({ ...block, text: rewrite(block.text),
    ...(block.sourceText !== undefined ? { sourceText: rewrite(block.sourceText) } : {}),
    ...(block.pendingSourceText !== undefined ? { pendingSourceText: rewrite(block.pendingSourceText) } : {}),
    ...(block.mergeBaseText !== undefined ? { mergeBaseText: rewrite(block.mergeBaseText) } : {}),
  })) }
}

/** Keep the latest authored body while controls and reference sections rebuild. */
export function canvasPromptBody(input: { prompt: string; prompt_body?: string; prompt_template?: string }, nextBody?: string): string {
  const body = extractPromptBody(input)
  if (!body.trim() || nextBody === undefined || !input.prompt_template) return body
  const previousBody = extractPromptBody({ prompt: input.prompt_template, prompt_template: input.prompt_template })
  return rebasePromptDraft(previousBody, body, nextBody)
}
