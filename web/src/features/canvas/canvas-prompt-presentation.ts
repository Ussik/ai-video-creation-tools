import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node } from '@tiptap/pm/model'

/** Only decorate layout. Every original paragraph and section separator stays
 * in the document, clipboard, undo history and serialized model prompt. */
function promptPresentation(state: EditorState, placeholder: string, visualBoard: boolean, unified: boolean) {
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
  const isRequirement = (index: number) => nodes[index]?.node.type.name === 'promptManagedSection'
    && (!visualBoard || nodes[index].node.attrs.section.name !== '设定图固定要求')
  for (let index = 0; index < nodes.length; index++) {
    if (!isRequirement(index)) continue
    let previous = index - 1, next = index + 1
    while (emptyParagraph(previous)) previous--
    while (emptyParagraph(next)) next++
    const { node, position } = nodes[index]
    decorations.push(Decoration.node(position, position + node.nodeSize, {
      class: `pc-prompt-requirement${!isRequirement(previous) ? ' is-group-start' : ''}${!isRequirement(next) ? ' is-group-end' : ''}`,
    }))
  }
  const firstSection = nodes.findIndex(({ node }) => node.type.name === 'promptManagedSection')
  const entryIsEmpty = (firstSection < 0 ? nodes : nodes.slice(0, firstSection)).every((_, index) => emptyParagraph(index))
  if (!visualBoard && nodes[0]?.node.type.name === 'paragraph') {
    const onlyBodyParagraph = nodes.length === 1 || firstSection === 1
    decorations.push(Decoration.node(0, nodes[0].node.nodeSize, {
      class: `pc-prompt-body-start${entryIsEmpty || onlyBodyParagraph ? ' pc-prompt-body-entry' : ''}${entryIsEmpty ? ' pc-prompt-body-placeholder' : ''}`,
      ...(entryIsEmpty ? { 'data-placeholder': placeholder } : {}),
    }))
  }
  if (firstSection >= 0) {
    const requirementNodes = nodes.filter(({ node }) => node.type.name === 'promptManagedSection'
      && (!visualBoard || node.attrs.section.name !== '设定图固定要求'))
    const count = requirementNodes.length
    const headingPosition = visualBoard ? requirementNodes[0]?.position : nodes[firstSection].position
    if (!unified && headingPosition !== undefined) decorations.push(Decoration.widget(headingPosition, () => {
      const heading = document.createElement('div')
      heading.className = 'pc-prompt-presets-heading'
      heading.contentEditable = 'false'
      const label = document.createElement('span'), detail = document.createElement('span')
      label.textContent = '生成约束'
      detail.textContent = `${count} 项 · 手动维护 · 整理时保留 · 生成时生效`
      heading.append(label, detail)
      return heading
    }, { key: `prompt-presets-${visualBoard ? 'board-' : ''}${count}`, side: -1, stopEvent: () => true }))
  }
  if (unified && visualBoard && nodes.some(({ node }) => node.type.name === 'promptManagedSection' && node.attrs.section.name === '设定图固定要求')) {
    const supplement = nodes.find(({ node }) => node.type.name === 'paragraph' && node.textContent.trim())
    if (supplement) decorations.push(Decoration.widget(supplement.position, () => {
      const heading = document.createElement('div')
      heading.className = 'pc-prompt-supplement-heading'
      heading.contentEditable = 'false'
      heading.textContent = '补充创作内容 · 整理时一并合入主要内容'
      return heading
    }, { key: 'prompt-supplement-heading', side: -1, stopEvent: () => true }))
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
    const bridge = isRequirement(start - 1) && isRequirement(index + 1)
    for (let cursor = start; cursor <= index; cursor++) {
      if (!visualBoard && cursor === 0 && entryIsEmpty) continue
      const { node: paragraph, position: from } = nodes[cursor]
      const current = state.selection.empty && state.selection.from > from && state.selection.from < from + paragraph.nodeSize
      decorations.push(Decoration.node(from, from + paragraph.nodeSize, { class: `pc-prompt-section-spacer${bridge ? ' pc-prompt-requirement-bridge' : ''}${current ? ' is-current' : ''}` }))
    }
  }
  return DecorationSet.create(state.doc, decorations)
}

export function promptPresentationPlugin(placeholder: () => string = () => '描述画面，输入 @ 引用图片', visualBoard: () => boolean = () => false, unified: () => boolean = () => false) {
  return new Plugin({ props: { decorations: state => promptPresentation(state, placeholder(), visualBoard(), unified()) } })
}

const requirementsHostKey = new PluginKey<HTMLElement | null>('promptRequirementsHost')

export function promptRequirementsHost(state: EditorState): HTMLElement | null {
  return requirementsHostKey.getState(state) || null
}

/** Each editor owns its controls-only host. StrictMode can initialize two
 * editors for one React component; sharing a DOM widget makes their observers
 * repeatedly move it between views. Editable node views stay in place. */
export function promptRequirementsHostPlugin(enabled: () => boolean) {
  return new Plugin<HTMLElement | null>({
    key: requirementsHostKey,
    state: {
      init: () => {
        if (typeof document === 'undefined') return null
        const host = document.createElement('div')
        host.className = 'pc-prompt-requirements-host'
        host.contentEditable = 'false'
        return host
      },
      apply: (_transaction, host) => host,
    },
    props: { decorations: state => {
      const host = promptRequirementsHost(state)
      return host && enabled()
        ? DecorationSet.create(state.doc, [Decoration.widget(state.doc.content.size, () => host,
          { key: 'prompt-requirements-controls', side: 1, stopEvent: () => true })]) : null
    } },
  })
}
