import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Shot } from '../../infrastructure/database/db.js'

const fields = ['image_prompt', 'video_prompt', 'start_state', 'end_state'] as const
type Field = typeof fields[number]
type Mode = 'image' | 'video'
export type AppearanceEvidenceRef = { ref_id: string; field: Field; quote: string; start: number; end: number }
export type AppearanceEvidenceIssue = { code: string; field_path: string; path: string[]; message: string }
const allowed: Record<Mode, readonly Field[]> = { image: ['image_prompt', 'start_state'], video: ['video_prompt', 'start_state', 'end_state'] }

/** IDs bind a contiguous exact slice to this shot and all four phase fields.
 * No model-authored quote, offset or guessed ID becomes source evidence. */
export function appearanceEvidence(shot: Shot) {
  const source = Object.fromEntries(fields.map(field => [field, shot[field] || ''])) as Record<Field, string>
  const source_version = createHash('sha256').update(JSON.stringify({ shot_id: shot.id, source })).digest('hex')
  const candidates: AppearanceEvidenceRef[] = []
  for (const field of fields) {
    const text = source[field]
    for (const match of text.matchAll(/[^。！？.!?\n]+(?:[。！？.!?]|\n|$)/gu)) {
      const sentence = match[0], offset = match.index!
      for (let start = 0; start < sentence.length; start += 600) {
        const chunk = sentence.slice(start, start + 600), quote = chunk.trim()
        if (quote.length < 4) continue
        const from = offset + start + chunk.indexOf(quote), end = from + quote.length
        candidates.push({ ref_id: `ae1_${source_version.slice(0, 24)}_${field}_${from}_${end}`, field, quote, start: from, end })
      }
    }
  }
  const byId = new Map(candidates.map(item => [item.ref_id, item]))
  const forMode = (mode: Mode) => candidates.filter(item => allowed[mode].includes(item.field))
  const schema = (mode: Mode) => {
    const ids = forMode(mode).map(item => item.ref_id)
    return z.object({ ref_id: ids.length ? z.enum(ids as [string, ...string[]]) : z.literal('no_evidence_available') }).strict()
  }
  const isReference = (proof: any) => proof && typeof proof === 'object' && !Array.isArray(proof) && Object.keys(proof).length === 1 && typeof proof.ref_id === 'string'
  const resolve = (mode: Mode, proof: any) => {
    if (!isReference(proof)) return proof
    const candidate = byId.get(proof.ref_id)
    return candidate && allowed[mode].includes(candidate.field) ? { field: candidate.field, quote: candidate.quote } : proof
  }
  const normalize = (raw: any) => {
    if (!raw || typeof raw !== 'object' || !raw.decisions || Array.isArray(raw.decisions)) return raw
    const result = structuredClone(raw)
    for (const decision of Object.values(result.decisions) as any[]) for (const mode of ['image', 'video'] as const) {
      if (decision?.[mode]?.evidence) decision[mode].evidence = resolve(mode, decision[mode].evidence)
    }
    return result
  }
  const invalidReferences = (raw: any): AppearanceEvidenceIssue[] => Object.entries(raw?.decisions || {}).flatMap(([key, decision]: [string, any]) =>
    (['image', 'video'] as const).flatMap(mode => {
      const proof = decision?.[mode]?.evidence
      if (!isReference(proof)) return []
      const candidate = byId.get(proof.ref_id)
      if (candidate && allowed[mode].includes(candidate.field)) return []
      const path = ['decisions', key, mode, 'evidence']
      return [{ code: candidate ? 'visual_coverage_evidence_stage' : 'visual_coverage_evidence_reference', path, field_path: path.join('.'),
        message: candidate ? `${mode}证据ID不属于本阶段；首帧只允许image_prompt/start_state，视频只允许video_prompt/start_state/end_state。`
          : '证据ID不属于本镜当前原文版本；请仅选择本次提供的同阶段候选ID，不能猜测或沿用旧ID。' }]
    }))
  return { source_version, candidates, forMode, schema, resolve, normalize, invalidReferences }
}

/** Diagnosis only: never turn a stitched quote into a visibility decision. */
export function quoteIsNoncontiguous(source: string, quote: string) {
  const parts = quote.match(/[^。！？.!?\n]+(?:[。！？.!?]|\n|$)/gu) || []
  if (parts.length < 2) return false
  let end = 0, gap = false
  for (const part of parts) {
    const start = source.indexOf(part, end)
    if (start < 0) return false
    if (end > 0 && start > end) gap = true
    end = start + part.length
  }
  return gap
}
