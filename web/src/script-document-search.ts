import { Extension, getSchema, type Editor, type JSONContent } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { scriptEditorExtensions } from './script-editor-extensions'
import { parseScriptDocument, serializeScriptDocument } from './script-rich-document'
import { textDocumentText } from './text-document'

export type ScriptSearchRange = { from: number; to: number }
export type ScriptSearchDocument = { id: string; section: string; title: string; document: JSONContent }
export type ScriptSearchMatch = ScriptSearchRange & { documentId: string; section: string; title: string }

export function resolveScriptArtifactDocument(value: string, document?: JSONContent): JSONContent {
  return document && (textDocumentText(document) === value || serializeScriptDocument(document) === value)
    ? document : parseScriptDocument(value)
}

// Search rendered text, including text split by bold/italic marks. Block and
// hard-break boundaries remain separators rather than joining unrelated words.
export function findScriptTextMatches(document: ProseMirrorNode, query: string): ScriptSearchRange[] {
  if (!query.trim()) return []
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const matches: ScriptSearchRange[] = []
  document.descendants((node, position) => {
    if (!node.isTextblock) return
    const text = node.textBetween(0, node.content.size, '', '\n')
    for (const match of text.matchAll(pattern)) {
      const from = position + 1 + match.index
      matches.push({ from, to: from + match[0].length })
    }
    return false
  })
  return matches
}

const searchSchema = getSchema(scriptEditorExtensions())

export function searchScriptDocuments(documents: ScriptSearchDocument[], query: string): ScriptSearchMatch[] {
  if (!query.trim()) return []
  return documents.flatMap(document => findScriptTextMatches(searchSchema.nodeFromJSON(document.document), query)
    .map(range => ({ ...range, documentId: document.id, section: document.section, title: document.title })))
}

type SearchState = { query: string; active: ScriptSearchRange | null; decorations: DecorationSet }
const searchKey = new PluginKey<SearchState>('scriptDocumentSearch')

function decorate(document: ProseMirrorNode, query: string, active: ScriptSearchRange | null): DecorationSet {
  return DecorationSet.create(document, findScriptTextMatches(document, query).map(range => {
    const selected = range.from === active?.from && range.to === active.to
    return Decoration.inline(range.from, range.to, {
      class: `script-search-match${selected ? ' is-current' : ''}`,
      ...(selected ? { 'data-script-search-active': 'true' } : {}),
    })
  }))
}

export const ScriptSearchHighlight = Extension.create({
  name: 'scriptSearchHighlight',
  addProseMirrorPlugins() {
    return [new Plugin<SearchState>({
      key: searchKey,
      state: {
        init: () => ({ query: '', active: null, decorations: DecorationSet.empty }),
        apply(transaction, previous) {
          const update = transaction.getMeta(searchKey) as { query: string; active: ScriptSearchRange | null } | undefined
          if (!update && !transaction.docChanged) return previous
          const query = update ? update.query : previous.query
          const active = update ? update.active : previous.active
          return { query, active, decorations: decorate(transaction.doc, query, active) }
        },
      },
      props: { decorations: state => searchKey.getState(state)?.decorations },
    })]
  },
})

export function highlightScriptSearch(editor: Editor, query: string, active: ScriptSearchRange | null) {
  const current = searchKey.getState(editor.state)
  if (!current || (current.query === query && current.active?.from === active?.from && current.active?.to === active?.to)) return
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, { query, active }).setMeta('addToHistory', false))
}
