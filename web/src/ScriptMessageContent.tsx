import { useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './script-message-content.css'

// Model replies sometimes omit the space in Chinese Markdown headings. Keep
// that existing display convention without rewriting examples inside fences.
function normalizeMessageHeadings(value: string): string {
  let fence: { marker: string; length: number } | null = null
  return value.replace(/\r\n?/g, '\n').split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = null
      return line
    }
    if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
      fence = { marker: marker[1][0], length: marker[1].length }
      return line
    }
    return line.replace(/^( {0,3})(#{1,3})(?=(?:\d+[.、．)）][ \t]*)?\d*\p{Script=Han}|[《〈「『【〔（“‘][ \t]*\d*\p{Script=Han})/u, '$1$2 ')
  }).join('\n')
}

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] }

// Support the line breaks commonly emitted inside GFM cells. Other HTML stays
// disabled; this does not enable arbitrary tags or model-supplied attributes.
function remarkCellBreaks() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.type === 'html' && /^<br\s*\/?\s*>$/i.test(node.value || '')) {
        node.type = 'break'
        delete node.value
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}

/** Read-only model replies use GFM; stored/editable script documents keep their existing codec. */
export default function ScriptMessageContent({ text }: { text: string }) {
  const content = useMemo(() => normalizeMessageHeadings(text), [text])
  return <div className="script-message-content pc-rich-text-preview pc-rich-text-content">
    <Markdown remarkPlugins={[remarkGfm, remarkCellBreaks]} skipHtml components={{
      table: ({ children }) => <div className="script-message-table-scroll" role="region" aria-label="回复表格" tabIndex={0}><table>{children}</table></div>,
      th: ({ children, style }) => <th scope="col" style={style}>{children}</th>,
      a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
      img: ({ alt }) => <span>{alt || ''}</span>,
    }}>{content}</Markdown>
  </div>
}
