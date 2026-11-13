import type { z } from 'zod'

function withoutReasoning(raw: string): string {
  // An abandoned string cannot shield an external reasoning block. Protect
  // literal tags only inside strings belonging to a complete JSON candidate.
  const ranges: Array<{ start: number; end: number }> = []
  scanJsonCandidates(raw, (_value, candidate) => {
    let start = -1, escaped = false
    for (let index = candidate.start; index < candidate.end; index++) {
      const character = raw[index]!
      if (start < 0) { if (character === '"') start = index }
      else if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') { ranges.push({ start, end: index + 1 }); start = -1 }
    }
  })
  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  const protectedRanges = ranges.filter((range, index) => !index || range.start >= ranges[index - 1]!.end)
  const protectedAt = (index: number) => {
    let low = 0, high = protectedRanges.length - 1
    while (low <= high) {
      const middle = (low + high) >>> 1, range = protectedRanges[middle]!
      if (index < range.start) high = middle - 1
      else if (index >= range.end) low = middle + 1
      else return true
    }
    return false
  }
  const parts: string[] = []
  let cursor = 0
  const openings = /<think\b[^>]*>/gi
  for (let opening = openings.exec(raw); opening; opening = openings.exec(raw)) {
    if (protectedAt(opening.index)) continue
    parts.push(raw.slice(cursor, opening.index))
    const tags = /<think\b[^>]*>|<\/think\s*>/gi
    tags.lastIndex = openings.lastIndex
    let depth = 1, closing: RegExpExecArray | null = null
    for (let tag = tags.exec(raw); tag; tag = tags.exec(raw)) {
      if (protectedAt(tag.index)) continue
      depth += tag[0][1] === '/' ? -1 : 1
      if (!depth) { closing = tag; break }
    }
    if (!closing) return parts.join('')
    cursor = tags.lastIndex; openings.lastIndex = cursor
  }
  parts.push(raw.slice(cursor))
  return parts.join('')
}

/** Keep both JSON boundaries available for local diagnostics, without exposing
 * external reasoning blocks or returning unbounded model output to the UI. */
export function structuredOutputDiagnosticText(raw: string): string {
  const content = withoutReasoning(raw), limit = 200000
  if (content.length <= limit) return content
  const marker = '\n…（中间内容已省略）…\n', head = Math.floor((limit - marker.length) / 2)
  return content.slice(0, head) + marker + content.slice(-(limit - marker.length - head))
}

/** These syntax repairs preserve string contents and never supply missing data. */
function recoverJsonSyntax(raw: string): string {
  const parts: string[] = []
  let inString = false, escaped = false
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index]!
    if (inString) {
      if (!escaped && (character === '\n' || character === '\r')) {
        parts.push(character === '\n' ? '\\n' : '\\r')
        continue
      }
      parts.push(character)
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    if (character === ',') {
      let before = index - 1, after = index + 1
      while (before >= 0 && /\s/.test(raw[before]!)) before--
      while (after < raw.length && /\s/.test(raw[after]!)) after++
      // A comma without a preceding value is a missing field/array element,
      // not a trailing separator that can safely be removed.
      if (before >= 0 && !'[{,:'.includes(raw[before]!) && (raw[after] === ']' || raw[after] === '}')) continue
    }
    parts.push(character)
  }
  return parts.join('')
}

export type StructuredOutputCandidate = { start: number; end: number; depth: number; recovered: boolean }

function scanJsonCandidates(content: string, visit: (value: unknown, candidate: StructuredOutputCandidate) => void): void {
  const checked = new Set<string>()

  const scan = (allowLineBreaks: boolean) => {
    const openings: Array<{ character: string; index: number }> = []
    let inString = false, escaped = false, abandoned = false
    for (let index = 0; index < content.length; index++) {
      const character = content[index]!
      if (!openings.length) {
        if (character === '{' || character === '[') openings.push({ character, index })
        continue
      }
      if (inString) {
        if (!allowLineBreaks && (character === '\n' || character === '\r')) {
          // Preserve recovery of a later complete response after an abandoned string.
          openings.length = 0; inString = false; escaped = false; abandoned = true
        } else if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') inString = true
      else if (character === '{' || character === '[') openings.push({ character, index })
      else if (character === '}' || character === ']') {
        const opening = openings.pop()!
        if (opening.character !== (character === '}' ? '{' : '[')) { openings.length = 0; abandoned = true; continue }
        const start = opening.index, end = index + 1, key = `${start}:${end}`
        if (checked.has(key)) continue
        checked.add(key)
        const fragment = content.slice(start, end)
        let candidate: unknown, recovered = false
        try { candidate = JSON.parse(fragment) }
        catch {
          const restored = recoverJsonSyntax(fragment)
          if (restored === fragment) continue
          try { candidate = JSON.parse(restored); recovered = true } catch { continue }
        }
        // Resetting after damaged syntax allows later usable objects, but it
        // cannot establish that a zero-match fragment is the response root.
        visit(candidate, { start, end, depth: openings.length + (abandoned ? 1 : 0), recovered })
      }
    }
  }
  scan(false)
  scan(true)
}

export function parseStructuredOutput<T>(raw: string, schema: z.ZodType<T>, options: {
  onCandidate?: (value: unknown, candidate: StructuredOutputCandidate) => void
} = {}): T | null {
  const content = withoutReasoning(raw)
  const result: { lastValid: { value: T; start: number; end: number } | null } = { lastValid: null }
  scanJsonCandidates(content, (candidate, metadata) => {
    options.onCandidate?.(candidate, metadata)
    try {
      const parsed = schema.safeParse(candidate), previous = result.lastValid
      const { start, end } = metadata
      if (parsed.success && (!previous || end > previous.end || end === previous.end && start < previous.start)) {
        result.lastValid = { value: parsed.data, start, end }
      }
    } catch { /* A later candidate can still satisfy the task schema. */ }
  })
  return result.lastValid?.value ?? null
}
