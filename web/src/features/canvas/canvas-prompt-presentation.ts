import { Plugin, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node } from '@tiptap/pm/model'

/** Only decorate layout. Every original paragraph and section separator stays
 * in the document, clipboard, undo history and serialized model prompt. */
function promptPresentation(state: EditorState) {
  const nodes: Array<{ node: Node; position: number }> = []
  const decorations: Decoration[] = []
  state.doc.forEach((node, position) => nodes.push({ node, position }))
  const emptyParagraph = (index: number) => {
    const node = nodes[index]?.node
    if (node?.type.name !== 'paragraph') return false
    let empty = true
    node.forEach(child => { if (!child.isText || child.text?.trim()) empty = false })
    return empty
  }
  for (let index = 0; index < nodes.length; index++) {
    const { node, position } = nodes[index]
    if (node.type.name === 'promptManagedSection') {
      node.forEach((paragraph, offset) => {
        if (paragraph.type.name === 'paragraph' && /^[^\n:：]{1,24}[:：]$/u.test(paragraph.textContent)) {
          decorations.push(Decoration.node(position + 1 + offset, position + 1 + offset + paragraph.nodeSize, { class: 'pc-prompt-section-label' }))
        }
      })
      continue
    }
    if (!emptyParagraph(index)) continue
    const start = index
    while (emptyParagraph(index + 1)) index++
    if (nodes[start - 1]?.node.type.name !== 'promptManagedSection' && nodes[index + 1]?.node.type.name !== 'promptManagedSection') continue
    for (let cursor = start; cursor <= index; cursor++) {
      const { node: paragraph, position: from } = nodes[cursor]
      const current = state.selection.empty && state.selection.from > from && state.selection.from < from + paragraph.nodeSize
      decorations.push(Decoration.node(from, from + paragraph.nodeSize, { class: `pc-prompt-section-spacer${current ? ' is-current' : ''}` }))
    }
  }
  return DecorationSet.create(state.doc, decorations)
}

export function promptPresentationPlugin() {
  return new Plugin({ props: { decorations: promptPresentation } })
}
