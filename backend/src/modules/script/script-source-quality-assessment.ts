import { createHash } from 'node:crypto'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'

type Finding = NonNullable<ScriptSourceAnalysis['quality']>['findings'][number]
type Review = NonNullable<ScriptSourceAnalysis['quality']>
type Repair = NonNullable<ScriptSourceAnalysis['quality_repair']>
type SourceUnit = { id: number; text: string }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const factualTypes = new Set(['fact_error', 'event_order', 'unsupported_fact', 'material_omission'])
const issueTypes = new Set([...factualTypes, 'open_question', 'optional_detail'])
const index = '(?:0|[1-9][0-9]{0,5})'
const story = `story\\.(?:summary|ending(?:\\.summary)?|characters|timeline|threads|uncertainties|characters\\[${index}\\](?:\\.(?:name|description|aliases\\[${index}\\]))?|timeline\\[${index}\\](?:\\.summary)?|threads\\[${index}\\](?:\\.(?:setup|payoff))?|uncertainties\\[${index}\\](?:\\.description)?)`
const section = `sections\\[${index}\\]\\.(?:title|summary|episode_number|characters|events|open_threads|characters\\[${index}\\](?:\\.(?:name|description))?|events\\[${index}\\](?:\\.summary)?|open_threads\\[${index}\\])`
const allowedPath = new RegExp(`^(?:${story}|${section})$`)

/** Read only explicit, bounded analysis coordinates. A valid path proves
 * location, never that a model's semantic judgment is correct. */
export function sourceQualityAnalysisValue(state: ScriptSourceAnalysis, path: string): unknown {
  if (!allowedPath.test(path)) throw new Error('质量问题位置不在允许的分析字段内')
  let value: unknown = state
  for (const key of path.replace(/\[([0-9]+)\]/g, '.$1').split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error('质量问题位置不存在，不能猜测或自动重映射')
    value = (value as Record<string, unknown>)[key]
  }
  if (value === undefined || (typeof value === 'string' && !value.trim())) throw new Error('质量问题位置必须指向已保存的非空分析')
  return value
}

function pathSectionIds(state: ScriptSourceAnalysis, path: string): number[] {
  const direct = /^sections\[([0-9]+)\]/.exec(path)
  if (direct) return [Number(direct[1])]
  const item = /^(story\.(?:characters|timeline|threads|uncertainties)\[[0-9]+\]|story\.ending)/.exec(path)?.[1]
  if (!item) return []
  const value = sourceQualityAnalysisValue(state, item) as { section_ids?: unknown }
  return Array.isArray(value?.section_ids) ? value.section_ids.filter((id): id is number => Number.isSafeInteger(id)) : []
}

/** Enforce only mechanically checkable type, position and scope invariants.
 * Whether a proposition is true still requires the independent content review. */
export function validateSourceQualityAssessment(finding: Finding, state: ScriptSourceAnalysis, units: SourceUnit[]) {
  const value = finding.assessment
  if (!value) return // Legacy findings remain conservative blockers.
  if (!value.analysis_paths.length || new Set(value.analysis_paths).size !== value.analysis_paths.length) throw new Error('质量问题必须提供不重复的当前分析位置')
  value.analysis_paths.forEach(path => sourceQualityAnalysisValue(state, path))
  const ids = value.impact.section_ids
  if (new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id) || id < 0 || id >= state.sections.length)) throw new Error('质量影响范围必须使用真实且不重复的目录ID')
  if (factualTypes.has(value.issue_type) && value.impact.level !== 'blocking') throw new Error('人物事实、事件错置、无依据事实或实质遗漏不能降级为普通提示或待定信息')
  if (value.impact.level === 'scoped') {
    if (!ids.length || !['open_question', 'optional_detail'].includes(value.issue_type)) throw new Error('局部待定影响必须明确相关章节，不能弱化实质错误')
    const located = [...new Set(value.analysis_paths.flatMap(path => pathSectionIds(state, path)))]
    if (!located.length || located.some(id => !ids.includes(id))) throw new Error('局部待定影响必须覆盖所指分析条目的全部章节，不能漏报或猜测范围')
    // Evidence outside a local section can carry a global rule. Do not infer
    // irrelevance from its coordinate; require all identified evidence chapters.
    const cited = units.filter(unit => finding.unit_ids.includes(unit.id))
    const evidenceSections = state.sections.flatMap((part, id) => {
      const end = part.offset + part.length
      return cited.some(unit => 'offset' in unit && typeof unit.offset === 'number' && unit.offset >= part.offset && unit.offset < end) ? [id] : []
    })
    if (evidenceSections.some(id => !ids.includes(id))) throw new Error('局部待定影响范围遗漏了引用原文所在章节')
  }
}

/** Stable actual content identity, separate from review/run identifiers. */
export const sourceQualityContentHash = (state: ScriptSourceAnalysis) => hash([state.source_version, state.sections, state.story,
  state.review_feedback?.text || null])

type Access = { access: 'blocked' | 'scoped' | 'usable'; blocking: number; advisory: number; section_ids: number[] }
export function assessSourceQualityAccess(state: ScriptSourceAnalysis, sectionIds?: number[]): Access {
  const review = state.quality
  if (!review) return { access: 'blocked', blocking: 0, advisory: 0, section_ids: [] }
  if (review.status === 'passed' && !review.findings.length) return { access: 'usable', blocking: 0, advisory: 0, section_ids: [] }
  let blocking = 0, advisory = 0
  const scoped = new Set<number>()
  for (const finding of review.findings) {
    const assessment = finding.assessment
    let valid = !!assessment && issueTypes.has(assessment.issue_type) && !!assessment.proposition?.trim() &&
      Array.isArray(assessment.analysis_paths) && !!assessment.analysis_paths.length && !!assessment.impact &&
      ['blocking', 'scoped', 'advisory'].includes(assessment.impact.level) && !!assessment.impact.reason?.trim() &&
      Array.isArray(assessment.impact.section_ids) && assessment.impact.section_ids.every(id => Number.isSafeInteger(id) && id >= 0 && id < state.sections.length)
    if (valid) {
      try { assessment!.analysis_paths.forEach(path => sourceQualityAnalysisValue(state, path)) }
      catch { valid = false }
    }
    if (!valid || !assessment || factualTypes.has(assessment.issue_type) || assessment.impact.level === 'blocking') blocking++
    else if (assessment.impact.level === 'advisory') advisory++
    else {
      for (const id of assessment.impact.section_ids) scoped.add(id)
      if (!assessment.impact.section_ids.length) blocking++
    }
  }
  // An issues review with no findings can represent unresolved creator feedback.
  if (!review.findings.length) blocking++
  if (blocking) return { access: 'blocked', blocking, advisory, section_ids: [...scoped].sort((a, b) => a - b) }
  const section_ids = [...scoped].sort((a, b) => a - b)
  if (section_ids.length && (!sectionIds || sectionIds.some(id => section_ids.includes(id)))) return { access: 'scoped', blocking: 0, advisory, section_ids }
  return { access: 'usable', blocking: 0, advisory, section_ids }
}

function reviewEvidence(review: Review, state: ScriptSourceAnalysis, units: SourceUnit[]) {
  return review.findings.map(finding => ({ kind: finding.kind,
    ...(finding.assessment ? { assessment: structuredClone(finding.assessment) } : {}),
    targets: [...(finding.assessment?.analysis_paths || [])].sort().map(path => ({ path, value_hash: hash(sourceQualityAnalysisValue(state, path)) })),
    evidence_hashes: [...new Set(finding.unit_ids.map(id => units.find(unit => unit.id === id)).filter((unit): unit is SourceUnit => !!unit).map(unit => hash(unit.text)))].sort(),
  }))
}

function completedRepair(review: Review | undefined, repair: Repair | undefined, inputHash: string): boolean {
  return !!review?.findings.length && !!repair && repair.review_hash === review.input_hash && repair.findings_hash === hash(review.findings) &&
    repair.current_hash === inputHash && repair.completed_findings === review.findings.length
}

/** Preserve private history before replacing a review. It is never prompt data.
 * Stopping for unchanged targets/evidence is a guard against paid repetition,
 * not an assertion that arbitrary free-text propositions are semantically equal. */
export function recordSourceQualityReview(state: ScriptSourceAnalysis, previous: Review | undefined, repair: Repair | undefined,
  inputHash: string, units: SourceUnit[]) {
  const review = state.quality!
  const analysisHash = sourceQualityContentHash(state)
  const evidence = reviewEvidence(review, state, units)
  const history = state.quality_review_audit ||= []
  const prior = previous && [...history].reverse().find(entry => entry.review_hash === previous.input_hash)
  const handled = completedRepair(previous, repair, inputHash)
  const previousEvidence = prior?.findings || (previous?.input_hash === inputHash ? reviewEvidence(previous, state, units) : [])
  const knownEvidence = new Set([
    ...previousEvidence.flatMap(finding => finding.evidence_hashes),
    ...(repair?.decisions || []).flatMap(decision => decision.source_refs.map(ref => ref.text_hash)),
    ...(repair?.withdrawals || []).flatMap(note => note.unit_ids.flatMap(id => {
      const unit = units.find(item => item.id === id)
      return unit ? [hash(unit.text)] : []
    })),
  ])
  const hasNewEvidence = evidence.some(finding => finding.evidence_hashes.some(value => !knownEvidence.has(value)))
  // Do not infer content edits from a count of handled findings. Exact accepted
  // before/after content, including a legitimate retain decision, is authoritative.
  const noContentChange = handled && previous?.input_hash === inputHash && !hasNewEvidence
  let repeated: number[] = []
  if (handled && prior && !noContentChange) {
    repeated = evidence.flatMap((finding, at) => {
      if (!finding.assessment || !finding.targets.length) return []
      const match = prior.findings.some(old => old.assessment && old.kind === finding.kind &&
        old.assessment.issue_type === finding.assessment!.issue_type &&
        hash(old.targets) === hash(finding.targets) && finding.evidence_hashes.every(value => old.evidence_hashes.includes(value)))
      return match ? [at] : []
    })
  }
  if (review.findings.length && assessSourceQualityAccess(state).access === 'blocked' && (noContentChange || repeated.length)) state.quality_loop_guard = {
    analysis_hash: analysisHash, source_version: state.source_version,
    reason: noContentChange ? 'unchanged_analysis' : 'unchanged_target',
    finding_indices: noContentChange ? review.findings.map((_, at) => at) : repeated,
    message: noContentChange ? '本轮意见已处理，但分析内容未变化，独立复核仍有未决问题。已停止原样重复生成；请补充直接依据、调整对应分析或明确相关待定事项后再核对。'
      : '同一未变分析条目再次被报告，未出现新的原文依据；本地无法确认前次处置是否有效，也不判定两段理由语义相同。已停止重复生成，请补充新依据或核对该条目后继续。',
  }
  const last = history.at(-1)
  if (!last || last.review_hash !== review.input_hash || hash(last.findings) !== hash(evidence) || hash(last.decisions || []) !== hash(repair?.decisions || [])) history.push({
    review_hash: review.input_hash, analysis_hash: analysisHash, source_version: state.source_version, findings: evidence,
    ...decisionCounts(repair?.decisions || []), ...(repair?.decisions?.length ? { decisions: structuredClone(repair.decisions) } : {}),
  })
}

export function activeSourceQualityLoopGuard(state: ScriptSourceAnalysis) {
  const guard = state.quality_loop_guard
  return state.quality?.status === 'issues' && state.quality.findings.length && guard?.source_version === state.source_version &&
    guard.analysis_hash === sourceQualityContentHash(state) ? guard : undefined
}

export function assertSourceQualityProgress(state: ScriptSourceAnalysis) {
  const guard = activeSourceQualityLoopGuard(state)
  if (guard) throw Object.assign(new Error(guard.message), { statusCode: 409, code: 'source_quality_no_progress',
    sourceOutputRecoveryBlocked: true, retryable: false, delivery: 'not_sent', failure_stage: 'content' })
}

export function sourceQualitySummary(state: ScriptSourceAnalysis): NonNullable<ScriptSourceAnalysis['quality_summary']> {
  const access = assessSourceQualityAccess(state)
  const repair = state.quality_repair
  const audit = state.quality_review_audit?.at(-1)
  const decisions = repair?.decisions || audit?.decisions || []
  const counts = decisionCounts(decisions)
  const guard = activeSourceQualityLoopGuard(state)
  const total = repair ? state.quality?.findings.length || 0 : Math.max(state.quality?.findings.length || 0, ...decisions.map(decision => decision.finding_index + 1))
  return { ...access, ...counts, total,
    review: !state.quality || repair ? 'pending' : state.quality.status === 'passed' ? 'passed' : 'issues',
    ...(guard ? { stop_reason: 'no_progress' as const, message: guard.message }
      : repair?.stop_reason ? { stop_reason: repair.stop_reason, message: repair.stop_message } : {}) }
}

function decisionCounts(decisions: NonNullable<ScriptSourceAnalysis['quality_repair']>['decisions']) {
  return { handled: decisions?.filter(decision => decision.decision !== 'requires_full_rebuild').length || 0,
    modified: decisions?.filter(decision => decision.decision === 'modify_analysis' && decision.before_hash !== decision.after_hash).length || 0,
    retained: decisions?.filter(decision => decision.decision === 'retain_analysis').length || 0,
    uncertain: decisions?.filter(decision => decision.decision === 'uncertain').length || 0 }
}
