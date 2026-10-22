import { managedPromptBlockNames, stripManagedPromptBlocks, validateManagedPromptDocument, type ManagedPromptBlockName } from './prompt-document.js'

export type PromptSectionBlock = {
  id: string
  kind: 'body' | 'managed'
  /** Literal text, including section markers and every separator. */
  text: string
  name?: ManagedPromptBlockName
  /** Last accepted generated source. Empty means this source section was removed. */
  sourceText?: string
  /** New source awaiting a creator's decision; empty means an upstream deletion. */
  pendingSourceText?: string
  sourceStatus?: 'source_changed'
  /** A creator's deletion is retained even though it has no serialized text. */
  deleted?: boolean
  /** Source deletion can be reversed automatically; creator deletion cannot. */
  deletionSource?: 'source'
}
export type PromptSectionDocument = { version: 1; blocks: PromptSectionBlock[] }

export function isPromptSectionDocument(value: unknown): value is PromptSectionDocument {
  if (!value || typeof value !== 'object') return false
  const document = value as Record<string, unknown>
  if (document.version !== 1 || !Array.isArray(document.blocks)) return false
  const ids = new Set<string>()
  return document.blocks.every(value => {
    if (!value || typeof value !== 'object') return false
    const block = value as Record<string, unknown>
    if (typeof block.id !== 'string' || !block.id || ids.has(block.id) || typeof block.text !== 'string'
      || !['body', 'managed'].includes(String(block.kind))) return false
    ids.add(block.id)
    if (block.kind === 'managed') {
      if (!managedPromptBlockNames.includes(block.name as ManagedPromptBlockName)) return false
      if (!block.deleted) {
        if (!(block.text as string).startsWith(`【${block.name}】`) || !(block.text as string).endsWith(`【${block.name}结束】`)) return false
        try { validateManagedPromptDocument(block.text as string) } catch { return false }
      }
    }
    return (block.sourceText === undefined || typeof block.sourceText === 'string')
      && (block.pendingSourceText === undefined || typeof block.pendingSourceText === 'string')
      && (block.sourceStatus === undefined || block.sourceStatus === 'source_changed')
      && (block.deleted === undefined || typeof block.deleted === 'boolean')
      && (!block.deleted || block.kind === 'managed' && block.text === '')
      && (block.deletionSource === undefined || block.deletionSource === 'source' && block.deleted === true)
  })
}

export function serializePromptSectionDocument(document: PromptSectionDocument): string {
  return document.blocks.map(block => block.deleted ? '' : block.text).join('')
}

function freshId(kind: PromptSectionBlock['kind'], reserved: Set<string>): string {
  let number = 1
  while (reserved.has(`${kind}-${number}`)) number++
  const id = `${kind}-${number}`
  reserved.add(id)
  return id
}

function rawSections(text: string): Array<Omit<PromptSectionBlock, 'id'>> {
  const blocks: Array<Omit<PromptSectionBlock, 'id'>> = []
  const pattern = new RegExp(`【(${managedPromptBlockNames.join('|')})】[\\s\\S]*?【\\1结束】`, 'g')
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    try { validateManagedPromptDocument(match[0]) } catch { continue }
    if (match.index! > cursor) blocks.push({ kind: 'body', text: text.slice(cursor, match.index!) })
    blocks.push({ kind: 'managed', name: match[1] as ManagedPromptBlockName, text: match[0] })
    cursor = match.index! + match[0].length
  }
  if (cursor < text.length || !blocks.length) blocks.push({ kind: 'body', text: text.slice(cursor) })
  return blocks
}

/** Prefer exact identity anchors before falling back to unchanged section order. */
type SectionPairs = Map<string, PromptSectionBlock> & { ambiguous: Set<string> }
function pairSections(previous: PromptSectionBlock[], next: PromptSectionBlock[]): SectionPairs {
  const pairs: SectionPairs = Object.assign(new Map<string, PromptSectionBlock>(), { ambiguous: new Set<string>() })
  const used = new Set<string>()
  for (const before of previous) {
    const match = [before.sourceText, before.pendingSourceText, before.text].filter(text => text !== undefined && text !== '')
      .map(text => next.find(after => !used.has(after.id) && before.name === after.name && text === after.text)).find(Boolean)
    if (match) { pairs.set(before.id, match); used.add(match.id) }
  }
  for (const name of new Set(previous.map(block => block.name))) {
    const sameName = previous.filter(block => block.name === name)
    if (!sameName.some(block => pairs.has(block.id)) && next.filter(block => block.name === name).length !== sameName.length) {
      for (const block of sameName) pairs.ambiguous.add(block.id)
    }
  }
  for (let index = 0; index < previous.length; index++) {
    const before = previous[index]!
    if (pairs.has(before.id)) continue
    const left = previous.slice(0, index).reverse().find(block => block.name === before.name && pairs.has(block.id))
    const right = previous.slice(index + 1).find(block => block.name === before.name && pairs.has(block.id))
    const lower = left ? next.indexOf(pairs.get(left.id)!) : -1
    const upper = right ? next.indexOf(pairs.get(right.id)!) : next.length
    const candidates = next.filter((after, position) => !used.has(after.id) && before.name === after.name && position > lower && position < upper)
    const remaining = previous.filter(block => block.name === before.name && !pairs.has(block.id)).length
    const identity = (before.sourceText || before.text).split('\n').filter(line => line && !/^【.*】$/.test(line))
    const scores = candidates.map(candidate => ({ candidate, score: candidate.text.split('\n').filter(line => identity.includes(line)).length }))
      .sort((a, b) => b.score - a.score)
    const distinct = scores[0] && scores[0].score > 0 && scores[0].score > (scores[1]?.score ?? -1) ? scores[0].candidate : undefined
    const match = distinct || (!left && right ? candidates.at(-remaining) || candidates[0] : candidates[0])
    if (match) {
      pairs.set(before.id, match); used.add(match.id)
      if (distinct) pairs.ambiguous.delete(before.id)
      // Multiple same-name sections with no identity anchor cannot safely be
      // inferred from position alone after an insertion or deletion.
      if (!left && !right && previous.filter(block => block.name === before.name).length > 1
        && candidates.length !== remaining) pairs.ambiguous.add(before.id)
    }
  }
  return pairs
}

/** Parse old text without interpreting unknown headings or discarding incomplete markers. */
export function parsePromptSectionDocument(text: string, options: {
  sourceText?: string; previousDocument?: PromptSectionDocument
} = {}): PromptSectionDocument {
  const previous = options.previousDocument?.blocks || []
  const reserved = new Set(previous.map(block => block.id))
  const parsed = rawSections(text).map(block => ({ ...block, id: freshId(block.kind, reserved) }))
  const managed = previous.filter(block => block.kind === 'managed')
  const paired = pairSections(managed, parsed.filter(block => block.kind === 'managed'))
  const byNewId = new Map([...paired].map(([oldId, after]) => [after.id, previous.find(block => block.id === oldId)!]))
  let bodyIndex = 0
  const bodies = previous.filter(block => block.kind === 'body')
  const blocks = parsed.map(block => {
    if (block.kind === 'body') {
      const before = bodies[bodyIndex++]
      return before ? { ...block, id: before.id } : block
    }
    const before = byNewId.get(block.id)
    if (!before) return block
    const { deleted: _deleted, deletionSource: _deletion, ...metadata } = before
    return { ...metadata, text: block.text }
  })
  for (const before of managed) {
    if (paired.has(before.id)) continue
    const tombstone = { ...before, text: '', deleted: true }
    // Keep its position relative to the next surviving section. This also
    // preserves existing tombstones when serializing and parsing again.
    const following = previous.slice(previous.indexOf(before) + 1).find(block => block.kind === 'managed' && paired.has(block.id))
    const index = following ? blocks.findIndex(block => block.id === following.id) : -1
    blocks.splice(index < 0 ? blocks.length : index, 0, tombstone)
  }
  if (options.sourceText !== undefined) {
    const source = rawSections(options.sourceText).filter(block => block.kind === 'managed')
      .map((block, index) => ({ ...block, id: `source-${index}` }))
    const sources = pairSections(blocks.filter(block => block.kind === 'managed'), source)
    for (const block of blocks) if (block.kind === 'managed' && block.sourceText === undefined) {
      block.sourceText = sources.get(block.id)?.text || ''
    }
  }
  return { version: 1, blocks }
}

type LineEdit = { start: number; end: number; lines: string[] }
const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) || []
const equalLines = (left: string[], right: string[]) => left.length === right.length && left.every((line, index) => line === right[index])

function lineEdits(base: string[], changed: string[]): LineEdit[] {
  let prefix = 0, suffix = 0
  while (prefix < base.length && prefix < changed.length && base[prefix] === changed[prefix]) prefix++
  while (suffix < base.length - prefix && suffix < changed.length - prefix && base[base.length - suffix - 1] === changed[changed.length - suffix - 1]) suffix++
  const before = base.slice(prefix, base.length - suffix), after = changed.slice(prefix, changed.length - suffix)
  if (!before.length && !after.length) return []
  // Very large single sections use a conservative change range instead of an
  // unbounded quadratic matrix; overlaps remain visible for human review.
  if (before.length * after.length > 1_000_000) return [{ start: prefix, end: base.length - suffix, lines: after }]
  const width = after.length + 1, lcs = new Uint32Array((before.length + 1) * width)
  for (let i = before.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--) {
    lcs[i * width + j] = before[i] === after[j] ? lcs[(i + 1) * width + j + 1]! + 1
      : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
  }
  const edits: LineEdit[] = []
  let i = 0, j = 0, edit: LineEdit | undefined
  const flush = () => {
    if (!edit) return
    if (edit.end - edit.start === edit.lines.length && edit.lines.length > 1) {
      edits.push(...edit.lines.map((line, index) => ({ start: edit!.start + index, end: edit!.start + index + 1, lines: [line] })))
    } else edits.push(edit)
    edit = undefined
  }
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) { flush(); i++; j++; continue }
    edit ||= { start: prefix + i, end: prefix + i, lines: [] }
    if (j < after.length && (i === before.length || lcs[i * width + j + 1]! > lcs[(i + 1) * width + j]!)) edit.lines.push(after[j++]!)
    else { i++; edit.end = prefix + i }
  }
  flush()
  return edits
}

function overlaps(left: LineEdit, right: LineEdit): boolean {
  if (left.start === left.end && right.start === right.end) return left.start === right.start
  if (left.start === left.end) return left.start > right.start && left.start < right.end
  if (right.start === right.end) return right.start > left.start && right.start < left.end
  return left.start < right.end && right.start < left.end
}

function mergeSection(baseText: string, customText: string, sourceText: string): { text: string; conflict: boolean } {
  if (customText === baseText) return { text: sourceText, conflict: false }
  if (sourceText === baseText || sourceText === customText) return { text: customText, conflict: false }
  const base = lines(baseText), custom = lineEdits(base, lines(customText)), source = lineEdits(base, lines(sourceText))
  let conflict = false
  const combined = [...custom]
  for (const edit of source) {
    const collisions = custom.filter(other => overlaps(edit, other))
    if (!collisions.length) combined.push(edit)
    else if (!collisions.every(other => other.start === edit.start && other.end === edit.end && equalLines(other.lines, edit.lines))) conflict = true
  }
  let cursor = 0
  const result: string[] = []
  for (const edit of combined.sort((left, right) => left.start - right.start || left.end - right.end)) {
    result.push(...base.slice(cursor, edit.start), ...edit.lines)
    cursor = edit.end
  }
  result.push(...base.slice(cursor))
  return { text: result.join(''), conflict }
}

function clearPending(block: PromptSectionBlock): PromptSectionBlock {
  const { pendingSourceText: _pending, sourceStatus: _status, ...rest } = block
  return rest
}

function sourceSection(block: PromptSectionBlock, text: string, sourceText: string): PromptSectionBlock {
  const { deleted: _deleted, deletionSource: _deletion, ...active } = clearPending(block)
  return { ...active, text, sourceText, ...(!text ? { deleted: true, deletionSource: 'source' as const } : {}) }
}

/** Reconcile defaults at line granularity while retaining creator choices and IDs. */
export function reconcilePromptSectionDocument(document: PromptSectionDocument, nextSource: string,
  options: { body?: string } = {}): PromptSectionDocument {
  const blocks = document.blocks.map(block => ({ ...block }))
  const managed = blocks.filter(block => block.kind === 'managed')
  const source = parsePromptSectionDocument(nextSource).blocks.filter(block => block.kind === 'managed')
  const pairs = pairSections(managed, source), pairedSource = new Set([...pairs.values()].map(block => block.id))
  const reserved = new Set(blocks.map(block => block.id))
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!
    if (block.kind !== 'managed') continue
    const next = pairs.get(block.id)?.text || '', baseline = block.sourceText ?? next
    if (pairs.has(block.id) && pairs.ambiguous.has(block.id) && block.sourceText !== undefined && next !== baseline) {
      blocks[index] = { ...block, pendingSourceText: next, sourceStatus: 'source_changed' }
      continue
    }
    if (block.deleted && block.deletionSource !== 'source') {
      blocks[index] = next !== baseline && next ? { ...block, pendingSourceText: next, sourceStatus: 'source_changed' }
        : { ...clearPending(block), sourceText: next }
      continue
    }
    const merged = mergeSection(baseline, block.text, next)
    blocks[index] = merged.conflict ? { ...block, text: merged.text, pendingSourceText: next, sourceStatus: 'source_changed' }
      : sourceSection(block, merged.text, next)
  }
  for (const block of source) {
    if (pairedSource.has(block.id)) continue
    const serialized = serializePromptSectionDocument({ version: 1, blocks })
    // A managed section owns its two separator newlines. Existing trailing
    // whitespace belongs to the authored body and must survive stripping it.
    const separator = serialized ? '\n\n' : ''
    if (separator) blocks.push({ id: freshId('body', reserved), kind: 'body', text: separator })
    blocks.push({ ...block, id: freshId('managed', reserved), sourceText: block.text })
  }
  if (options.body !== undefined) {
    const currentBody = stripManagedPromptBlocks(serializePromptSectionDocument({ version: 1, blocks }))
    if (options.body !== currentBody) {
      const firstBody = blocks.find(block => block.kind === 'body')
      const sections = blocks.filter(block => block.kind === 'managed')
      const body: PromptSectionBlock = { id: firstBody?.id || freshId('body', reserved), kind: 'body', text: options.body }
      const rebuilt = [body]
      for (const block of sections) {
        if (block.text && !block.deleted) {
          const text = serializePromptSectionDocument({ version: 1, blocks: rebuilt })
          if (text) rebuilt.push({ id: freshId('body', reserved), kind: 'body', text: '\n\n' })
        }
        rebuilt.push(block)
      }
      return { version: 1, blocks: rebuilt }
    }
  }
  return { version: 1, blocks }
}

/** Accept the new baseline while keeping custom text, or replace it with source. */
export function resolvePromptSectionSource(document: PromptSectionDocument, id: string,
  action: 'keep_custom' | 'follow_source'): PromptSectionDocument {
  return { version: 1, blocks: document.blocks.map(block => {
    if (block.id !== id || block.kind !== 'managed') return { ...block }
    const target = block.pendingSourceText ?? block.sourceText ?? block.text
    const next = { ...clearPending(block), sourceText: target }
    return action === 'follow_source' ? sourceSection(next, target, target) : next
  }) }
}
