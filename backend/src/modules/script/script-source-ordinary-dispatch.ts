import { createHash } from 'node:crypto'
import { canonicalAiValue } from '@video-studio/shared/api/ai-operations'
import type { ScriptSourceAnalysis, ScriptSourceDocument, ScriptSourcePartOutputCheckpoint, ScriptSourceQualityRoundConfirmation } from '@video-studio/shared/script/script-source-document'
import type { DerivedSourceCorrectionRequest, InitialSourceStoryRequest, InitialSourceQualityRequest } from './source-story-dispatch-identity.js'
import { sourceQualityInputHash } from './script-source-quality.js'
import { sourceQualityRepairProgress } from './script-source-quality-progress.js'
import { sourceRepairRequestCheckpoint, sourceRepairBatchBinding, type SourceRepairBatchBinding, type InitialSourceRepairRequest, type DerivedSourceRepairCorrectionRequest, type SourceRepairUpgradeBinding } from './source-repair-request-identity.js'
import { sourceFeedbackIdentity } from './script-source-feedback-review.js'

type Context = { document: Omit<ScriptSourceDocument, 'analysis'>; state: ScriptSourceAnalysis;
  configuration_hash: string; local_active: boolean; current_run_unknown?: boolean }
type Task = NonNullable<ScriptSourceAnalysis['story_work']>['tasks'][number]
const digest = (value: unknown) => createHash('sha256').update(canonicalAiValue(value)).digest('hex')
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const responseHash = (value: string) => createHash('sha256').update(value).digest('hex')
const binding = ({ document, state, configuration_hash }: Context) => digest({ source_version: state.source_version,
  source_updated_at: document.updated_at, source_digest: digest(document.content), filename: document.filename,
  model_id: state.model_id, configuration_hash, feedback: sourceFeedbackIdentity(state) ?? null })
type Workflow = NonNullable<NonNullable<ScriptSourceAnalysis['ordinary_story_dispatch']>['quality_workflow']>
const checkpointEmpty = (cp: ScriptSourcePartOutputCheckpoint | undefined) =>
  !cp || cp.raw === undefined && cp.original_raw === undefined && !cp.initial_started && !cp.correction_started && !cp.correction && !cp.correction_request && !cp.local_repair
function workflowFor(document: Pick<ScriptSourceDocument, 'filename' | 'content'>, state: ScriptSourceAnalysis): Workflow | undefined {
  if (!state.story || state.quality?.status !== 'issues' || !state.quality.findings.length || state.quality_rebuild_for === state.quality.input_hash) return
  let progress = sourceQualityRepairProgress(state), candidate = state
  if (progress === null) {
    if (state.quality_repair || state.quality.input_hash !== sourceQualityInputHash(state)) return
    candidate = structuredClone(state)
    candidate.quality_repair = { review_hash: state.quality.input_hash, findings_hash: responseHash(JSON.stringify(state.quality.findings)),
      current_hash: sourceQualityInputHash(state), completed_findings: 0 }
    progress = 0
  }
  return { phase: progress < state.quality.findings.length ? 'repair' : 'review', review_hash: state.quality.input_hash,
    findings_hash: responseHash(JSON.stringify(state.quality.findings)), finding_index: progress, current_hash: sourceQualityInputHash(state),
    checkpoint_hash: progress < state.quality.findings.length ? sourceRepairRequestCheckpoint(document, candidate, progress).checkpoint_hash : '', protected_repair_bindings: [] }
}
function repairCheckpointFor(document: Pick<ScriptSourceDocument, 'filename' | 'content'>, state: ScriptSourceAnalysis, index: number) {
  if (state.quality_repair) return sourceRepairRequestCheckpoint(document, state, index)
  const candidate = structuredClone(state)
  candidate.quality_repair = { review_hash: state.quality!.input_hash, findings_hash: responseHash(JSON.stringify(state.quality!.findings)),
    current_hash: sourceQualityInputHash(state), completed_findings: 0 }
  return sourceRepairRequestCheckpoint(document, candidate, index)
}
const workflowMatches = (workflow: Workflow, state: ScriptSourceAnalysis) => state.quality?.status === 'issues' &&
  workflow.review_hash === state.quality.input_hash && workflow.findings_hash === responseHash(JSON.stringify(state.quality.findings)) &&
  workflow.current_hash === sourceQualityInputHash(state) && workflow.finding_index === sourceQualityRepairProgress(state)

/** A finished independent recheck cannot spend its old repair allowance on
 * the newly produced findings. Legacy snapshots derive the same boundary from
 * the old review workflow and the exact current result, without mutating it. */
export function sourceQualityRoundConfirmation(state: ScriptSourceAnalysis): ScriptSourceQualityRoundConfirmation | undefined {
  const review = state.quality, currentHash = sourceQualityInputHash(state)
  if (!review || review.status !== 'issues' || !review.findings.length || review.input_hash !== currentHash) return
  const findingsHash = responseHash(JSON.stringify(review.findings)), saved = state.quality_round_confirmation
  if (saved?.source_version === state.source_version && saved.review_hash === review.input_hash &&
    saved.findings_hash === findingsHash && saved.current_hash === currentHash) return saved
  const grant = state.ordinary_story_dispatch, workflow = grant?.quality_workflow
  if (!grant || workflow?.phase !== 'review' || workflow.current_hash !== currentHash ||
    workflow.review_hash === review.input_hash && workflow.findings_hash === findingsHash) return
  return { source_version: state.source_version, review_hash: review.input_hash, findings_hash: findingsHash,
    current_hash: currentHash, completed_run_id: grant.run_id, previous_review_hash: workflow.review_hash,
    previous_findings_hash: workflow.findings_hash, created_at: grant.closed_at || state.updated_at }
}

/** Preserve the completed round before a new explicit paid scope can replace
 * its grant. Saved answers and unrelated request-recovery permits are untouched. */
export function closeSourceQualityDispatchRound(state: ScriptSourceAnalysis,
  previous: ScriptSourceAnalysis['quality'], completed: boolean): void {
  if (!completed || !previous || !state.quality) return
  const grant = state.ordinary_story_dispatch, currentHash = sourceQualityInputHash(state)
  const nextFindings = responseHash(JSON.stringify(state.quality.findings)), closedAt = new Date().toISOString()
  if (grant?.quality_workflow?.phase === 'review' && grant.quality_workflow.review_hash === previous.input_hash &&
    grant.quality_workflow.findings_hash === responseHash(JSON.stringify(previous.findings)) &&
    grant.quality_workflow.current_hash === currentHash) {
    const roundKey = digest([grant.run_id, grant.quality_workflow.review_hash, grant.quality_workflow.findings_hash,
      state.quality.input_hash, nextFindings])
    const history = state.quality_dispatch_history ||= []
    if (!history.some(entry => entry.round_key === roundKey)) history.push({ round_key: roundKey, closed_at: closedAt,
      result: state.quality.findings.length ? 'new_findings' : 'passed', next_review_hash: state.quality.input_hash,
      next_findings_hash: nextFindings, grant: structuredClone(grant) })
    grant.closed_at ||= closedAt
    grant.closed_reason = 'independent_recheck_complete'
  }
  if (state.quality.status === 'issues' && state.quality.findings.length) state.quality_round_confirmation = {
    source_version: state.source_version, review_hash: state.quality.input_hash, findings_hash: nextFindings,
    current_hash: currentHash, completed_run_id: grant?.run_id || state.id, previous_review_hash: previous.input_hash,
    previous_findings_hash: responseHash(JSON.stringify(previous.findings)), created_at: closedAt,
  }
  else delete state.quality_round_confirmation
}

/** Local reconciliation may close an obsolete round but cannot turn an
 * unresolved attempt into not_sent. In particular, all output markers stay. */
export function prepareSourceQualityNextRound(state: ScriptSourceAnalysis): boolean {
  const pending = sourceQualityRoundConfirmation(state)
  if (!pending) return false
  const grant = state.ordinary_story_dispatch
  state.quality_round_confirmation = structuredClone(pending)
  if (!grant) return true
  const history = state.quality_dispatch_history ||= []
  const roundKey = digest([grant.run_id, pending.previous_review_hash, pending.previous_findings_hash, pending.review_hash, pending.findings_hash])
  if (!history.some(entry => entry.round_key === roundKey)) history.push({ round_key: roundKey,
    closed_at: grant.closed_at || pending.created_at, result: 'new_findings', next_review_hash: pending.review_hash,
    next_findings_hash: pending.findings_hash, grant: structuredClone(grant) })
  grant.closed_at ||= pending.created_at
  grant.closed_reason = 'independent_recheck_complete'
  return true
}

/** Called only after start has verified the exact explicit new-round scope. */
export function confirmSourceQualityRound(state: ScriptSourceAnalysis, expected: ScriptSourceQualityRoundConfirmation): void {
  const pending = sourceQualityRoundConfirmation(state)
  if (!pending || canonicalAiValue(pending) !== canonicalAiValue(expected)) throw Object.assign(
    new Error('待确认质量轮次已变化，请刷新后重新核对。'), { statusCode: 409, code: 'source_quality_round_confirmation_required' })
  const grant = state.ordinary_story_dispatch
  if (grant && !state.quality_dispatch_history?.some(entry => entry.grant.run_id === grant.run_id &&
    entry.next_review_hash === pending.review_hash && entry.next_findings_hash === pending.findings_hash)) {
    (state.quality_dispatch_history ||= []).push({
      round_key: digest([grant.run_id, pending.previous_review_hash, pending.previous_findings_hash, pending.review_hash, pending.findings_hash]),
      closed_at: grant.closed_at || pending.created_at, result: 'new_findings', next_review_hash: pending.review_hash,
      next_findings_hash: pending.findings_hash, grant: structuredClone(grant),
    })
  }
  const previous = state.quality_dispatch_history && [...state.quality_dispatch_history].reverse().find(entry => entry.next_review_hash === pending.review_hash && entry.next_findings_hash === pending.findings_hash)
  if (previous) previous.confirmation = { authorized_at: new Date().toISOString(), authorized_run_id: state.id }
  delete state.quality_round_confirmation
  // Removing the completed grant also makes the legacy derived boundary
  // disappear; its immutable copy remains in the private history above.
  delete state.ordinary_story_dispatch
}

/** Only genuinely unstarted logical tasks are candidates for an independent
 * ordinary grant. Complete bytes and unknown initial/correction attempts retain
 * their original recovery path even when a diagnostic changes their prompt. */
export function isUnstartedSourceStoryTask(task: Task): boolean {
  const cp = task.output_candidate?.checkpoint
  return task.result === undefined && (!task.failure || ['source_request_sibling_pending', 'source_local_model_required'].includes(task.failure.code || '')) &&
    !task.output_checkpoint && !task.recovery && cp?.raw === undefined && cp?.original_raw === undefined &&
    !cp?.correction && !cp?.correction_request && !cp?.initial_started && !cp?.correction_started
}

/** A retained answer whose one frozen correction has not reached dispatch.
 * A started or completed correction never regains an ordinary allowance. */
export function isUnsentSourceStoryCorrection(task: Task): boolean {
  const cp = task.output_candidate?.checkpoint, frozen = cp?.correction_request
  return task.result === undefined && !task.output_checkpoint && !task.recovery && !!cp && !!frozen &&
    typeof cp.raw === 'string' && typeof cp.original_raw === 'string' && cp.raw === cp.original_raw &&
    !!cp.input_hash && frozen.base_input_hash === cp.input_hash &&
    frozen.input_hash === fingerprint([frozen.prompt, frozen.contract]) &&
    !cp.initial_started && !cp.correction_started && !cp.correction
}

/** UI eligibility is deliberately narrower than a general saved-answer retry.
 * The old grant must own this new initial or retain its exact prior origin. */
export function hasSourceStoryCorrectionContinuation(state: ScriptSourceAnalysis, task: Task): boolean {
  const grant = state.ordinary_story_dispatch, cp = task.output_candidate?.checkpoint
  if (!grant || grant.closed_at || sourceQualityRoundConfirmation(state) || grant.run_id !== state.id || grant.work_hash !== state.story_work?.input_hash || !isUnsentSourceStoryCorrection(task)) return false
  if (!grant.protected_task_keys.includes(task.key)) return true
  return !!grant.correction_tasks?.some(entry => entry.task_key === task.key &&
    entry.candidate_hash === task.output_candidate!.context_hash && entry.base_input_hash === cp!.input_hash &&
    entry.initial_response_hash === responseHash(cp!.original_raw!))
}

export function createSourceStoryDispatchGrant(context: Context,
  previousGrant?: ScriptSourceAnalysis['ordinary_story_dispatch']): ScriptSourceAnalysis['ordinary_story_dispatch'] {
  const { state } = context
  if ((!state.story_work && !state.story) || !state.configuration_hash || state.configuration_hash !== context.configuration_hash) return
  if (sourceQualityRoundConfirmation(state)) return
  const qualityShell = state.quality_work, qualityCp = qualityShell?.output_checkpoint
  const emptyQualityShell = !!state.story && !state.story_work && qualityShell?.input_hash === sourceQualityInputHash(state) &&
    Object.keys(qualityShell.checkpoint.steps).length === 0 && qualityCp?.raw === undefined && qualityCp?.original_raw === undefined &&
    !qualityCp?.initial_started && !qualityCp?.correction_started && !qualityCp?.correction && !qualityCp?.correction_request
  const qualityUnstarted = !state.quality && !state.quality_repair && (!qualityShell || emptyQualityShell)
  const currentBinding = binding(context)
  const previousBindingMatches = !previousGrant?.closed_at && previousGrant?.binding === currentBinding
  const previousMatches = previousBindingMatches && previousGrant.work_hash === state.story_work?.input_hash
  const workflow = workflowFor(context.document, state)
  if (workflow?.phase === 'review' && previousBindingMatches && previousGrant.quality_workflow?.phase === 'review' &&
    previousGrant.quality_workflow.review_hash === workflow.review_hash && previousGrant.quality_workflow.findings_hash === workflow.findings_hash &&
    previousGrant.quality_workflow.current_hash === workflow.current_hash && previousGrant.quality_workflow.finding_index === workflow.finding_index) {
    workflow.review_input_hash = previousGrant.quality_workflow.review_input_hash
  }
  if (workflow?.phase === 'review' && workflow.review_input_hash) {
    const work = state.quality_work?.input_hash === workflow.review_input_hash ? state.quality_work : undefined
    workflow.protected_review = !!work && (!checkpointEmpty(work.output_checkpoint) || Object.keys(work.checkpoint.steps).length > 0)
  }
  if (workflow?.phase === 'repair') {
    const expectedOutput = fingerprint([repairCheckpointFor(context.document, state, workflow.finding_index), state.model_id, state.configuration_hash])
    const cp = state.quality_repair_output?.binding === expectedOutput ? state.quality_repair_output.checkpoint : undefined
    // An old proposal whose identity no longer matches must not be discarded
    // merely because this explicit continuation created a new run identifier.
    if (state.quality_repair_output && (!cp || !checkpointEmpty(cp))) workflow.protected_repair_bindings.push(workflow.checkpoint_hash)
    const previousWorkflow = previousBindingMatches ? previousGrant.quality_workflow : undefined
    const samePrevious = previousWorkflow?.phase === 'repair' && previousWorkflow.checkpoint_hash === workflow.checkpoint_hash
    workflow.repair_initial_run_id = samePrevious
      ? previousWorkflow.repair_initial_run_id || (!previousWorkflow.protected_repair_bindings.includes(workflow.checkpoint_hash) ? previousGrant!.run_id : undefined)
      : !workflow.protected_repair_bindings.length ? state.id : undefined
    const task = cp && { key: 'repair', output_candidate: { context_hash: workflow.checkpoint_hash, checkpoint: cp } }
    if (previousWorkflow?.phase === 'repair' && previousWorkflow.checkpoint_hash === workflow.checkpoint_hash && task && isUnsentSourceStoryCorrection(task)) {
      const inherited = previousWorkflow.repair_correction
      const origin = inherited?.checkpoint_hash === workflow.checkpoint_hash && inherited.base_input_hash === cp!.input_hash &&
        inherited.initial_response_hash === responseHash(cp!.original_raw!) ? inherited.initial_run_id
        : !previousWorkflow.protected_repair_bindings.includes(workflow.checkpoint_hash) ? previousGrant!.run_id : undefined
      if (origin) workflow.repair_correction = { checkpoint_hash: workflow.checkpoint_hash, base_input_hash: cp!.input_hash!,
        initial_response_hash: responseHash(cp!.original_raw!), initial_run_id: origin }
    }
  }
  const correctionTasks = previousMatches
    ? (state.story_work?.tasks || []).flatMap(task => {
      if (!isUnsentSourceStoryCorrection(task)) return []
      const cp = task.output_candidate!.checkpoint, hash = responseHash(cp.original_raw!)
      const inherited = previousGrant.correction_tasks?.find(entry => entry.task_key === task.key &&
        entry.candidate_hash === task.output_candidate!.context_hash && entry.base_input_hash === cp.input_hash && entry.initial_response_hash === hash)
      const origin = inherited?.initial_run_id || (!previousGrant.protected_task_keys.includes(task.key) ? previousGrant.run_id : undefined)
      return origin ? [{ task_key: task.key, candidate_hash: task.output_candidate!.context_hash,
        base_input_hash: cp.input_hash!, initial_run_id: origin, initial_response_hash: hash }] : []
    }) : []
  const qualityHash = workflow?.phase === 'review' ? workflow.review_input_hash
    : state.story && !state.story_work && !state.quality && !state.quality_repair ? sourceQualityInputHash(state) : undefined
  const qualityCheckpoint = state.quality_work?.input_hash === qualityHash ? state.quality_work?.output_checkpoint : undefined
  const qualityTask = qualityCheckpoint && { key: 'quality:initial', output_candidate: { context_hash: qualityHash!, checkpoint: qualityCheckpoint } }
  const qualityEligible = previousBindingMatches && qualityTask && isUnsentSourceStoryCorrection(qualityTask) && previousGrant.quality_input_hash === qualityHash
  const inheritedQuality = qualityEligible ? previousGrant.correction_tasks?.find(entry => entry.task_key === 'quality:initial' &&
    entry.candidate_hash === qualityHash && entry.base_input_hash === qualityCheckpoint!.input_hash &&
    entry.initial_response_hash === responseHash(qualityCheckpoint!.original_raw!)) : undefined
  const qualityOrigin = inheritedQuality?.initial_run_id || (qualityEligible && !previousGrant.quality_workflow?.protected_review && !previousGrant.correction_tasks?.some(entry => entry.task_key === 'quality:initial')
    ? previousGrant.run_id : undefined)
  const qualityInitialOrigin = qualityHash && previousBindingMatches && previousGrant.quality_input_hash === qualityHash
    ? previousGrant.quality_initial_run_id || (!previousGrant.quality_workflow?.protected_review ? previousGrant.run_id : undefined)
    : qualityUnstarted ? state.id : undefined
  if (qualityOrigin) correctionTasks.push({ task_key: 'quality:initial', candidate_hash: qualityHash!, base_input_hash: qualityCheckpoint!.input_hash!,
    initial_run_id: qualityOrigin, initial_response_hash: responseHash(qualityCheckpoint!.original_raw!) })
  return { run_id: state.id, binding: currentBinding, work_hash: state.story_work?.input_hash,
    protected_task_keys: state.story_work?.tasks.filter(task => !isUnstartedSourceStoryTask(task)).map(task => task.key) || [],
    authorized_at: new Date().toISOString(), ...(workflow ? { quality_workflow: workflow } : {}), ...(qualityInitialOrigin ? { quality_initial_run_id: qualityInitialOrigin } : {}), ...(correctionTasks.length ? { correction_tasks: correctionTasks } : {}), ...(qualityOrigin || workflow?.review_input_hash ? { quality_input_hash: qualityHash } : qualityUnstarted ? state.story
      ? { quality_input_hash: sourceQualityInputHash(state) } : { quality_pending_story: true } : {}) }
}

/** A durable failure and a live unknown ledger must agree. An initial marker
 * alone also exists during healthy concurrent streaming and cannot block it. */
export function hasFailedSourceStoryDispatch(state: ScriptSourceAnalysis): boolean {
  return !!state.story_work?.tasks.some(task => {
    const cp = task.output_candidate?.checkpoint
    return !!task.failure && task.failure.code !== 'source_request_sibling_pending' &&
      !!cp && (!!cp.initial_started && cp.raw === undefined || !!cp.correction_started && cp.correction === undefined)
  })
}

function currentGrant(context: Context) {
  const { state } = context, grant = state.ordinary_story_dispatch
  return context.local_active && state.status === 'running' && !grant?.closed_at && !sourceQualityRoundConfirmation(state) && grant?.run_id === state.id &&
    grant.binding === binding(context) && state.configuration_hash === context.configuration_hash &&
    !(context.current_run_unknown && hasFailedSourceStoryDispatch(state)) ? grant : undefined
}

/** Persist with the successful synthesis checkpoint, before story_work is lost
 * across a process restart. It cannot promote an old quality attempt. */
export function bindSourceQualityDispatchGrant(context: Context, completedWorkHash?: string): void {
  const { state } = context, grant = currentGrant(context)
  if (!grant?.quality_pending_story || !completedWorkHash || grant.work_hash !== completedWorkHash ||
    !state.story || state.story_work || state.quality || state.quality_work || state.quality_repair) return
  grant.quality_input_hash = sourceQualityInputHash(state)
  grant.quality_initial_run_id = state.id
  delete grant.quality_pending_story
}

export function sourceQualityDispatchAuthorized(context: Context, request: InitialSourceQualityRequest): boolean {
  const { state } = context, grant = currentGrant(context)
  const cp = state.quality_work?.output_checkpoint
  const workflow = grant?.quality_workflow
  const recheck = workflow?.phase === 'review' && !workflow.protected_review && workflowMatches(workflow, state) &&
    workflow.finding_index === state.quality!.findings.length && workflow.review_input_hash === request.candidate_hash
  return !!grant?.quality_input_hash && !context.current_run_unknown && !!state.story && !state.story_work &&
    ((!state.quality && !state.quality_repair && request.candidate_hash === sourceQualityInputHash(state)) || recheck) &&
    grant.quality_input_hash === request.candidate_hash &&
    (!state.quality_work || state.quality_work.input_hash === request.candidate_hash) && (request.task_key !== 'quality:initial' ||
      !cp || cp.raw === undefined && cp.original_raw === undefined && !cp.correction && !cp.correction_started &&
        (!cp.initial_started || !!cp.input_hash && cp.initial_started.input_hash === cp.input_hash))
}

/** Only the validated producer commit may move this exact allowance forward.
 * A changed counter, stale review or unrelated saved proposal cannot do so. */
export function advanceSourceQualityRepairDispatchGrant(document: Pick<ScriptSourceDocument, 'filename' | 'content'>,
  state: ScriptSourceAnalysis, previous: SourceRepairUpgradeBinding): void {
  const grant = state.ordinary_story_dispatch, workflow = grant?.quality_workflow
  if (!grant || grant.closed_at || grant.run_id !== state.id || state.status !== 'running' || !workflow || workflow.phase !== 'repair' ||
    workflow.checkpoint_hash !== previous.checkpoint_hash || workflow.review_hash !== previous.review_hash ||
    workflow.findings_hash !== previous.findings_hash || workflow.finding_index !== previous.finding_index || workflow.current_hash !== previous.current_hash ||
    sourceQualityRepairProgress(state) !== previous.finding_index + 1 || state.quality?.input_hash !== previous.review_hash ||
    responseHash(JSON.stringify(state.quality.findings)) !== previous.findings_hash ||
    state.quality_repair_output?.binding !== fingerprint([previous, state.model_id, state.configuration_hash]) ||
    state.quality_repair_output.checkpoint.raw === undefined) return
  const next = workflowFor(document, state)
  if (!next) return
  next.protected_repair_bindings = [...workflow.protected_repair_bindings]
  if (next.phase === 'repair') next.repair_initial_run_id = state.id
  grant.quality_workflow = next
  delete grant.quality_input_hash
  delete grant.quality_initial_run_id
}

/** A batch may advance only after all its bound members are committed. Partial
 * journals stay local and cannot acquire a replacement provider allowance. */
export function advanceSourceQualityRepairBatchDispatchGrant(document: Pick<ScriptSourceDocument, 'filename' | 'content'>,
  state: ScriptSourceAnalysis, batch: SourceRepairBatchBinding): void {
  const grant = state.ordinary_story_dispatch, workflow = grant?.quality_workflow, journal = state.quality_repair_batch
  const proof = batch.anchor, indexes = batch.members.map(member => member.finding_index)
  if (!grant || grant.closed_at || grant.bounded_quality || grant.run_id !== state.id || state.status !== 'running' || workflow?.phase !== 'repair' ||
    workflow.checkpoint_hash !== proof.checkpoint_hash || workflow.finding_index !== proof.finding_index ||
    workflow.review_hash !== batch.review_hash || workflow.findings_hash !== batch.findings_hash || workflow.current_hash !== batch.before_hash ||
    journal?.binding.batch_hash !== batch.batch_hash || journal.checkpoint.raw === undefined ||
    JSON.stringify([...journal.committed_indices].sort((a, b) => a - b)) !== JSON.stringify(indexes) ||
    sourceQualityRepairProgress(state) !== proof.finding_index + batch.members.length ||
    state.quality?.input_hash !== batch.review_hash || responseHash(JSON.stringify(state.quality.findings)) !== batch.findings_hash) return
  const next = workflowFor(document, state)
  if (!next) return
  next.protected_repair_bindings = [...workflow.protected_repair_bindings]
  if (next.phase === 'repair') next.repair_initial_run_id = state.id
  grant.quality_workflow = next
  delete grant.quality_input_hash
  delete grant.quality_initial_run_id
}

/** The second audit is bound to its actual prompt context, including any
 * evidence-backed withdrawals. It is not an unlimited review permission. */
export function bindSourceQualityRecheckDispatchGrant(state: ScriptSourceAnalysis, reviewInputHash: string): void {
  const grant = state.ordinary_story_dispatch, workflow = grant?.quality_workflow
  if (!grant || grant.closed_at || grant.run_id !== state.id || state.status !== 'running' || workflow?.phase !== 'review' ||
    !workflowMatches(workflow, state) || workflow.finding_index !== state.quality!.findings.length) return
  if (workflow.review_input_hash && workflow.review_input_hash !== reviewInputHash) return
  if (workflow.protected_review === undefined) {
    const work = state.quality_work?.input_hash === reviewInputHash ? state.quality_work : undefined
    workflow.protected_review = !!work && (!checkpointEmpty(work.output_checkpoint) || Object.keys(work.checkpoint.steps).length > 0)
  }
  workflow.review_input_hash = reviewInputHash
  grant.quality_input_hash = reviewInputHash
  if (!workflow.protected_review) grant.quality_initial_run_id ??= state.id
}

/** A first audit owned by this same ordinary grant may materialize its exact
 * findings once. Later audits retain their result but need another explicit
 * continuation before any new finding can acquire a repair allowance. */
export function bindSourceQualityFindingsDispatchGrant(document: Pick<ScriptSourceDocument, 'filename' | 'content'>,
  state: ScriptSourceAnalysis, completedReviewInputHash: string): void {
  const grant = state.ordinary_story_dispatch
  if (!grant || grant.closed_at || grant.run_id !== state.id || state.status !== 'running' || grant.quality_workflow ||
    grant.quality_input_hash !== completedReviewInputHash || state.quality?.input_hash !== sourceQualityInputHash(state) ||
    state.quality?.status !== 'issues' || !state.quality.findings.length || state.quality_repair) return
  const workflow = workflowFor(document, state)
  if (!workflow || workflow.phase !== 'repair') return
  grant.quality_workflow = workflow
  workflow.repair_initial_run_id = state.id
  delete grant.quality_input_hash
  delete grant.quality_initial_run_id
}

export function sourceRepairDispatchAuthorized(context: Context, request: InitialSourceRepairRequest): boolean {
  const { state } = context, grant = currentGrant(context), workflow = grant?.quality_workflow, proof = request.binding
  if (!grant || context.current_run_unknown || workflow?.phase !== 'repair' || !workflowMatches(workflow, state) ||
    workflow.checkpoint_hash !== proof.checkpoint_hash || workflow.protected_repair_bindings.includes(proof.checkpoint_hash) ||
    proof.finding_index !== workflow.finding_index || proof.review_hash !== workflow.review_hash || proof.findings_hash !== workflow.findings_hash ||
    proof.current_hash !== workflow.current_hash || sourceRepairRequestCheckpoint(context.document, state, workflow.finding_index).checkpoint_hash !== proof.checkpoint_hash ||
    !/^[a-f0-9]{64}$/.test(request.requestKey)) return false
  if (request.batch) {
    const batch = request.batch, output = state.quality_repair_batch, cp = output?.checkpoint
    if (grant.bounded_quality || state.quality_repair_output || batch.members.length < 2 || batch.members.length > 3 ||
      batch.policy !== 'source-quality-repair-batch-v1' || batch.before_hash !== workflow.current_hash ||
      batch.review_hash !== workflow.review_hash || batch.findings_hash !== workflow.findings_hash ||
      canonicalAiValue(batch.anchor) !== canonicalAiValue(proof) || !output || canonicalAiValue(output.binding) !== canonicalAiValue(batch) ||
      output.committed_indices.length || !cp || cp.raw !== undefined || cp.original_raw !== undefined ||
      cp.correction || cp.correction_request || cp.correction_started || cp.local_repair ||
      cp.initial_started && (!cp.input_hash || cp.initial_started.input_hash !== cp.input_hash)) return false
    let issueType: string | undefined
    const targets: string[] = []
    for (const [offset, member] of batch.members.entries()) {
      const finding = state.quality!.findings[member.finding_index], assessment = finding?.assessment
      if (member.finding_index !== workflow.finding_index + offset || !assessment ||
        member.finding_hash !== digest(finding) || !member.analysis_paths.length ||
        canonicalAiValue(member.analysis_paths) !== canonicalAiValue(assessment.analysis_paths) ||
        issueType && issueType !== assessment.issue_type) return false
      issueType = assessment.issue_type
      const memberTargets = new Set<string>()
      for (const path of member.analysis_paths) {
        // Whole array items are the atomic replacement unit. Two leaves of
        // one item are not independent edits, and a parent overlaps its child.
        const target = path.replace(/((?:characters|timeline|threads|uncertainties|events|open_threads)\[\d+\])(?:\..*)?$/, '$1').replace(/^story\.ending(?:\..*)?$/, 'story.ending')
        if (targets.some(other => other === target || other.startsWith(target + '.') || target.startsWith(other + '.') ||
          other.startsWith(target + '[') || target.startsWith(other + '['))) return false
        memberTargets.add(target)
      }
      targets.push(...memberTargets)
    }
    return canonicalAiValue(sourceRepairBatchBinding(context.document, state, batch.members)) === canonicalAiValue(batch)
  }
  if (state.quality_repair_batch) return false
  const output = state.quality_repair_output, cp = output?.checkpoint
  return output?.binding === fingerprint([proof, state.model_id, state.configuration_hash]) && !!cp && cp.raw === undefined && cp.original_raw === undefined &&
    !cp.correction && !cp.correction_request && !cp.correction_started && !cp.local_repair &&
    (!cp.initial_started || !!cp.input_hash && cp.initial_started.input_hash === cp.input_hash)
}

export function sourceRepairCorrectionDispatchAuthorized(context: Context, request: DerivedSourceRepairCorrectionRequest, initialRunId: string): boolean {
  const { state } = context, grant = currentGrant(context), workflow = grant?.quality_workflow, proof = request.binding
  const output = state.quality_repair_output, cp = output?.checkpoint, frozen = cp?.correction_request
  if (!grant || context.current_run_unknown || workflow?.phase !== 'repair' || !workflowMatches(workflow, state) ||
    workflow.checkpoint_hash !== proof.checkpoint_hash || sourceRepairRequestCheckpoint(context.document, state, workflow.finding_index).checkpoint_hash !== proof.checkpoint_hash ||
    output?.binding !== fingerprint([proof, state.model_id, state.configuration_hash]) || !cp || !frozen ||
    cp.input_hash !== request.base_input_hash || typeof cp.raw !== 'string' || cp.raw !== cp.original_raw || responseHash(cp.raw) !== request.initial_response_hash ||
    cp.initial_started || cp.correction || frozen.base_input_hash !== request.base_input_hash || frozen.input_hash !== request.correction_input_hash ||
    frozen.input_hash !== fingerprint([frozen.prompt, frozen.contract]) ||
    cp.correction_started && cp.correction_started.input_hash !== frozen.input_hash ||
    !['script_source_quality_repair', 'script_source_quality_repair_local_repair', 'script_source_quality_repair_structure_repair'].includes(frozen.contract.name) ||
    request.request_key !== digest([state.model_id, frozen.prompt, frozen.contract]) || !/^[a-f0-9]{64}$/.test(request.initial_request_key)) return false
  const inherited = workflow.repair_correction
  return inherited ? inherited.checkpoint_hash === proof.checkpoint_hash && inherited.base_input_hash === request.base_input_hash &&
    inherited.initial_response_hash === request.initial_response_hash && inherited.initial_run_id === initialRunId
    : workflow.repair_initial_run_id ? workflow.repair_initial_run_id === initialRunId
      : !workflow.protected_repair_bindings.includes(proof.checkpoint_hash) && initialRunId === grant.run_id
}

/** Both the first adapter check and the final transport boundary call this
 * against a freshly loaded running row; the grant never authorizes old bytes. */
export function sourceStoryDispatchAuthorized(context: Context, request: InitialSourceStoryRequest): boolean {
  const { state } = context, grant = currentGrant(context), work = state.story_work
  if (!grant || !work || work.input_hash !== grant.work_hash || grant.protected_task_keys.includes(request.task_key)) return false
  const task = work.tasks.find(task => task.key === request.task_key), cp = task?.output_candidate?.checkpoint
  return !!task && task.result === undefined && (!task.failure || ['source_request_sibling_pending', 'source_local_model_required'].includes(task.failure.code || '')) && !task.output_checkpoint && !task.recovery &&
    task.output_candidate?.context_hash === request.candidate_hash && !!cp &&
    cp.raw === undefined && cp.original_raw === undefined && !cp.correction && !cp.correction_request && !cp.correction_started &&
    (!cp.initial_started || !!cp.input_hash && cp.initial_started.input_hash === cp.input_hash)
}

/** Only the first exact correction derived from a new ordinary initial may
 * bypass an unrelated recovery permit. The adapter separately proves the
 * completed initial ledger row and guards the correction's exact dispatch. */
export function sourceStoryCorrectionDispatchAuthorized(context: Context, request: DerivedSourceCorrectionRequest, initialRunId: string): boolean {
  const { state } = context, grant = currentGrant(context), work = state.story_work
  if (!grant || !work || work.input_hash !== grant.work_hash) return false
  const task = work.tasks.find(task => task.key === request.task_key), cp = task?.output_candidate?.checkpoint, frozen = cp?.correction_request
  if (!task || task.result !== undefined || task.output_checkpoint || task.recovery || !cp || !frozen ||
    task.output_candidate?.context_hash !== request.candidate_hash || cp.input_hash !== request.base_input_hash ||
    typeof cp.raw !== 'string' || typeof cp.original_raw !== 'string' || cp.raw !== cp.original_raw ||
    responseHash(cp.original_raw) !== request.initial_response_hash || cp.initial_started || cp.correction ||
    frozen.base_input_hash !== request.base_input_hash || frozen.input_hash !== request.correction_input_hash ||
    frozen.input_hash !== fingerprint([frozen.prompt, frozen.contract]) ||
    cp.correction_started && cp.correction_started.input_hash !== frozen.input_hash ||
    !(frozen.contract.name === `script_source_story_${request.task_key.split(':')[0]}` ||
      request.task_key.startsWith('timeline:') && frozen.contract.name === 'script_source_story_timeline_local_repair') ||
    request.request_key !== digest([state.model_id, frozen.prompt, frozen.contract]) ||
    !/^[a-f0-9]{64}$/.test(request.initial_request_key)) return false
  if (!grant.protected_task_keys.includes(task.key)) return initialRunId === grant.run_id
  return !!grant.correction_tasks?.some(entry => entry.task_key === task.key && entry.candidate_hash === request.candidate_hash &&
    entry.base_input_hash === request.base_input_hash && entry.initial_response_hash === request.initial_response_hash && entry.initial_run_id === initialRunId)
}

export function sourceQualityCorrectionDispatchAuthorized(context: Context, request: DerivedSourceCorrectionRequest, initialRunId: string): boolean {
  const { state } = context, grant = currentGrant(context), cp = state.quality_work?.output_checkpoint, frozen = cp?.correction_request
  const workflow = grant?.quality_workflow
  const recheck = workflow?.phase === 'review' && workflowMatches(workflow, state) &&
    workflow.finding_index === state.quality!.findings.length && workflow.review_input_hash === request.candidate_hash
  if (!grant?.quality_input_hash || context.current_run_unknown || request.task_key !== 'quality:initial' || !state.story || state.story_work ||
    ((!recheck && (state.quality || state.quality_repair || request.candidate_hash !== sourceQualityInputHash(state)))) || state.quality_work?.input_hash !== request.candidate_hash ||
    request.candidate_hash !== grant.quality_input_hash || !cp || !frozen ||
    cp.input_hash !== request.base_input_hash || typeof cp.raw !== 'string' || typeof cp.original_raw !== 'string' || cp.raw !== cp.original_raw ||
    responseHash(cp.original_raw) !== request.initial_response_hash || cp.initial_started || cp.correction ||
    frozen.base_input_hash !== request.base_input_hash || frozen.input_hash !== request.correction_input_hash ||
    frozen.input_hash !== fingerprint([frozen.prompt, frozen.contract]) ||
    cp.correction_started && cp.correction_started.input_hash !== frozen.input_hash || frozen.contract.name !== 'script_source_quality' ||
    request.request_key !== digest([state.model_id, frozen.prompt, frozen.contract]) || !/^[a-f0-9]{64}$/.test(request.initial_request_key)) return false
  const inherited = grant.correction_tasks?.find(entry => entry.task_key === request.task_key)
  return inherited ? inherited.candidate_hash === request.candidate_hash && inherited.base_input_hash === request.base_input_hash &&
    inherited.initial_response_hash === request.initial_response_hash && inherited.initial_run_id === initialRunId
    : grant.quality_initial_run_id ? grant.quality_initial_run_id === initialRunId : !workflow?.protected_review && initialRunId === grant.run_id
}
