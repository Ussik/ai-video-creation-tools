import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'

export const sourceFeedbackReviewPolicy = 'source-feedback-review-v2'
export const sourceFeedbackMaxItems = 32
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Feedback = NonNullable<ScriptSourceAnalysis['review_feedback']>
export type SourceFeedbackContext = { request_id: string; policy: string; items_hash: string;
  items: Array<{ id: string; offset: number; length: number; text: string }> }
const quote = z.string().min(1).max(6000)
export const sourceFeedbackCheckSchema = z.object({
  item_id: z.string().min(1).max(100), disposition: z.enum(['issue', 'resolved', 'not_supported', 'unverifiable']),
  reason: z.string().trim().min(1).max(1600), finding_indices: z.array(z.number().int().min(0)).max(32),
  source_refs: z.array(z.object({ unit_id: z.number().int().min(0), quote }).strict()).max(12),
  analysis_refs: z.array(z.object({ path: z.string().min(1).max(200), quote }).strict()).max(8),
}).strict()
export type SourceFeedbackCheck = z.infer<typeof sourceFeedbackCheckSchema>
/** The model selects coordinates only. Proof text is extracted from frozen
 * inputs by the application, never copied, repaired or normalized by a model. */
export const sourceFeedbackWireCheckSchema = sourceFeedbackCheckSchema.extend({
  source_refs: z.array(z.object({ unit_id: z.number().int().min(0) }).strict()).max(12),
  analysis_refs: z.array(z.object({ path: z.string().min(1).max(200) }).strict()).max(8),
}).strict()
export type SourceFeedbackWireCheck = z.infer<typeof sourceFeedbackWireCheckSchema>
type Proof = { policy: string; request_id: string; items_hash: string; input_hash: string; checks_hash: string; checks: SourceFeedbackCheck[] }
type PrivateFeedback = Feedback & { review_proof?: Proof }
type Finding = NonNullable<ScriptSourceAnalysis['quality']>['findings'][number]
type Unit = { id: number; text: string }

/** The private proof never becomes part of its own input identity or prompt. */
export function sourceFeedbackIdentity(state: ScriptSourceAnalysis): Feedback | undefined {
  if (!state.review_feedback) return undefined
  const { review_proof: _proof, ...feedback } = state.review_feedback as PrivateFeedback
  return feedback
}

/** Split only an unambiguous contiguous numbered list. Every original UTF-16
 * code unit belongs to exactly one intact block, including preamble/epilogue. */
export function sourceFeedbackContext(state: ScriptSourceAnalysis): SourceFeedbackContext | undefined {
  const feedback = sourceFeedbackIdentity(state)
  if (!feedback) return undefined
  const text = feedback.text
  const candidates = [...text.matchAll(/^[\t ]*(?:([0-9]+)(?:\.[\t ]+|[、．)）][\t ]*)|[（(]([0-9]+)[）)][\t ]*|[一二三四五六七八九十百]+[、．.)）][\t ]*)/gm)]
  const valid = candidates.length > 1 && candidates.every((match, index) => (match[1] ?? match[2]) === String(index + 1) &&
    !!text.slice(match.index! + match[0].length).split(/\r?\n/, 1)[0]!.trim())
  if (valid && candidates.length > sourceFeedbackMaxItems) throw Object.assign(
    new Error(`单次反馈最多包含${sourceFeedbackMaxItems}个连续阿拉伯编号分项，请拆分为多次提交；未截断、合并或发起模型核查。`),
    { statusCode: 422, code: 'source_feedback_item_limit' })
  const offsets = valid ? [0, ...candidates.slice(1).map(match => match.index!)] : [0]
  const items = offsets.map((offset, index) => {
    const value = text.slice(offset, offsets[index + 1] ?? text.length)
    return { id: `feedback-${index + 1}-${hash([offset, value]).slice(0, 16)}`, offset, length: value.length, text: value }
  })
  if (items.map(item => item.text).join('') !== text) throw new Error('反馈分项必须逐字保留完整原文')
  return { request_id: feedback.id, policy: sourceFeedbackReviewPolicy, items_hash: hash([sourceFeedbackReviewPolicy, feedback.id, text, items]), items }
}

const n = '(?:0|[1-9][0-9]{0,5})'
const storyPath = `story\\.(?:summary|ending\\.summary|characters\\[${n}\\]\\.(?:name|description|aliases\\[${n}\\])|timeline\\[${n}\\]\\.summary|threads\\[${n}\\]\\.(?:setup|payoff)|uncertainties\\[${n}\\]\\.description)`
const sectionPath = `sections\\[${n}\\]\\.(?:title|summary|episode_number|characters\\[${n}\\]\\.(?:name|description)|events\\[${n}\\]\\.summary|open_threads\\[${n}\\])`
const allowedPath = new RegExp(`^(?:${storyPath}|${sectionPath})$`)
function analysisText(state: ScriptSourceAnalysis, path: string): string {
  if (!allowedPath.test(path)) throw new Error('反馈现文引用路径不在允许的分析字段白名单内')
  let value: unknown = state
  for (const key of path.replace(/\[([0-9]+)\]/g, '.$1').split('.')) {
    if (/^[0-9]+$/.test(key) && !Number.isSafeInteger(Number(key))) throw new Error('反馈现文引用索引不安全')
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) throw new Error('反馈现文引用路径不存在，不能猜测条目')
    value = (value as Record<string, unknown>)[key]
  }
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  throw new Error('反馈现文引用必须定位到真实文字或集数字段')
}
function exactUnique(text: string, value: string, label: string) {
  if (!/\S/u.test(value)) throw new Error(`${label}短引必须含非空白原文`)
  const start = text.indexOf(value)
  if (start < 0) throw new Error(`${label}短引必须精确复制，不能修剪、改写或猜测`)
  if (text.indexOf(value, start + 1) >= 0) throw new Error(`${label}短引必须唯一匹配，请复制更完整的精确原文`)
}
/** Diagnostics contain code-owned paths and IDs, never rejected source text.
 * Keep one bounded correction useful when several independent refs are wrong. */
const diagnosticLimit = 32
function boundedDiagnostics(issues: string[]) {
  const unique = [...new Set(issues)]
  return unique.length <= diagnosticLimit ? unique : [...unique.slice(0, diagnosticLimit),
    `$.feedback_checks: 另有${unique.length - diagnosticLimit}项反馈引用问题；请同时按完整契约核对其余引用。`]
}
function checkMetadataDiagnostics(check: SourceFeedbackWireCheck, context: SourceFeedbackContext, path: string): string[] {
  const issues: string[] = [], add = (field: string, message: string) => { issues.push(`${path}.${field}: ${message}`) }
  if (!context.items.some(item => item.id === check.item_id)) add('item_id', '反馈核对不能引用未知的item_id')
  if (new Set(check.finding_indices).size !== check.finding_indices.length) add('finding_indices', '反馈finding_indices不能重复')
  if (check.disposition === 'issue' && !check.finding_indices.length || check.disposition !== 'issue' && check.finding_indices.length) {
    add('finding_indices', '反馈issue必须关联finding_indices，其他处置不得关联finding')
  }
  if (check.disposition !== 'unverifiable' && !check.source_refs.length) add('source_refs', '反馈已核实处置必须提供真实原文证据')
  if ((check.disposition === 'resolved' || check.disposition === 'not_supported') && !check.analysis_refs.length) add('analysis_refs', '反馈已解决或不成立必须提供明确现文位置和证据')
  return issues
}
function checkDiagnostics(check: SourceFeedbackCheck, context: SourceFeedbackContext, state: ScriptSourceAnalysis, units: Unit[], path: string): string[] {
  const issues = checkMetadataDiagnostics(check, context, path), add = (field: string, message: string) => { issues.push(`${path}.${field}: ${message}`) }
  const ids = new Set<string>()
  check.source_refs.forEach((ref, index) => {
    const unit = units.find(unit => unit.id === ref.unit_id), field = `source_refs[${index}]`
    if (!unit?.text.trim()) add(`${field}.unit_id`, `反馈原文引用必须指向真实非空句段（unit_id=${ref.unit_id}）`)
    else {
      try { exactUnique(unit.text, ref.quote, '反馈原文') }
      catch (issue) { add(`${field}.quote`, `${issue instanceof Error ? issue.message : '反馈原文引用无效'}（unit_id=${ref.unit_id}）`) }
    }
    const id = JSON.stringify(ref)
    if (ids.has(id)) add(field, '反馈原文引用不能重复')
    ids.add(id)
  })
  const refs = new Set<string>()
  check.analysis_refs.forEach((ref, index) => {
    const field = `analysis_refs[${index}]`, target = allowedPath.test(ref.path) ? `（path=${ref.path}）` : ''
    let text: string | undefined
    try { text = analysisText(state, ref.path) }
    catch (issue) { add(`${field}.path`, `${issue instanceof Error ? issue.message : '反馈现文引用路径无效'}${target}`) }
    if (text !== undefined) {
      try { exactUnique(text, ref.quote, '反馈现文') }
      catch (issue) { add(`${field}.quote`, `${issue instanceof Error ? issue.message : '反馈现文引用无效'}${target}`) }
    }
    const id = JSON.stringify(ref)
    if (refs.has(id)) add(field, '反馈现文引用不能重复')
    refs.add(id)
  })
  return issues
}
function collectionDiagnostics(checks: SourceFeedbackWireCheck[], context: SourceFeedbackContext, findings: Finding[] | undefined, complete: boolean): string[] {
  const issues: string[] = [], ids = new Set<string>()
  checks.forEach((check, index) => {
    const path = `$.feedback_checks[${index}]`
    if (ids.has(check.item_id)) issues.push(`${path}.item_id: 每项反馈只能有一个核对处置，不能重复或互相冲突`)
    ids.add(check.item_id)
    if (!complete || !findings || check.disposition !== 'issue') return
    check.finding_indices.forEach((findingIndex, at) => {
      const finding = findings[findingIndex]
      if (!finding || !check.source_refs.some(ref => finding.unit_ids.includes(ref.unit_id))) issues.push(
        `${path}.finding_indices[${at}]: 反馈finding_indices必须关联真实问题并有相交的原文证据`)
    })
  })
  if (complete && (ids.size !== context.items.length || context.items.some(item => !ids.has(item.id)))) issues.push(
    '$.feedback_checks: 反馈核对必须逐项完整覆盖全部item_id，不能遗漏')
  return issues
}
function checksDiagnostics(checks: SourceFeedbackCheck[], context: SourceFeedbackContext, state: ScriptSourceAnalysis,
  units: Unit[], findings: Finding[] | undefined, complete: boolean): string[] {
  return [...checks.flatMap((check, index) => checkDiagnostics(check, context, state, units, `$.feedback_checks[${index}]`)),
    ...collectionDiagnostics(checks, context, findings, complete)]
}
function materializedCheck(check: SourceFeedbackWireCheck, context: SourceFeedbackContext, state: ScriptSourceAnalysis, units: Unit[], path: string) {
  const issues = checkMetadataDiagnostics(check, context, path), add = (field: string, message: string) => { issues.push(`${path}.${field}: ${message}`) }
  const ids = new Set<number>(), paths = new Set<string>()
  const fullQuote = (text: string, field: string, label: string) => {
    if (!/\S/u.test(text)) { add(field, `${label}必须指向非空白的完整证据`); return false }
    if (!quote.safeParse(text).success) { add(field, `${label}完整证据超过6000个Unicode字符；请另选真实且更小的允许字段或句段，不能截断、改写或猜测范围`); return false }
    return true
  }
  const source_refs = check.source_refs.flatMap((ref, index) => {
    const field = `source_refs[${index}].unit_id`, label = `反馈原文（unit_id=${ref.unit_id}）`
    if (ids.has(ref.unit_id)) add(field, '反馈原文引用不能重复')
    ids.add(ref.unit_id)
    const unit = units.find(unit => unit.id === ref.unit_id)
    if (!unit) { add(field, `${label}必须指向真实原文句段，不能猜测ID`); return [] }
    return fullQuote(unit.text, field, label) ? [{ unit_id: ref.unit_id, quote: unit.text }] : []
  })
  const analysis_refs = check.analysis_refs.flatMap((ref, index) => {
    const field = `analysis_refs[${index}].path`, target = allowedPath.test(ref.path) ? `（path=${ref.path}）` : ''
    if (paths.has(ref.path)) add(field, '反馈现文引用不能重复')
    paths.add(ref.path)
    let text: string
    try { text = analysisText(state, ref.path) }
    catch (issue) { add(field, `${issue instanceof Error ? issue.message : '反馈现文引用路径无效'}${target}`); return [] }
    return fullQuote(text, field, `反馈现文${target}`) ? [{ path: ref.path, quote: text }] : []
  })
  return { value: { ...check, source_refs, analysis_refs }, issues }
}
export function materializeSourceFeedbackCheck(check: SourceFeedbackWireCheck, context: SourceFeedbackContext, state: ScriptSourceAnalysis, units: Unit[]): SourceFeedbackCheck {
  const result = materializedCheck(sourceFeedbackWireCheckSchema.parse(check), context, state, units, '$.feedback_checks[]')
  if (result.issues.length) throw new Error(boundedDiagnostics(result.issues).join('\n'))
  validateSourceFeedbackCheck(result.value, context, state, units)
  return result.value
}
export function materializeSourceFeedbackChecks(checks: SourceFeedbackWireCheck[], context: SourceFeedbackContext, state: ScriptSourceAnalysis,
  units: Unit[], findings: Finding[], complete: boolean): SourceFeedbackCheck[] {
  const parsed = checks.map(check => sourceFeedbackWireCheckSchema.parse(check))
  const results = parsed.map((check, index) => materializedCheck(check, context, state, units, `$.feedback_checks[${index}]`))
  const issues = [...results.flatMap(result => result.issues), ...collectionDiagnostics(parsed, context, findings, complete)]
  if (issues.length) throw new Error(boundedDiagnostics(issues).join('\n'))
  const values = results.map(result => result.value)
  validateSourceFeedbackChecks(values, context, state, units, findings, complete)
  return values
}
/** Advisory diagnostics inspect only independently valid wire shapes. They
 * cannot accept legacy quote fields, infer findings or save partial proof. */
export function diagnoseSourceFeedbackWireChecks(value: unknown, context: SourceFeedbackContext, state: ScriptSourceAnalysis, units: Unit[]): string[] {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'feedback_checks')) return []
  const checks = (value as { feedback_checks?: unknown }).feedback_checks
  if (!Array.isArray(checks)) return []
  const parsed: SourceFeedbackWireCheck[] = [], issues: string[] = []
  checks.slice(0, sourceFeedbackMaxItems).forEach((check, index) => {
    const result = sourceFeedbackWireCheckSchema.safeParse(check)
    if (!result.success) return
    parsed.push(result.data)
    issues.push(...materializedCheck(result.data, context, state, units, `$.feedback_checks[${index}]`).issues)
  })
  if (parsed.length === checks.length) issues.push(...collectionDiagnostics(parsed, context, undefined, true))
  return boundedDiagnostics(issues)
}
export function validateSourceFeedbackCheck(check: SourceFeedbackCheck, context: SourceFeedbackContext, state: ScriptSourceAnalysis, units: Unit[]) {
  sourceFeedbackCheckSchema.parse(check)
  const issues = checkDiagnostics(check, context, state, units, '$.feedback_checks[]')
  if (issues.length) throw new Error(boundedDiagnostics(issues).join('\n'))
}
export function validateSourceFeedbackChecks(checks: SourceFeedbackCheck[], context: SourceFeedbackContext, state: ScriptSourceAnalysis,
  units: Unit[], findings: Finding[], complete: boolean) {
  checks.forEach(check => sourceFeedbackCheckSchema.parse(check))
  const issues = checksDiagnostics(checks, context, state, units, findings, complete)
  if (issues.length) throw new Error(boundedDiagnostics(issues).join('\n'))
}

/** A failed outer schema can still have independently valid feedback checks.
 * Diagnose those refs only; this never validates findings, saves a proof or
 * repairs input. Invalid subshapes remain the outer schema's responsibility. */
export function diagnoseSourceFeedbackChecks(value: unknown, context: SourceFeedbackContext, state: ScriptSourceAnalysis, units: Unit[]): string[] {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'feedback_checks')) return []
  const checks = (value as { feedback_checks?: unknown }).feedback_checks
  if (!Array.isArray(checks)) return []
  const parsed: SourceFeedbackCheck[] = [], positions: number[] = []
  checks.slice(0, sourceFeedbackMaxItems).forEach((check, index) => {
    const result = sourceFeedbackCheckSchema.safeParse(check)
    if (!result.success) return
    parsed.push(result.data); positions.push(index)
  })
  // Only a complete collection of valid check shapes may diagnose cross-item
  // coverage. Finding links wait until the entire findings schema is valid.
  if (parsed.length === checks.length) return boundedDiagnostics(checksDiagnostics(parsed, context, state, units, undefined, true))
  return boundedDiagnostics(parsed.flatMap((check, index) => checkDiagnostics(check, context, state, units, `$.feedback_checks[${positions[index]}]`)))
}
export function saveSourceFeedbackReviewProof(state: ScriptSourceAnalysis, context: SourceFeedbackContext, inputHash: string, checks: SourceFeedbackCheck[]) {
  const current = sourceFeedbackContext(state)
  if (!current || current.request_id !== context.request_id || current.items_hash !== context.items_hash) throw new Error('反馈身份在审核期间发生变化，本次核对未保存')
  ;(state.review_feedback as PrivateFeedback).review_proof = { policy: sourceFeedbackReviewPolicy, request_id: context.request_id,
    items_hash: context.items_hash, input_hash: inputHash, checks_hash: hash(checks), checks: structuredClone(checks) }
}

/** Repair guidance is read from the bound review, never inferred from prose.
 * Earlier repairs may shift arrays: retain only the same coordinate's exact
 * full text, with no searching/remapping or claim of historical item identity. */
export function sourceFeedbackRepairContext(state: ScriptSourceAnalysis, findingIndex: number, units: Unit[]) {
  try {
    const context = sourceFeedbackContext(state), proof = (state.review_feedback as PrivateFeedback | undefined)?.review_proof
    const review = state.quality
    if (!context || !proof || review?.status !== 'issues' || !Number.isSafeInteger(findingIndex) || findingIndex < 0 || !review.findings[findingIndex] ||
      proof.policy !== sourceFeedbackReviewPolicy || proof.request_id !== context.request_id || proof.items_hash !== context.items_hash ||
      proof.input_hash !== review.input_hash || proof.checks_hash !== hash(proof.checks) || proof.checks.length !== context.items.length) return
    const checks = proof.checks.map(check => sourceFeedbackCheckSchema.parse(check))
    if (checks.some((check, index) => checkMetadataDiagnostics(check, context, `$.feedback_checks[${index}]`).length) ||
      collectionDiagnostics(checks, context, review.findings, true).length) return
    const linked = checks.filter(check => check.disposition === 'issue' && check.finding_indices.includes(findingIndex))
    if (!linked.length) return
    const current = new Map<string, { path: string; current_value: string }>()
    const items = linked.map(check => {
      // Only program-materialized complete source units can support this link.
      if (new Set(check.source_refs.map(ref => ref.unit_id)).size !== check.source_refs.length ||
        check.source_refs.some(ref => units.find(unit => unit.id === ref.unit_id)?.text !== ref.quote)) throw new Error('反馈原文绑定已变化')
      const paths: string[] = []
      for (const ref of check.analysis_refs) {
        try {
          const value = analysisText(state, ref.path)
          if (value !== ref.quote || !/\S/u.test(value) || !quote.safeParse(value).success) continue
          if (!paths.includes(ref.path)) paths.push(ref.path)
          current.set(ref.path, { path: ref.path, current_value: value })
        } catch { /* An old index/path must not be guessed or remapped. */ }
      }
      return { item_id: check.item_id, text: context.items.find(item => item.id === check.item_id)!.text,
        source_unit_ids: check.source_refs.map(ref => ref.unit_id), analysis_ref_paths: paths,
        unbound_analysis_ref_count: check.analysis_refs.length - paths.length }
    })
    return { request_id: context.request_id, finding_index: findingIndex,
      binding: 'same_path_exact_full_value' as const, items, current_analysis_refs: [...current.values()] }
  } catch { /* Invalid/stale private proof supplies no repair evidence. */ }
}

export function hasSourceFeedbackReviewProof(state: ScriptSourceAnalysis, inputHash: string): boolean {
  if (!state.review_feedback) return true
  try {
    const context = sourceFeedbackContext(state)!, proof = (state.review_feedback as PrivateFeedback).review_proof
    if (!proof || proof.policy !== sourceFeedbackReviewPolicy || proof.request_id !== context.request_id || proof.items_hash !== context.items_hash ||
      proof.input_hash !== inputHash || proof.checks_hash !== hash(proof.checks) || proof.checks.length !== context.items.length) return false
    const ids = new Set<string>()
    for (const value of proof.checks) {
      const check = sourceFeedbackCheckSchema.parse(value)
      if (ids.has(check.item_id) || !context.items.some(item => item.id === check.item_id) ||
        check.disposition === 'issue' || check.disposition === 'unverifiable' || check.finding_indices.length || !check.source_refs.length || !check.analysis_refs.length) return false
      ids.add(check.item_id)
      for (const ref of check.analysis_refs) exactUnique(analysisText(state, ref.path), ref.quote, '反馈现文')
    }
    return ids.size === context.items.length
  } catch { return false }
}
