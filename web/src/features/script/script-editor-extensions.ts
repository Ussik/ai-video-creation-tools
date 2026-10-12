import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { textEditorExtensions } from '../../shared/lib/editor/text-editor'

// Canvas text nodes keep their existing schema. Script artifacts store GFM
// tables, whose cells support paragraphs and inline formatting.
export function scriptEditorExtensions() {
  return [
    ...textEditorExtensions(),
    Table.configure({ resizable: false, cellMinWidth: 120, renderWrapper: true, HTMLAttributes: { class: 'script-document-table' } }),
    TableRow,
    TableCell.extend({ content: 'paragraph+' }),
    TableHeader.extend({ content: 'paragraph+' }).configure({ HTMLAttributes: { scope: 'col' } }),
  ]
}
