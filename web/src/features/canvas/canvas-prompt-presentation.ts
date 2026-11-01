import { Plugin, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node } from '@tiptap/pm/model'

/** Only decorate layout. Every original paragraph and section separator stays
 * in the document, clipboard, undo history and serialized model prompt. */
function promptPresentation(state: EditorState, placeholder: string) {
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
  const firstSection = nodes.findIndex(({ node }) => node.type.name === 'promptManagedSection')
  const entryIsEmpty = (firstSection < 0 ? nodes : nodes.slice(0, firstSection)).every((_, index) => emptyParagraph(index))
  if (nodes[0]?.node.type.name === 'paragraph') {
    const onlyBodyParagraph = nodes.length === 1 || firstSection === 1
    decorations.push(Decoration.node(0, nodes[0].node.nodeSize, {
      class: `pc-prompt-body-start${entryIsEmpty || onlyBodyParagraph ? ' pc-prompt-body-entry' : ''}${entryIsEmpty ? ' pc-prompt-body-placeholder' : ''}`,
      ...(entryIsEmpty ? { 'data-placeholder': placeholder } : {}),
    }))
  }
  if (firstSection >= 0) {
    const count = nodes.filter(({ node }) => node.type.name === 'promptManagedSection').length
    decorations.push(Decoration.widget(nodes[firstSection].position, () => {
      const heading = document.createElement('div')
      heading.className = 'pc-prompt-presets-heading'
      heading.contentEditable = 'false'
      const label = document.createElement('span'), detail = document.createElement('span')
      label.textContent = '设定与生成要求'
      detail.textContent = `${count} 项 · 生成时一并发送`
      heading.append(label, detail)
      return heading
    }, { key: `prompt-presets-${count}`, side: -1, stopEvent: () => true }))
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
      if (cursor === 0 && entryIsEmpty) continue
      const { node: paragraph, position: from } = nodes[cursor]
      const current = state.selection.empty && state.selection.from > from && state.selection.from < from + paragraph.nodeSize
      decorations.push(Decoration.node(from, from + paragraph.nodeSize, { class: `pc-prompt-section-spacer${current ? ' is-current' : ''}` }))
    }
  }
  return DecorationSet.create(state.doc, decorations)
}

export function promptPresentationPlugin(placeholder: () => string = () => '描述画面，输入 @ 引用图片') {
  return new Plugin({ props: { decorations: state => promptPresentation(state, placeholder()) } })
}
