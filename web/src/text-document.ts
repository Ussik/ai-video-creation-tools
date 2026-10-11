import type { JSONContent } from '@tiptap/core'

/** Keep the editor document within the formatting supported by text nodes. */
export function normalizeTextDocument(doc: JSONContent): JSONContent {
  const normalized: JSONContent = {}
  if (typeof doc.type === 'string') normalized.type = doc.type
  if (typeof doc.text === 'string') normalized.text = doc.text

  const attribute = doc.type === 'heading' ? 'level' : doc.type === 'orderedList' ? 'start' : null
  if (attribute && doc.attrs?.[attribute] != null) {
    normalized.attrs = { [attribute]: attribute === 'start'
      ? Math.min(1_000_000, Math.max(1, Number(doc.attrs[attribute]) || 1)) : doc.attrs[attribute] }
  }
  if ((doc.type === 'tableCell' || doc.type === 'tableHeader') && ['left', 'center', 'right'].includes(doc.attrs?.align)) {
    normalized.attrs = { align: doc.attrs!.align }
  }

  if (Array.isArray(doc.content)) normalized.content = doc.content.map(normalizeTextDocument)
  if (doc.type === 'text' && Array.isArray(doc.marks)) {
    const marks = [...new Set(doc.marks.map((mark) => mark.type))]
      .filter((type) => type === 'bold' || type === 'italic' || type === 'strike')
      .map((type) => ({ type }))
    if (marks.length) normalized.marks = marks
  }
  return normalized
}

/** Preserve every line, including empty lines and a trailing newline. */
export function plainTextDocument(text: string): JSONContent {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => line
      ? { type: 'paragraph', content: [{ type: 'text', text: line }] }
      : { type: 'paragraph' }),
  }
}

/** Produce model-facing text without headings, list markers, or mark syntax. */
export function textDocumentText(doc: JSONContent): string {
  if (doc.type === 'text') return doc.text || ''
  if (doc.type === 'hardBreak') return '\n'
  if (doc.type === 'horizontalRule') return ''

  const content = (doc.content || []).map(textDocumentText)
  switch (doc.type) {
    case 'doc':
    case 'bulletList':
    case 'orderedList':
    case 'listItem':
    case 'table':
    case 'tableCell':
    case 'tableHeader':
      return content.join('\n')
    case 'tableRow':
      return content.join('\t')
    default:
      return content.join('')
  }
}

/** External plain-text edits take precedence over an older formatted copy. */
export function resolveTextDocument(text: string, doc?: JSONContent | null): JSONContent {
  return doc && textDocumentText(doc) === text ? doc : plainTextDocument(text)
}
