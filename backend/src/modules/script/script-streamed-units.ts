type ObjectRole = 'root' | 'result' | 'other'

const stopPrefix = Symbol('incomplete or invalid JSON prefix')

/** Read only the grammatical prefix of one JSON object. Never search past an
 * invalid token for another object: prose and quoted examples are not units. */
class StreamedUnitsReader {
  private cursor = 0

  constructor(private readonly raw: string, private readonly units: Record<string, unknown[]>) {}

  read(): void {
    try {
      this.whitespace()
      if (this.raw[this.cursor] !== '{') return
      this.object('root', 0)
    } catch (error) {
      if (error !== stopPrefix) throw error
    }
  }

  private whitespace(): void {
    while (this.cursor < this.raw.length && /[ \t\r\n]/.test(this.raw[this.cursor]!)) this.cursor++
  }

  private expect(character: string): void {
    if (this.raw[this.cursor] !== character) throw stopPrefix
    this.cursor++
  }

  private string(): string {
    const start = this.cursor
    this.expect('"')
    while (this.cursor < this.raw.length) {
      const character = this.raw[this.cursor++]!
      if (character === '"') return JSON.parse(this.raw.slice(start, this.cursor)) as string
      if (character.charCodeAt(0) < 0x20) throw stopPrefix
      if (character !== '\\') continue
      const escape = this.raw[this.cursor++]
      if (escape === 'u') {
        const digits = this.raw.slice(this.cursor, this.cursor + 4)
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) throw stopPrefix
        this.cursor += 4
      } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) throw stopPrefix
    }
    throw stopPrefix
  }

  private value(depth: number, role: ObjectRole = 'other', target?: unknown[]): void {
    // Prevent hostile or malformed nesting from overflowing the JS stack.
    if (depth > 256) throw stopPrefix
    this.whitespace()
    const character = this.raw[this.cursor]
    if (character === '{') return this.object(role, depth)
    if (character === '[') return this.array(target, depth)
    if (character === '"') { this.string(); return }
    for (const literal of ['true', 'false', 'null']) if (this.raw.startsWith(literal, this.cursor)) {
      this.cursor += literal.length
      return
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.raw.slice(this.cursor))
    if (!number) throw stopPrefix
    this.cursor += number[0].length
  }

  private object(role: ObjectRole, depth: number): void {
    this.expect('{')
    this.whitespace()
    if (this.raw[this.cursor] === '}') { this.cursor++; return }
    while (this.cursor < this.raw.length) {
      const key = this.string()
      this.whitespace()
      this.expect(':')
      const target = role !== 'other' && Object.hasOwn(this.units, key) ? this.units[key] : undefined
      this.value(depth + 1, role === 'root' && key === 'result' ? 'result' : 'other', target)
      this.whitespace()
      if (this.raw[this.cursor] === '}') { this.cursor++; return }
      this.expect(',')
      this.whitespace()
    }
    throw stopPrefix
  }

  private array(target: unknown[] | undefined, depth: number): void {
    this.expect('[')
    this.whitespace()
    if (this.raw[this.cursor] === ']') { this.cursor++; return }
    while (this.cursor < this.raw.length) {
      const start = this.cursor
      const objectMember = this.raw[start] === '{'
      this.value(depth + 1)
      // Parsing must reach the object's closing brace before anything is kept.
      // This also validates its entire JSON syntax, including nested values.
      if (target && objectMember) target.push(JSON.parse(this.raw.slice(start, this.cursor)))
      this.whitespace()
      if (this.raw[this.cursor] === ']') { this.cursor++; return }
      this.expect(',')
      this.whitespace()
    }
    throw stopPrefix
  }
}

/** Recover only closed direct members of $.artifacts / $.scenes, including
 * those inside one $.result wrapper. Partial fields are never repaired. */
export function recoverWorkflowStream(raw: string): { artifacts: unknown[]; scenes: unknown[] } {
  const units = { artifacts: [] as unknown[], scenes: [] as unknown[] }
  new StreamedUnitsReader(raw, units).read()
  return units
}

/** The continuation schema uses complete blocks rather than partial text. */
export function recoverBlockStream(raw: string): { blocks: unknown[] } {
  const units = { blocks: [] as unknown[] }
  new StreamedUnitsReader(raw, units).read()
  return units
}

/** Recover only closed object members of one direct array, using the same
 * grammatical-prefix rules as stage continuation. Never repairs partial JSON. */
export function recoverArrayStream(raw: string, key: string): unknown[] {
  const units = { [key]: [] as unknown[] }
  new StreamedUnitsReader(raw, units).read()
  return units[key]!
}

type StreamSnapshot<T> = T & { changed: boolean; reset: boolean }

/** A lexical gate avoids reparsing the whole response on every text delta.
 * Only a newly closed object at a possible direct-member depth can expose a
 * unit. The strict reader still decides whether its grammatical path is real.
 * A provider retry that replaces the cumulative response resets the gate. */
function createStreamReader<T extends Record<string, unknown[]>>(recover: (raw: string) => T) {
  let previousRaw = '', cursor = 0, depth = 0, inString = false, escaped = false
  let latest = recover('')
  return {
    read(raw: string): StreamSnapshot<T> {
      const reset = raw.length < previousRaw.length || !raw.startsWith(previousRaw)
      let changed = false
      if (reset) {
        changed = Object.values(latest).some(units => units.length > 0)
        cursor = 0; depth = 0; inString = false; escaped = false
        latest = recover('')
      }
      let possibleMember = false
      for (; cursor < raw.length; cursor++) {
        const character = raw[cursor]
        if (inString) {
          if (escaped) escaped = false
          else if (character === '\\') escaped = true
          else if (character === '"') inString = false
          continue
        }
        if (character === '"') inString = true
        else if (character === '{' || character === '[') depth++
        else if (character === '}' || character === ']') {
          if (character === '}' && (depth === 3 || depth === 4)) possibleMember = true
          depth--
        }
      }
      previousRaw = raw
      if (possibleMember) {
        const recovered = recover(raw)
        changed ||= Object.keys(recovered).some(key => recovered[key]!.length !== latest[key]!.length)
        latest = recovered
      }
      return { ...latest, changed, reset }
    },
  }
}

/** Accepts the cumulative raw text of successive deltas for one response. */
export const createWorkflowStreamReader = () => createStreamReader(recoverWorkflowStream)
export const createBlockStreamReader = () => createStreamReader(recoverBlockStream)
