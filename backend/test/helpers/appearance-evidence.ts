import assert from 'node:assert/strict'
import { appearanceEvidence } from '../../src/modules/visuals/visual-appearance-evidence.js'
/** Mock-only encoder: choose the source candidate with greatest overlap with
 * the test author's already chosen quote. Production never uses this helper. */
export function evidenceWireValue(shot: any, value: any): any {
  const refs = appearanceEvidence(shot)
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => evidenceWireValue(shot, item))
  if (Object.keys(value).length === 2 && typeof value.field === 'string' && typeof value.quote === 'string') {
    const start = shot[value.field].indexOf(value.quote)
    assert.ok(start >= 0, 'test proof must be an exact source slice')
    const end = start + value.quote.length
    const candidate = refs.candidates.filter(item => item.field === value.field).sort((a,b) =>
      Math.max(0,Math.min(end,b.end)-Math.max(start,b.start)) - Math.max(0,Math.min(end,a.end)-Math.max(start,a.start)))[0]
    assert.ok(candidate)
    return { ref_id:candidate.ref_id }
  }
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,evidenceWireValue(shot,item)]))
}
