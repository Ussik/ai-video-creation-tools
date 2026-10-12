import type { JSONContent } from '@tiptap/core'
import { textDocumentText } from '../../shared/lib/editor/text-document'

// Script artifacts keep Markdown in their existing content field. This codec
// deliberately supports the editor's document schema without interpreting HTML.
type Mark = 'bold' | 'italic' | 'strike'
const markOrder: Mark[] = ['bold', 'italic', 'strike']
const delimiters: Record<Mark, string> = { bold: '**', italic: '_', strike: '~~' }
const punctuation = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/
// Generated Chinese headings may omit the space before titles or numbering.
const headingPattern = /^ {0,3}(#{1,3})(?:[ \t]+|(?=(?:\d+[.、．)）][ \t]*)?\d*\p{Script=Han}|[《〈「『【〔（“‘][ \t]*\d*\p{Script=Han})|$)(.*)$/u

function textNode(text: string, marks: Mark[] = []): JSONContent {
  return { type: 'text', text, ...(marks.length ? { marks: markOrder.filter(mark => marks.includes(mark)).map(type => ({ type })) } : {}) }
}

function appendInline(target: JSONContent[], node: JSONContent) {
  if (node.type === 'text' && !node.text) return
  const previous = target[target.length - 1]
  if (node.type === 'text' && previous?.type === 'text' && JSON.stringify(previous.marks || []) === JSON.stringify(node.marks || [])) {
    previous.text = (previous.text || '') + node.text
  } else target.push(node)
}

function inlineNodes(source: string, tableCell = false): JSONContent[] {
  function parse(from: number, marks: Mark[], closing = '', depth = 0): { nodes: JSONContent[]; end: number; closed: boolean } {
    const nodes: JSONContent[] = []
    let index = from
    while (index < source.length) {
      const char = source[index]
      if (char === '\\' && index + 1 < source.length) {
        if (source[index + 1] === '\n') {
          appendInline(nodes, { type: 'hardBreak' })
          index += 2
          continue
        }
        if (punctuation.test(source[index + 1])) {
          appendInline(nodes, textNode(source[index + 1], marks))
          index += 2
          continue
        }
      }
      if (char === '\n') {
        const previous = nodes[nodes.length - 1]
        if (previous?.type === 'text' && / {2,}$/.test(previous.text || '')) previous.text = previous.text!.replace(/ {2,}$/, '')
        appendInline(nodes, { type: 'hardBreak' })
        index += 1
        continue
      }
      // GFM cells cannot contain physical newlines. Only interpret this small
      // line-break syntax in cells; escaped HTML remains literal prose.
      const cellBreak = tableCell && char === '<' ? /^<br\s*\/?\s*>/i.exec(source.slice(index)) : null
      if (cellBreak) {
        appendInline(nodes, { type: 'hardBreak' })
        index += cellBreak[0].length
        continue
      }
      if (char === '&') {
        const entity = /^&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos|nbsp));/i.exec(source.slice(index))
        if (entity) {
          const codepoint = entity[1] ? Number(entity[1]) : entity[2] ? parseInt(entity[2], 16) : null
          const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }
          const decoded = codepoint == null ? named[entity[3].toLowerCase()] : codepoint > 0 && codepoint <= 0x10ffff && !(codepoint >= 0xd800 && codepoint <= 0xdfff) ? String.fromCodePoint(codepoint) : '\ufffd'
          appendInline(nodes, textNode(decoded, marks))
          index += entity[0].length
          continue
        }
      }
      let run = 0
      if (char === '*' || char === '_' || char === '~') {
        while (source[index + run] === char) run += 1
      }
      const closes = closing && source.startsWith(closing, index) && index > from && !/\s/.test(source[index - 1])
        && (closing.length > 1 || run === 1 || run >= 3)
      if (closes) return { nodes, end: index + closing.length, closed: true }
      if (run && depth < 24) {
        const token = char === '~' ? run >= 2 ? '~~' : '' : run >= 2 ? char.repeat(2) : char
        const mark: Mark = char === '~' ? 'strike' : token.length === 2 ? 'bold' : 'italic'
        const next = source[index + token.length]
        if (token && next && !/\s/.test(next) && !marks.includes(mark)) {
          const inner = parse(index + token.length, [...marks, mark], token, depth + 1)
          if (inner.closed) {
            inner.nodes.forEach(node => appendInline(nodes, node))
            index = inner.end
            continue
          }
        }
      }
      appendInline(nodes, textNode(char, marks))
      index += 1
    }
    return { nodes, end: index, closed: false }
  }
  return parse(0, []).nodes
}

function paragraph(value: string): JSONContent {
  const content = inlineNodes(value)
  return { type: 'paragraph', ...(content.length ? { content } : {}) }
}

type ListLine = { indent: number; contentIndent: number; ordered: boolean; start: number; content: string }
function listLine(line: string): ListLine | null {
  const match = /^( *)([-+*•]|\d+[.)])(?:([ \t]+)(.*)|$)/.exec(line)
  if (!match) return null
  const ordered = /^\d/.test(match[2])
  return { indent: match[1].length, contentIndent: match[1].length + match[2].length + (match[3]?.length || 1), ordered, start: ordered ? Number.parseInt(match[2], 10) : 1, content: match[4] || '' }
}

function explicitBreak(line: string): boolean {
  return /(?:^|[^\\])(?:\\\\)*\\$/.test(line) || / {2,}$/.test(line)
}

function blockStart(line: string): boolean {
  return !!listLine(line) || headingPattern.test(line) || /^ {0,3}>\s?/.test(line) || /^ {0,3}(?:`{3,}|~{3,})/.test(line) || /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)
}

function tableCells(line: string): string[] | null {
  const source = line.trim()
  const cells: string[] = []
  let cell = ''
  let pipes = 0
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\\' && index + 1 < source.length) {
      cell += source[index] + source[++index]
    } else if (source[index] === '|') {
      cells.push(cell.trim())
      cell = ''
      pipes += 1
    } else cell += source[index]
  }
  if (!pipes) return null
  cells.push(cell.trim())
  if (source.startsWith('|')) cells.shift()
  if (cell === '' && source.endsWith('|')) cells.pop()
  return cells.length ? cells : null
}

function tableStart(lines: string[], index: number): { headers: string[]; alignments: Array<string | null> } | null {
  const headers = tableCells(lines[index] || '')
  const separators = tableCells(lines[index + 1] || '')
  if (!headers || !separators || headers.length !== separators.length || !separators.every(cell => /^:?-+:?$/.test(cell))) return null
  return { headers, alignments: separators.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : null) }
}

function tableRow(cells: string[], alignments: Array<string | null>, header = false): JSONContent {
  return { type: 'tableRow', content: alignments.map((align, column) => {
    const content = inlineNodes(cells[column] || '', true)
    return { type: header ? 'tableHeader' : 'tableCell', ...(align ? { attrs: { align } } : {}),
      content: [{ type: 'paragraph', ...(content.length ? { content } : {}) }] }
  }) }
}

function parseBlocks(lines: string[], depth = 0): JSONContent[] {
  if (depth > 24) return [paragraph(lines.join('\n'))]
  const result: JSONContent[] = []
  let index = 0
  while (index < lines.length) {
    if (!lines[index].trim()) {
      const start = index
      while (index < lines.length && !lines[index].trim()) index += 1
      // A document containing only empty paragraphs has no non-empty block to
      // provide a separator. The serializer joins empty paragraphs with two
      // newlines, so N paragraphs are represented by N + 1 blank lines.
      if (start === 0 && index === lines.length) {
        const paragraphCount = Math.max(1, Math.floor((lines.length - 1) / 2) + 1)
        for (let empty = 0; empty < paragraphCount; empty += 1) result.push(paragraph(''))
        continue
      }
      // One blank line separates blocks; additional pairs represent empty
      // paragraphs, including the empty paragraphs created with Enter.
      const count = index - start
      const empties = Math.floor((count - (start > 0 && index < lines.length ? 1 : 0)) / 2)
      for (let empty = 0; empty < empties; empty += 1) result.push(paragraph(''))
      continue
    }
    const line = lines[index]
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      const parts = [lines[index++]]
      while (index < lines.length) {
        const next = lines[index++]
        parts.push(next)
        const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(next)
        if (closing && closing[1][0] === fence[1][0] && closing[1].length >= fence[1].length) break
      }
      result.push(paragraph(parts.join('\n')))
      continue
    }
    const table = tableStart(lines, index)
    if (table) {
      const rows = [tableRow(table.headers, table.alignments, true)]
      index += 2
      while (index < lines.length && lines[index].trim() && !blockStart(lines[index])) {
        if (tableStart(lines, index)) break
        const cells = tableCells(lines[index])
        if (!cells) break
        rows.push(tableRow(cells, table.alignments))
        index += 1
      }
      result.push({ type: 'table', content: rows })
      continue
    }
    const heading = headingPattern.exec(line)
    if (heading) {
      const parts = [heading[2] || '']
      while (explicitBreak(parts[parts.length - 1]) && index + 1 < lines.length) parts.push(lines[++index])
      const content = inlineNodes(parts.join('\n'))
      result.push({ type: 'heading', attrs: { level: heading[1].length }, ...(content.length ? { content } : {}) })
      index += 1
      continue
    }
    if (/^ {0,3}>/.test(line)) {
      const quoted: string[] = []
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) quoted.push(lines[index++].replace(/^ {0,3}> ?/, ''))
      result.push({ type: 'blockquote', content: parseBlocks(quoted, depth + 1) })
      continue
    }
    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      result.push({ type: 'horizontalRule' })
      index += 1
      continue
    }
    const first = listLine(line)
    if (first) {
      const items: JSONContent[] = []
      while (index < lines.length) {
        const current = listLine(lines[index])
        if (!current || current.indent !== first.indent || current.ordered !== first.ordered) break
        const itemLines = [current.content]
        index += 1
        while (index < lines.length) {
          const next = lines[index]
          const marker = listLine(next)
          if (marker && marker.indent <= first.indent) break
          if (!next.trim()) {
            let nonempty = index
            while (nonempty < lines.length && !lines[nonempty].trim()) nonempty += 1
            const following = nonempty < lines.length ? listLine(lines[nonempty]) : null
            if (following && following.indent === first.indent && following.ordered === first.ordered) {
              index = nonempty
              break
            }
            if (nonempty >= lines.length || lines[nonempty].search(/\S/) <= first.indent) break
            itemLines.push('')
            index += 1
            continue
          }
          const indentation = next.search(/\S/)
          if (indentation > first.indent) itemLines.push(next.slice(Math.min(indentation, current.contentIndent)))
          else if (!blockStart(next) && !tableStart(lines, index)) itemLines.push(next)
          else break
          index += 1
        }
        const content = parseBlocks(itemLines, depth + 1)
        if (!content.length || content[0].type !== 'paragraph') content.unshift(paragraph(''))
        items.push({ type: 'listItem', content })
      }
      result.push({ type: first.ordered ? 'orderedList' : 'bulletList', ...(first.ordered ? { attrs: { start: Math.max(1, Math.min(1_000_000, first.start)) } } : {}), content: items })
      continue
    }
    const parts = [line]
    index += 1
    while (index < lines.length) {
      if (explicitBreak(parts[parts.length - 1])) {
        parts.push(lines[index++])
        continue
      }
      if (!lines[index].trim() || blockStart(lines[index]) || tableStart(lines, index)) break
      parts.push(lines[index++])
    }
    result.push(paragraph(parts.join('\n')))
  }
  return result.length ? result : [paragraph('')]
}

export function parseScriptDocument(value: string): JSONContent {
  return { type: 'doc', content: parseBlocks(value.replace(/\r\n?/g, '\n').replace(/^\t+/gm, tabs => '    '.repeat(tabs.length)).split('\n')) }
}

/** The document title is rendered outside the body. Only omit an identical
 * leading heading; subsection headings and ordinary prose remain editable. */
export function omitRepeatedScriptTitle(document: JSONContent, title?: string): JSONContent {
  if (!title?.trim() || document.type !== 'doc') return document
  const blocks = document.content || []
  const first = blocks.findIndex(block => block.type !== 'paragraph' || textDocumentText(block).trim())
  if (first < 0 || blocks[first].type !== 'heading' || textDocumentText(blocks[first]).trim() !== title.trim()) return document
  const content = blocks.slice(first + 1)
  return { ...document, content: content.length ? content : [{ type: 'paragraph' }] }
}

function escapeText(value: string): string {
  // Spaces are meaningful in script prose and need no Markdown escaping when
  // they occur inside an inline node. Block-leading markers are handled by
  // escapeBlockStart below; preserving spaces here keeps the saved Markdown
  // readable and stable across an editor reload.
  return value.replace(/[\\`*_~\[\]<>&]/g, '\\$&')
}

function inlineMarkdown(nodes: JSONContent[]): string {
  // Serialize a mark range as a small stack rather than wrapping each text
  // node independently. Tiptap often splits one visual range into adjacent
  // text nodes (for example bold followed by bold+italic). Wrapping every
  // node would produce `**a****_b_**`, where the adjacent delimiters are
  // ambiguous to Markdown parsers. Keeping the common marks open produces the
  // canonical `**a_b_**` form and makes the persisted document deterministic.
  type InlineUnit = { text?: string; type?: string; marks: Mark[]; content?: JSONContent[] }
  const units: InlineUnit[] = []
  const collect = (items: JSONContent[]) => {
    for (const node of items) {
      if (node.type === 'text') {
        const value = node.text || ''
        const marks = markOrder.filter(mark => node.marks?.some(item => item.type === mark))
        // Whitespace at a mark boundary stays outside the delimiters. This is
        // required for Markdown emphasis and also keeps cursor-created marked
        // spaces from changing the meaning of the surrounding prose.
        const leading = value.match(/^\s*/)?.[0] || ''
        const trailing = value.match(/\s*$/)?.[0] || ''
        const body = value.slice(leading.length, value.length - trailing.length || undefined)
        if (leading) units.push({ text: leading, marks: [] })
        if (body) units.push({ text: body, marks })
        if (trailing && body) units.push({ text: trailing, marks: [] })
        continue
      }
      if (node.type === 'hardBreak') units.push({ type: 'hardBreak', marks: markOrder.filter(mark => node.marks?.some(item => item.type === mark)) })
      else if (node.content) collect(node.content)
    }
  }
  collect(nodes)

  let open: Mark[] = []
  let output = ''
  const closeTo = (next: Mark[]) => {
    let common = 0
    while (common < open.length && common < next.length && open[common] === next[common]) common += 1
    for (let index = open.length - 1; index >= common; index -= 1) output += delimiters[open[index]]
    open = open.slice(0, common)
    for (const mark of next.slice(common)) {
      output += delimiters[mark]
      open.push(mark)
    }
  }
  for (const unit of units) {
    closeTo(unit.marks)
    if (unit.type === 'hardBreak') output += '\\\n'
    else output += escapeText(unit.text || '')
  }
  closeTo([])
  return output
}

function escapeBlockStart(value: string): string {
  // Use the same heading rule when persisting literal paragraph text.
  if (headingPattern.test(value)) return value.replace(/^( {0,3})#/, '$1\\#')
  return value.replace(/^( {0,3})(#{1,6}(?=\s|$|\d*\p{Script=Han})|[-+•](?=\s|$)|\d+[.)](?=\s|$)|>(?=\s|$)|(?:-{3,}|\*{3,}|_{3,})\s*$)/u, (_match, indent: string, marker: string) => {
    // A paragraph beginning with a block marker must be escaped before the
    // next parse, otherwise a literal `---` becomes a horizontal rule and a
    // literal `> quote` becomes a blockquote.
    if (/^(?:-{3,}|\*{3,}|_{3,})/.test(marker)) return `${indent}\\${marker}`
    if (/^\d/.test(marker)) return `${indent}${marker.slice(0, -1)}\\${marker.slice(-1)}`
    return `${indent}\\${marker}`
  })
}

function blockMarkdown(node: JSONContent, depth = 0): string {
  if (depth > 24) return ''
  const children = node.content || []
  if (node.type === 'paragraph') return escapeBlockStart(inlineMarkdown(children))
  if (node.type === 'heading') return `${'#'.repeat(Math.max(1, Math.min(3, Number(node.attrs?.level) || 1)))} ${inlineMarkdown(children)}`
  if (node.type === 'horizontalRule') return '---'
  if (node.type === 'table') {
    const headers = children[0]?.content || []
    const rowMarkdown = (row: JSONContent) => `| ${headers.map((_header, column) => {
      const cell = row.content?.[column]
      // Enter can create another paragraph within a cell. Store paragraph and
      // hard-break boundaries as GFM line breaks, preserving text and marks.
      return (cell?.content || []).map(block => inlineMarkdown(block.content || []))
        .join('\\\n').replace(/\\\n/g, '<br>').replace(/\|/g, '\\|')
    }).join(' | ')} |`
    const separators = headers.map(cell => cell.attrs?.align === 'center' ? ':---:' : cell.attrs?.align === 'right' ? '---:' : cell.attrs?.align === 'left' ? ':---' : '---')
    return [rowMarkdown(children[0]), `| ${separators.join(' | ')} |`, ...children.slice(1).map(rowMarkdown)].join('\n')
  }
  if (node.type === 'blockquote') return children.map(child => blockMarkdown(child, depth + 1)).join('\n\n').split('\n').map(line => line ? `> ${line}` : '>').join('\n')
  if (node.type === 'bulletList' || node.type === 'orderedList') {
    const start = Math.max(1, Math.min(1_000_000, Number(node.attrs?.start) || 1))
    return children.map((item, index) => {
      const marker = node.type === 'orderedList' ? `${start + index}. ` : '- '
      const indent = ' '.repeat(marker.length)
      const blocks = item.content || [{ type: 'paragraph' }]
      let content = blockMarkdown(blocks[0], depth + 1)
      for (const block of blocks.slice(1)) {
        const separator = block.type === 'bulletList' || block.type === 'orderedList' ? '\n' : '\n\n'
        content += separator + blockMarkdown(block, depth + 1)
      }
      return marker + content.split('\n').map((line, lineIndex) => lineIndex ? indent + line : line).join('\n')
    }).join('\n')
  }
  if (node.type === 'text') return escapeText(node.text || '')
  return children.map(child => blockMarkdown(child, depth + 1)).join('\n\n')
}

export function serializeScriptDocument(doc: JSONContent): string {
  return blockMarkdown(doc)
}
