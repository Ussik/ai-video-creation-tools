import type { Editor } from '@tiptap/core'
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { VISUAL_BOARD_PRIMARY_SECTION } from '@video-studio/shared/visuals/visual-board-document'

export type PromptCopyScope = 'body' | 'full'
export type PromptClipboardContent = { text: string; html: string }

/** A board's primary section is creative prose in an ordinary image/video node.
 * Keep other requirements structured and preserve partial-selection openness. */
export function promptPasteSlice(slice: Slice, visualBoard: boolean): Slice {
  const primary = (node: ProseMirrorNode | null) => node?.type.name === 'promptManagedSection'
    && node.attrs.section.name === VISUAL_BOARD_PRIMARY_SECTION
  if (visualBoard || !Array.from({ length: slice.content.childCount }, (_, index) => slice.content.child(index)).some(primary)) return slice
  const nodes: ProseMirrorNode[] = []
  slice.content.forEach(node => {
    if (primary(node)) node.forEach(paragraph => nodes.push(paragraph.type.create(null, paragraph.content, paragraph.marks)))
    else nodes.push(node)
  })
  return new Slice(Fragment.fromArray(nodes),
    Math.max(0, slice.openStart - (primary(slice.content.firstChild) ? 1 : 0)),
    Math.max(0, slice.openEnd - (primary(slice.content.lastChild) ? 1 : 0)))
}

/** Clipboard prose has no virtual body-entry attributes or source ownership.
 * Keep reference atoms intact so the destination resolves the same asset IDs. */
function clipboardParagraphs(editor: Editor, scope: PromptCopyScope): ProseMirrorNode[] {
  const result: ProseMirrorNode[] = []
  let group: ProseMirrorNode[] = []
  const appendGroup = () => {
    while (group.length && !group[0].content.size) group.shift()
    while (group.length && !group.at(-1)!.content.size) group.pop()
    if (group.length) {
      if (result.length) result.push(editor.schema.nodes.paragraph.create())
      result.push(...group.map(node => node.type.create(null, node.content, node.marks)))
    }
    group = []
  }
  editor.state.doc.forEach(node => {
    if (node.type.name !== 'promptManagedSection') { group.push(node); return }
    appendGroup()
    const primary = node.attrs.section.name === VISUAL_BOARD_PRIMARY_SECTION
    if (!primary && scope === 'body') return
    if (!primary) group.push(editor.schema.nodes.paragraph.create(null, editor.schema.text(`${node.attrs.section.name}：`)))
    node.forEach(paragraph => group.push(paragraph))
    appendGroup()
  })
  appendGroup()
  return result
}

export function promptClipboardContent(editor: Editor, scope: PromptCopyScope): PromptClipboardContent {
  const paragraphs = Fragment.fromArray(clipboardParagraphs(editor, scope))
  const text = paragraphs.textBetween(0, paragraphs.size, '\n', node =>
    node.type.name === 'promptReference' ? `[[ref:${node.attrs.assetId}]]` : node.type.name === 'hardBreak' ? '\n' : '')
  // Use the schema serializer, rather than the rendered DOM: folded content is
  // included and buttons, summaries, placeholders and source snapshots are not.
  const content = scope === 'full' ? editor.state.doc.content : paragraphs
  const serialized = editor.view.serializeForClipboard(new Slice(content, 0, 0))
  return { text: scope === 'full' ? serialized.text : text, html: serialized.dom.innerHTML }
}

export async function writePromptClipboard(content: PromptClipboardContent): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([content.text], { type: 'text/plain' }),
        'text/html': new Blob([content.html], { type: 'text/html' }),
      })])
      return
    } catch { /* Browsers that refuse rich clipboard data may still allow text. */ }
  }
  await navigator.clipboard.writeText(content.text)
}
