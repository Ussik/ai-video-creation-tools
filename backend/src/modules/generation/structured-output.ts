import type { z } from 'zod'

function withoutReasoning(raw: string): string {
  return raw
    .replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, '')
    .replace(/<think\b[^>]*>[\s\S]*$/i, '')
}

export function parseStructuredOutput<T>(raw: string, schema: z.ZodType<T>): T | null {
  const content = withoutReasoning(raw)
  const openings: number[] = []
  let inString = false
  let escaped = false
  let lastValid: T | null = null

  for (let index = 0; index < content.length; index++) {
    const character = content[index]
    if (!openings.length) {
      if (character === '{') openings.push(index)
      continue
    }
    if (inString) {
      if (character === '\n' || character === '\r') {
        // A raw line break cannot occur in a JSON string; resume at the next candidate.
        openings.length = 0
        inString = false
        escaped = false
      } else if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') openings.push(index)
    else if (character === '}') {
      const start = openings.pop()!
      try {
        const candidate: unknown = JSON.parse(content.slice(start, index + 1))
        const parsed = schema.safeParse(candidate)
        if (parsed.success) lastValid = parsed.data
      } catch {
        // Keep scanning: a later response may contain the usable object.
      }
    }
  }

  return lastValid
}
