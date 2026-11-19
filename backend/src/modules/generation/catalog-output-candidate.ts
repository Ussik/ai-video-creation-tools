import { createHash } from 'node:crypto'
import { z } from 'zod'
import { recoverStringFieldSyntax } from './stage-content-syntax.js'
import { hasUniqueJsonKeys } from './model-output-syntax-repair.js'

export const catalogCorrectionCandidateSchema = z.object({ policy: z.literal('visual-catalog-quote-candidate-v1'),
  raw_hash: z.string(), repaired_hash: z.string(), candidate_hash: z.string(),
  envelope: z.enum(['json', 'json_fence']), escape_offsets: z.array(z.number().int().nonnegative()), candidate: z.unknown(),
}).strict()
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex')

/** Only one complete response envelope qualifies. Never borrow the parser's
 * last/nested candidate. Quote recovery is insertion-only, unique and private;
 * its value may guide a field correction, never authorize business adoption. */
export function catalogOutputCandidate(raw: string): { value: unknown; audit?: z.infer<typeof catalogCorrectionCandidateSchema> } | undefined {
  if (raw.length > 650000) return
  const trimmed = raw.trim(), leading = raw.indexOf(trimmed)
  let payload = trimmed, offset = leading, envelope: 'json' | 'json_fence' = 'json'
  const fence = /^([^`{}\[\]<>]{0,512})```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```([^`{}\[\]<>]{0,512})$/i.exec(trimmed)
  if (fence) {
    payload = fence[2]!
    if (payload.includes('```')) return
    offset = leading + fence[1]!.length + trimmed.slice(fence[1]!.length).indexOf('\n') + 1
    envelope = 'json_fence'
  }
  if (!payload.trimStart().startsWith('{') || !payload.trimEnd().endsWith('}')) return
  try {
    const value: unknown = JSON.parse(payload)
    return hasUniqueJsonKeys(payload) ? { value } : undefined
  } catch { /* Only narrowly proven quote insertion can supply a correction candidate. */ }
  const proposal = recoverStringFieldSyntax(payload, ['definition'])
  if (!proposal) return
  const offsets = proposal.audit.escape_offsets.map(at => offset + at)
  let repaired = raw
  for (const at of [...offsets].reverse()) repaired = repaired.slice(0, at) + '\\' + repaired.slice(at)
  let inverse = repaired
  for (let index = offsets.length - 1; index >= 0; index--) {
    const at = offsets[index]! + index
    if (inverse[at] !== '\\' || inverse[at + 1] !== '"') return
    inverse = inverse.slice(0, at) + inverse.slice(at + 1)
  }
  if (inverse !== raw) return
  return { value: proposal.value, audit: { policy: 'visual-catalog-quote-candidate-v1', envelope,
    raw_hash: hash(raw), repaired_hash: hash(repaired), candidate_hash: hash(JSON.stringify(proposal.value)),
    escape_offsets: offsets, candidate: structuredClone(proposal.value) } }
}
