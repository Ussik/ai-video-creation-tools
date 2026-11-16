import assert from 'node:assert/strict'
import type { StructuredGenerator } from '../../src/modules/generation/model-output.js'
import { reviewScriptDraftCompleteness, type ScriptDraftReviewOptions } from '../../src/modules/script/script-draft-completeness.js'
import type { WorkflowDraft } from '../../src/modules/script/script-workflow.js'

type Material = { key: string; title: string; artifact_type: string; source_ref: string; units: Array<{ id: number; text: string }> }
export function draftReviewCoordinateMaterial(prompt: string): Material[] {
  const marker = '待核对草稿原文（资料）：'
  const at = prompt.lastIndexOf(marker)
  assert.ok(at >= 0, 'fresh coordinate fixture requires the actual candidate packet')
  return JSON.parse(prompt.slice(at + marker.length).split('\n【本轮候选正文结束】')[0]!)
}
export function draftReviewFixtureSources(prompt: string) {
  return draftReviewCoordinateMaterial(prompt).map(({ units, source_ref: _ref, ...source }) => ({ ...source,
    content: Array.isArray(units) ? units.map(unit => unit.text).join('') : (source as unknown as { content: string }).content }))
}
/** Explicit test-wire adapter for semantic fixtures with REAL candidate quotes.
 * Invalid source/quote tests must write invalid coordinate responses directly;
 * this helper never guesses evidence for a fabricated fixture quotation. */
export function coordinateFixtureJson(value: unknown, prompt: string): string {
  const sources = draftReviewCoordinateMaterial(prompt)
  const item = (raw: unknown) => {
    assert.ok(raw && typeof raw === 'object')
    const finding = raw as Record<string, unknown>
    if (!('quote' in finding)) return finding
    const source = sources.find(source => source.key === finding.source_key)
    assert.ok(source, 'coordinate fixtures require a real candidate source; explicit fault tests must construct wrong coordinates')
    assert.equal(typeof finding.quote, 'string')
    const quote = finding.quote as string, content = source.units.map(unit => unit.text).join('')
    const start = content.indexOf(quote)
    assert.ok(quote.length && start >= 0, 'coordinate fixture quote must be exact candidate text; legacy quote repair belongs to explicit legacy tests')
    let offset = 0
    const addressed = source.units.map(unit => { const result = { ...unit, offset }; offset += unit.text.length; return result })
    const first = addressed.find(unit => unit.offset + unit.text.length > start)!
    const last = addressed.find(unit => unit.offset + unit.text.length >= start + quote.length)!
    const { quote: _quote, ...semantic } = finding
    return { ...semantic, source_ref: source.source_ref, first_unit: first.id, last_unit: last.id }
  }
  if (value && typeof value === 'object') {
    if ('findings' in value && Array.isArray(value.findings)) value = { ...value, facts: [], findings: value.findings.map(item) }
    else if ('items' in value && Array.isArray(value.items)) value = { ...value, items: value.items.map(item) }
  }
  return JSON.stringify(value)
}
export function coordinateFixtureGenerator(generate: StructuredGenerator): StructuredGenerator {
  return async (prompt, contract) => {
    const text = await generate(prompt, contract)
    if (!contract?.name.startsWith('script_draft_completeness_coordinates')) return text
    let value: unknown
    try { value = JSON.parse(text) } catch { return text }
    return coordinateFixtureJson(value, prompt)
  }
}
/** This adapter changes MOCK wire serialization only. Every actual production
 * prompt/schema/version/cache/recovery/acceptance path still executes. */
export function reviewCoordinateDraftFixture(draft: WorkflowDraft, generate: StructuredGenerator, options: ScriptDraftReviewOptions = {}) {
  return reviewScriptDraftCompleteness(draft, coordinateFixtureGenerator(generate), options)
}

/** API mocks follow each declared read-only/repair workset contract. This
 * projects a semantic repair fixture to that exact document subset; it does
 * not add omitted decisions or invent successful fault-test evidence. */
export function structuredFixtureJson(value: unknown, prompt?: string): string {
  if (!prompt || !value || typeof value !== 'object') return JSON.stringify(value)
  if ('checked_artifacts' in value) return coordinateFixtureJson(value, prompt)
  const line = prompt.split('\n').find(line => line.startsWith('{') && line.includes('"properties"'))
  if (!line) return JSON.stringify(value)
  let schema: any
  try { schema = JSON.parse(line); schema = schema.properties?.result || schema } catch { return JSON.stringify(value) }
  const properties = schema.properties || {}, original = value as Record<string, unknown>
  if (properties.decisions && !properties.edits && !properties.source_edits) {
    if (!('decisions' in original)) return '{}'
    const items = properties.decisions.items
    if (items?.properties?.issue_id && Array.isArray(original.decisions)) {
      const ids = items.properties.issue_id.enum || [items.properties.issue_id.const]
      return JSON.stringify({ decisions: original.decisions.map((decision, index) => typeof decision === 'string'
        ? { issue_id: ids[index] ?? 'extra-fixture-issue', decision } : decision) })
    }
    return JSON.stringify({ decisions: original.decisions })
  }
  if (properties.summary && (properties.edits || properties.source_edits) && !properties.decisions) {
    const result: Record<string, unknown> = { summary: original.summary }
    if (properties.source_edits) result.source_edits = original.source_edits || []
    if (properties.edits) {
      const branches = properties.edits.items?.anyOf || properties.edits.items?.oneOf || [properties.edits.items]
      const keys = branches.flatMap((branch: any) => {
        const key = branch?.properties?.source_key
        return key?.enum || (key?.const ? [key.const] : [])
      })
      result.edits = Array.isArray(original.edits) ? original.edits.filter((edit: any) => !keys.length || keys.includes(edit.source_key)) : []
    }
    return JSON.stringify(result)
  }
  return JSON.stringify(value)
}
