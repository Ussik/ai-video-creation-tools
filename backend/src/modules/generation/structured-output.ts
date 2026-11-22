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

export function jsonParseErrorDetails(raw: string): { position?: number; line?: number; column?: number; context?: string } {
  try { JSON.parse(raw); return {} } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const match = message.match(/(?:position|at position)\s+(\d+)/i)
    const position = match ? Number(match[1]) : undefined
    if (position === undefined || !Number.isSafeInteger(position)) return { context: message.slice(0, 300) }
    const before = raw.slice(0, position), line = before.split('\n').length
    const lastBreak = before.lastIndexOf('\n'), column = position - lastBreak
    return { position, line, column, context: raw.slice(Math.max(0, position - 120), Math.min(raw.length, position + 120)) }
  }
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

/** Escape only quotes that are unambiguously inside a JSON string. A quote is
 * treated as content when the next non-space character cannot close a JSON
 * string or separate an object/array value. Ambiguous cases are preserved. */
export function repairUnescapedStringQuotes(raw: string): { text: string; applied: boolean; changes: number } {
  const parts: string[] = []
  let inString = false, escaped = false, stringHasContent = false, changes = 0
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index]!
    if (!inString) {
      parts.push(character)
      if (character === '"') { inString = true; stringHasContent = false }
      continue
    }
    if (escaped) { parts.push(character); escaped = false; continue }
    if (character === '\\') { parts.push(character); escaped = true; continue }
    if (character !== '"') { parts.push(character); if (!/\s/.test(character)) stringHasContent = true; continue }
    let next = index + 1
    while (next < raw.length && /\s/.test(raw[next]!)) next++
    const after = raw[next]
    let afterAfter = next + 1
    while (afterAfter < raw.length && /\s/.test(raw[afterAfter]!)) afterAfter++
    const quotePairIsContent = after === '"' && stringHasContent && [',', '}', ']', ':', undefined].includes(raw[afterAfter])
    const closes = !quotePairIsContent && (next >= raw.length || after === ',' || after === '}' || after === ']' || after === ':' || after === '"')
    if (closes) { parts.push(character); inString = false }
    else { parts.push('\\"'); changes++ }
  }
  return { text: parts.join(''), applied: changes > 0, changes }
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
          const quoted = repairUnescapedStringQuotes(restored)
          const repaired = quoted.applied ? quoted.text : restored
          if (repaired === fragment) continue
          try { candidate = JSON.parse(repaired); recovered = true } catch { continue }
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

/** A single complete root, optionally inside exactly one JSON code fence.
 * Unlike candidate recovery this never accepts surrounding prose, nested
 * fragments, multiple roots, unfinished fences or repaired JSON syntax.
 *
 * Set `fallbackToCandidate` to automatically try candidate scanning if the
 * strict complete-root check fails — useful for local corrections where the
 * model may have added explanation text. */
export function completeStructuredRoot(raw: string, options: {
  allowFenceExplanation?: boolean
  fallbackToCandidate?: boolean
  candidateSchema?: z.ZodType
} = {}): { value: unknown; recovered?: boolean } | undefined {
  const text = raw.trim()
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text)
  let payload = fenced ? fenced[1]! : text
  if (!fenced && options.allowFenceExplanation) {
    // Exactly one explicit JSON fence with bounded plain-language decoration.
    // Relaxed pattern: allow backticks, brackets in decoration, but no nested fences or reasoning tags.
    // The key safety check is: no nested ``` inside the JSON fence itself.
    const envelope = /^([\s\S]{0,1024}?)```json[ \t]*\r?\n([\s\S]*?)\r?\n```([\s\S]{0,1024}?)$/i.exec(text)
    if (envelope && !envelope[2]!.includes('```') && !/<think>/i.test(envelope[1]! + envelope[3]!)) {
      payload = envelope[2]!
    }
  }

  // Attempt to parse as-is first
  try { return { value: JSON.parse(payload) } }
  catch (firstError) {
    // Attempt automatic JSON repair for common issues
    const repaired = attemptJsonRepair(payload)
    if (repaired !== payload) {
      try { return { value: JSON.parse(repaired) } }
      catch { /* Fall through to candidate scanning if enabled */ }
    }

    // If strict parsing failed and fallback is enabled, try candidate scanning
    if (options.fallbackToCandidate && options.candidateSchema) {
      const candidate = parseStructuredOutput(raw, options.candidateSchema)
      if (candidate !== null) {
        return { value: candidate, recovered: true }
      }
    }

    return undefined
  }
}

/** Attempt to repair common JSON syntax errors in local corrections.
 * Uses the same strong heuristic repair that candidate scanning uses. */
function attemptJsonRepair(json: string): string {
  // First apply syntax recovery (handles newlines in strings, trailing commas)
  const syntaxFixed = recoverJsonSyntax(json)

  // Then apply the strong quote repair heuristic
  const { text: quoteFixed, applied } = repairUnescapedStringQuotes(syntaxFixed)

  return applied ? quoteFixed : syntaxFixed
}
