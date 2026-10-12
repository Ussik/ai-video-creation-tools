import { Extension, type Editor, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Plugin } from '@tiptap/pm/state'
import { normalizeTextDocument, textDocumentText } from './text-document'

export type TextFormat = 'clear' | 'h1' | 'h2' | 'h3' | 'paragraph' | 'bold' | 'italic' | 'strike' | 'bulletList' | 'orderedList' | 'rule'

function canSaveDocument(document: JSONContent): boolean {
  // Keep accepted edits inside the same storage bounds as the canvas API.
  const pending = [{ node: document, depth: 1 }]
  let count = 0
  while (pending.length) {
    const { node, depth } = pending.pop()!
    if (++count > 2000 || depth > 16) return false
    for (const child of node.content || []) pending.push({ node: child, depth: depth + 1 })
  }
  return textDocumentText(document).length <= 20000
    && new TextEncoder().encode(JSON.stringify(normalizeTextDocument(document))).length <= 256000
}

export function textEditorExtensions() {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      code: false, codeBlock: false,
      link: false, underline: false, trailingNode: false,
    }),
    Extension.create({
      name: 'canvasTextLength',
      addProseMirrorPlugins() {
        return [new Plugin({
          filterTransaction: transaction => !transaction.docChanged || canSaveDocument(transaction.doc.toJSON()),
        })]
      },
    }),
  ]
}

export function applyTextFormat(editor: Editor, format: TextFormat) {
  const chain = editor.chain().focus()
  if (format === 'clear') {
    // With a caret, clear the current paragraph; with a range, preserve the
    // user's range so neighbouring paragraphs keep their own formatting.
    const { empty, $from } = editor.state.selection
    if (empty && $from.parent.isTextblock) chain.setTextSelection({ from: $from.start(), to: $from.end() })
    return chain.unsetAllMarks().clearNodes().run()
  }
  if (format === 'paragraph') return chain.clearNodes().run()
  if (format === 'h1' || format === 'h2' || format === 'h3') {
    return chain.toggleHeading({ level: Number(format.slice(1)) as 1 | 2 | 3 }).run()
  }
  if (format === 'bold') return chain.toggleBold().run()
  if (format === 'italic') return chain.toggleItalic().run()
  if (format === 'strike') return chain.toggleStrike().run()
  if (format === 'bulletList') return chain.toggleBulletList().run()
  if (format === 'orderedList') return chain.toggleOrderedList().run()
  return chain.setHorizontalRule().run()
}
