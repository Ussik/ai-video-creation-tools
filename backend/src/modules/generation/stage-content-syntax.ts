import { createHash } from 'node:crypto'
import { hasUniqueJsonKeys, type QuotedLineProposal } from './model-output-syntax-repair.js'

/** Content-only insertion recovery. Enumerate complete JSON interpretations;
 * accept exactly one. Other fields, escapes and all prose bytes stay intact. */
export function recoverStageContentSyntax(raw: string): QuotedLineProposal | undefined {
  return recoverStringFieldSyntax(raw, ['content'])
}

/** Private correction candidates may authorize a different code-owned string
 * field; this never widens ordinary stage-content acceptance. */
export function recoverStringFieldSyntax(raw: string, fields: readonly string[]): QuotedLineProposal | undefined {
  if (raw.length > 650000) return
  const opening = /^\s*```(?:json)?[ \t]*\r?\n/i.exec(raw)
  const at = opening?.[0].length ?? raw.length - raw.trimStart().length
  const body = raw.slice(at).replace(/\s*```\s*$/, '').trimEnd()
  try { JSON.parse(body); return } catch { /* invalid roots only */ }
  let visits = 0
  type State = { end: number; offsets: number[] }
  const space = (i: number) => { while (/\s/.test(body[i] || '') && i < body.length) i++; return i }
  function stringEnd(i: number): number {
    for (let j = i + 1; j < body.length; j++) {
      if (body[j] === '\\') { j++; continue }
      if (body[j] === '"') return j + 1
      if (body.charCodeAt(j) < 32) return -1
    }
    return -1
  }
  function* value(start: number, content: boolean, depth: number): Generator<State> {
    if (++visits > 20000 || depth > 64) return
    const i = space(start), ch = body[i]
    if (ch === '"') {
      if (!content) {
        const end = stringEnd(i)
        if (end > 0) { try { JSON.parse(body.slice(i, end)); yield { end, offsets: [] } } catch {} }
        return
      }
      const offsets: number[] = []
      for (let j = i + 1; j < body.length; j++) {
        if (body[j] === '\\') { j++; continue }
        if (body.charCodeAt(j) < 32) return
        if (body[j] !== '"') continue
        const next = body[space(j + 1)]
        if (next === ',' || next === '}' || next === ']') yield { end: j + 1, offsets: [...offsets] }
        // A property-looking boundary is ambiguous; never swallow it as prose.
        if (next === ':') return
        offsets.push(j)
        if (offsets.length > 1000) return
      }
      return
    }
    if (ch === '{' || ch === '[') {
      const object = ch === '{', close = object ? '}' : ']'
      function* entries(pos: number, offsets: number[], first: boolean): Generator<State> {
        if (++visits > 20000) return
        let cursor = space(pos)
        if (body[cursor] === close) { if (first) yield { end: cursor + 1, offsets }; return }
        let key = ''
        if (object) {
          if (body[cursor] !== '"') return
          const end = stringEnd(cursor)
          if (end < 0) return
          try { key = JSON.parse(body.slice(cursor, end)) } catch { return }
          cursor = space(end)
          if (body[cursor++] !== ':') return
        }
        for (const child of value(cursor, object && fields.includes(key), depth + 1)) {
          const end = space(child.end), all = [...offsets, ...child.offsets]
          if (body[end] === close) yield { end: end + 1, offsets: all }
          else if (body[end] === ',') yield* entries(end + 1, all, false)
        }
      }
      yield* entries(i + 1, [], true)
      return
    }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(body.slice(i))
    if (primitive) yield { end: i + primitive[0].length, offsets: [] }
  }
  const candidates: Array<{ offsets: number[]; repaired: string; value: unknown }> = []
  try { for (const result of value(0, false, 0)) {
    if (space(result.end) !== body.length || !result.offsets.length) continue
    let repaired = body
    for (const offset of [...result.offsets].reverse()) repaired = repaired.slice(0, offset) + '\\' + repaired.slice(offset)
    try {
      const parsed: unknown = JSON.parse(repaired)
      if (!hasUniqueJsonKeys(repaired)) continue
      candidates.push({ offsets: result.offsets, repaired, value: parsed })
      if (candidates.length > 1) return
    } catch { /* reject every non-quote syntax defect */ }
  }
  } catch { return } // Excessive nesting or branching must fail closed.
  if (visits > 20000 || candidates.length !== 1) return
  const candidate = candidates[0]!, offsets = candidate.offsets.map(offset => at + offset)
  let repairedRaw = raw
  for (const offset of [...offsets].reverse()) repairedRaw = repairedRaw.slice(0, offset) + '\\' + repairedRaw.slice(offset)
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  return { value: candidate.value, repairedRaw, targets: [], audit: { policy: 'stage-content-v1-insertion-only',
    original_hash: hash(raw), repaired_hash: hash(repairedRaw), escape_offsets: offsets } }
}
