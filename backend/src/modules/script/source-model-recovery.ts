import { createHash } from 'node:crypto'
import { canonicalAiValue } from '@video-studio/shared/api/ai-operations'
import { db, now } from '../../infrastructure/database/db.js'
import { withTextResponseRecovery, type BackgroundResponse } from '../../infrastructure/providers/text-background.js'
import { currentModelRequestContext, withModelRequestContext, modelTaskPolicies } from '../generation/model-task-policy.js'
import { TextProviderError } from '../../infrastructure/providers/text-errors.js'
import { currentStructuredDispatchIntent, protectStructuredDispatchIntent, type StructuredDispatchIntent } from '../generation/model-request-admission.js'
import { initSourceModelAdmission, recordSourceModelAdmission, sourceModelAdmissionDenied } from './source-model-admission.js'
export { sourceModelAdmissionFact, applyTrustedNotSentToCheckpoint } from './source-model-admission.js'
export type { SourceModelAdmissionFact, SourceModelAdmissionQuery } from './source-model-admission.js'
import { isSourceAnalysisContract } from '../generation/source-analysis-contracts.js'
import { initSourceRequestRecovery, sourceRequestBlockers, latestSourceRecoveryEpoch, pendingSourceRecoveryEpoch, pendingSourceRecoveryEpochs, frozenSourceRequest, recordLateSourceRequest, recordSourceDispatch, recordSourceUpstream, sourceRecoveryConflict, sourceRecoveryEpochCurrent, nextOrdinarySourceEpoch, validateSupersededSourceCheckpoint, supersedeSourceCheckpoint, validateSourceRepairContractUpgrade, supersedeSourceRepairContract, unsettledSourceRepairUpgradeEpoch, type SupersededSourceCheckpoint } from './source-request-recovery.js'
import { currentInitialSourceRepairRequest, currentDerivedSourceRepairCorrectionRequest, currentFrozenSourceCorrectionRead, sourceRepairReferencePolicy,
  type SourceRepairContractUpgrade, type SourceRepairUpgradeBinding, type InitialSourceRepairRequest,
  type DerivedSourceRepairCorrectionRequest } from './source-repair-request-identity.js'
import type { SourceAnalyzer } from './script-source-analysis.js'
import { currentInitialSourceStoryRequest, currentInitialSourceQualityRequest, currentDerivedSourceCorrectionRequest,
  type InitialSourceStoryRequest, type InitialSourceQualityRequest, type DerivedSourceCorrectionRequest } from './source-story-dispatch-identity.js'

type RequestRow = { state: string; run_id: string; result: string | null; delivery: string; response_key?: string | null }
const digest = (value: unknown) => createHash('sha256').update(canonicalAiValue(value)).digest('hex')
const requestScope = (identity: unknown, namespace?: string) => digest(namespace ? { identity, controlled_recovery: namespace } : identity)
const ledgerKey = (base: string, namespace?: string) => namespace ? digest(['source-controlled-request-v1', namespace, base]) : base
export function initSourceModelRecovery() {
  db.exec(`CREATE TABLE IF NOT EXISTS source_model_runs (id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS source_model_requests (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,request_key TEXT NOT NULL,run_id TEXT NOT NULL,state TEXT NOT NULL,delivery TEXT NOT NULL,
    result TEXT,response_key TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,scope,request_key));
    CREATE TABLE IF NOT EXISTS source_model_responses (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,response_key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(project_id,scope,response_key));`)
  const columns = db.prepare('PRAGMA table_info(source_model_requests)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'response_key')) db.exec('ALTER TABLE source_model_requests ADD COLUMN response_key TEXT')
  initSourceRequestRecovery()
  initSourceModelAdmission()
}

/** UI eligibility is read-only; actual re-entry still verifies the exact request. */
export function sourceModelRecoveryBlocked(projectId: string, runIds: string[]): boolean {
  return sourceRequestBlockers(projectId, runIds).length > 0
}
export function markSourceModelRun(projectId: string, id: string) {
  initSourceModelRecovery()
  db.prepare('INSERT OR IGNORE INTO source_model_runs (id,project_id) VALUES (?,?)').run(id, projectId)
}
export function hasSourceModelRun(projectId: string, id: string) {
  initSourceModelRecovery()
  return !!db.prepare('SELECT 1 FROM source_model_runs WHERE id=? AND project_id=?').get(id, projectId)
}
/** Local validation may look up complete bytes, but must not register a run,
 * promote a response, prepare a request or enter the provider adapter. */
export function sourceModelCompletedReader(projectId: string, runId: string, identity: unknown,
  completedStoryRunIds: string[] = [], requestNamespace?: string): NonNullable<SourceAnalyzer['readCompleted']> {
  const scope = requestScope(identity, requestNamespace)
  const inherited = new Set(completedStoryRunIds)
  return async (...args) => {
    args[4].throwIfAborted()
    if (!isSourceAnalysisContract(args[3]?.name)) return
    const baseKey = digest([args[1], args[2], args[3]]), key = ledgerKey(baseKey, requestNamespace)
    const base = db.prepare('SELECT state,run_id,result,delivery FROM source_model_requests WHERE project_id=? AND scope=? AND request_key=?')
      .get(projectId, scope, key) as RequestRow | undefined
    const row = latestSourceRecoveryEpoch(projectId, scope, key, [runId, ...inherited]) ?? base
    const correctionRead = currentFrozenSourceCorrectionRead()
    if (correctionRead) {
      const model = identity && typeof identity === 'object' ? (identity as { model?: unknown }).model : undefined
      const hashes = [correctionRead.base_input_hash, correctionRead.initial_request_key, correctionRead.initial_response_hash,
        correctionRead.correction_input_hash, correctionRead.request_key]
      const repair = correctionRead.kind === 'repair' && args[3]?.name === 'script_source_quality_repair' &&
        correctionRead.binding.policy === sourceRepairReferencePolicy && Number.isSafeInteger(correctionRead.binding.finding_index) &&
        correctionRead.binding.finding_index >= 0 && ['checkpoint_hash', 'finding_hash', 'review_hash', 'findings_hash', 'current_hash']
          .every(field => /^[a-f0-9]{64}$/.test(correctionRead.binding[field as keyof SourceRepairUpgradeBinding] as string))
      const quality = correctionRead.kind === 'quality' && args[3]?.name === 'script_source_quality' &&
        /^[a-f0-9]{64}$/.test(correctionRead.candidate_hash)
      if (model !== args[1] || !repair && !quality || !hashes.every(value => /^[a-f0-9]{64}$/.test(value)) ||
        correctionRead.request_key !== baseKey || correctionRead.initial_request_key === baseKey ||
        correctionRead.correction_input_hash !== createHash('sha256').update(JSON.stringify([args[2], args[3]])).digest('hex') ||
        correctionRead.initial_run_id !== runId && !inherited.has(correctionRead.initial_run_id) ||
        frozenSourceRequest(projectId, scope, ledgerKey(correctionRead.initial_request_key, requestNamespace))) return
      const initial = db.prepare('SELECT state,run_id,result,delivery FROM source_model_requests WHERE project_id=? AND scope=? AND request_key=?')
        .get(projectId, scope, ledgerKey(correctionRead.initial_request_key, requestNamespace)) as RequestRow | undefined
      if (!initial || initial.run_id !== correctionRead.initial_run_id || initial.state !== 'completed' || initial.delivery !== 'completed' ||
        initial.result === null || createHash('sha256').update(initial.result).digest('hex') !== correctionRead.initial_response_hash ||
        !db.prepare('SELECT 1 FROM source_request_dispatch_links WHERE project_id=? AND scope=? AND request_key=? AND run_id=?')
          .get(projectId, scope, ledgerKey(correctionRead.initial_request_key, requestNamespace), initial.run_id)) return
      if (!row || row.run_id !== runId && !inherited.has(row.run_id)) return
      if (row.state === 'dispatched') throw Object.assign(new Error('已冻结纠正请求的最终结果未知，不能自动重新派发。'), {
        statusCode: 409, code: 'source_request_unknown', outcome_certainty: 'unknown',
      })
      if (row.state === 'completed' && row.delivery === 'completed' && row.result !== null) return row.result
      return
    }
    const story = ['script_source_story', 'script_source_story_structure_repair', 'script_source_story_local_repair'].includes(args[3]?.name || '') ||
      /^script_source_story_(overview|characters|characters_merge|timeline|threads|uncertainties)(?:_(?:structure|local)_repair)?$/.test(args[3]?.name || '')
    const initialQuality = ['script_source_quality', 'script_source_quality_repair', 'script_source_quality_repair_batch'].includes(args[3]?.name || '') &&
      !args[2].includes('\n【一次格式修正】\n') && currentModelRequestContext()?.operationStage !== 'format_correction' &&
      !currentDerivedSourceCorrectionRequest() && !currentDerivedSourceRepairCorrectionRequest()
    if (!row || row.run_id !== runId && !((story || initialQuality) && inherited.has(row.run_id))) return
    if (row.state === 'dispatched') throw Object.assign(new Error('上次原稿分析请求的受理结果未知，不能自动重新生成。'), {
      statusCode: 409, code: 'source_request_unknown', outcome_certainty: 'unknown',
    })
    if (row.state === 'completed' && row.delivery === 'completed' && row.result !== null) return row.result
  }
}
export function sourceModelRecovery(projectId: string, runId: string, identity: unknown, generate: SourceAnalyzer,
  options: { completedStoryRunId?: string; completedStoryRunIds?: string[]; supersededCheckpoint?: SupersededSourceCheckpoint;
    requestNamespace?: string;
    onControlledDispatch?: (request: { scope: string; request_key: string; base_request_key: string;
      local_request_id: string; contract_name?: string; intent?: StructuredDispatchIntent }) => void;
    repairContractUpgrade?: () => SourceRepairContractUpgrade | undefined;
    ordinaryStoryDispatch?: (request: InitialSourceStoryRequest) => boolean;
    ordinaryQualityDispatch?: (request: InitialSourceQualityRequest) => boolean;
    ordinaryCorrectionDispatch?: (request: DerivedSourceCorrectionRequest, initialRunId: string) => boolean;
    ordinaryRepairDispatch?: (request: InitialSourceRepairRequest) => boolean;
    ordinaryRepairCorrectionDispatch?: (request: DerivedSourceRepairCorrectionRequest, initialRunId: string) => boolean } = {}) {
  markSourceModelRun(projectId, runId)
  const scope = requestScope(identity, options.requestNamespace)
  const completedStoryRuns = new Set([...(options.completedStoryRunIds || []),
    ...(options.completedStoryRunId ? [options.completedStoryRunId] : [])])
  const recovery = {
    read(key: string): BackgroundResponse | undefined {
      const row = db.prepare('SELECT payload FROM source_model_responses WHERE project_id=? AND scope=? AND response_key=?').get(projectId, scope, key) as { payload: string } | undefined
      if (!row) return
      const value = JSON.parse(row.payload) as BackgroundResponse
      if (!['creating', 'accepted'].includes(value.state) || value.id !== undefined && !/^resp_[a-zA-Z0-9_-]+$/.test(value.id)) throw Object.assign(new Error('原稿分析的上游响应身份损坏，已停止自动派发'), { statusCode: 409 })
      return value
    },
    save(key: string, value?: BackgroundResponse) {
      if (!value) { db.prepare('DELETE FROM source_model_responses WHERE project_id=? AND scope=? AND response_key=?').run(projectId, scope, key); return }
      db.prepare(`INSERT INTO source_model_responses (project_id,scope,response_key,payload) VALUES (?,?,?,?)
        ON CONFLICT(project_id,scope,response_key) DO UPDATE SET payload=excluded.payload`).run(projectId, scope, key, JSON.stringify(value))
    },
  }
  // A process reconstruction may consume the last complete upstream reply once.
  // Repeated semantic work inside the same live run remains intentional new work.
  const delivered = new Set<string>()
  const wrapped: SourceAnalyzer = async (...args) => {
    args[4].throwIfAborted()
    const baseKey = digest([args[1], args[2], args[3]]), key = ledgerKey(baseKey, options.requestNamespace)
    const intent = currentStructuredDispatchIntent()
    let enteredProvider = false, completedDispatch = false, dispatchDenied = false, existingBarrier = false
    let cleanupUnsentBackground: (() => void) | undefined
    try {
    if (options.requestNamespace && !options.onControlledDispatch) sourceRecoveryConflict('独立恢复请求缺少本次授权的原子派发门禁，未发起请求')
    const baseRow = db.prepare('SELECT state,run_id,result,delivery,response_key FROM source_model_requests WHERE project_id=? AND scope=? AND request_key=?').get(projectId, scope, key) as RequestRow | undefined
    let epoch = latestSourceRecoveryEpoch(projectId, scope, key, [runId, ...completedStoryRuns])
    let row = epoch ?? baseRow
    existingBarrier = row?.state === 'dispatched' || !!row && ['accepted', 'output_started', 'unknown'].includes(row.delivery)
    if (existingBarrier) protectStructuredDispatchIntent(intent)
    // A compatible explicit continuation may recover an exact directory page, whole-story or
    // initial quality-repair reply. Correction prompts and quality-repair
    // structure patches remain new work; all replies still require the same
    // scope and request identity and pass the caller's full validation again.
    const storyPart = /^script_source_story_(overview|characters|characters_merge|timeline|threads|uncertainties)(?:_(?:structure|local)_repair)?$/.test(args[3]?.name || '')
    const inheritedStory = row !== undefined && completedStoryRuns.has(row.run_id) &&
      (['script_source_map', 'script_source_map_page', 'script_source_story', 'script_source_story_structure_repair'].includes(args[3]?.name || '') ||
        ['script_source_quality_repair', 'script_source_quality_repair_batch'].includes(args[3]?.name || '') && !args[2].includes('\n【一次格式修正】\n') &&
          currentModelRequestContext()?.operationStage !== 'format_correction' && !currentDerivedSourceRepairCorrectionRequest())
    if (row?.state === 'completed' && (row.run_id === runId || inheritedStory) && row.result !== null && !delivered.has(key)) {
      if (row.run_id !== runId) {
        // Promote before delivery so a crash before the business checkpoint
        // can replay this complete reply under the new execution identity.
        // A failed write stops locally without issuing another provider call.
        if (epoch) db.prepare("UPDATE source_request_recovery_epochs SET run_id=?,updated_at=? WHERE id=? AND run_id=? AND state='completed'").run(runId, now(), epoch.id, row.run_id)
        else db.prepare(`UPDATE source_model_requests SET run_id=?,updated_at=?
          WHERE project_id=? AND scope=? AND request_key=? AND run_id=? AND state='completed'`)
          .run(runId, now(), projectId, scope, key, row.run_id)
      }
      delivered.add(key)
      return row.result
    }
    if (epoch?.state === 'superseded') sourceRecoveryConflict('原请求的恢复许可已因检查点失效而作废，不能重新派发该请求')
    let dispatched = row?.state === 'dispatched', delivery = row?.delivery || 'not_sent'
    const pendingEpoch = pendingSourceRecoveryEpoch(projectId, [runId, ...completedStoryRuns]) ??
      (currentInitialSourceRepairRequest() && options.repairContractUpgrade ? unsettledSourceRepairUpgradeEpoch(projectId, runId) : undefined)
    const differsFromPending = pendingEpoch && (pendingEpoch.scope !== scope || pendingEpoch.request_key !== key)
    const supersession = differsFromPending ? options.supersededCheckpoint : undefined
    const repairRequest = differsFromPending ? currentInitialSourceRepairRequest() : undefined
    const repairUpgrade = () => {
      const current = options.repairContractUpgrade?.()
      const model = identity && typeof identity === 'object' ? (identity as { model?: unknown }).model : undefined
      if (!current || !repairRequest || repairRequest.requestKey !== baseKey || args[3]?.name !== 'script_source_quality_repair' ||
        model !== args[1] || canonicalAiValue(current.binding) !== canonicalAiValue(repairRequest.binding)) {
        sourceRecoveryConflict('待恢复请求的提示词或契约已变化；已有结果已保留，不能把旧许可用于另一请求')
      }
      return current
    }
    // A sibling's permit is not authority for this task. A code-owned initial
    // request may instead hold its own explicit ordinary grant, which must not
    // consume, replace or retire any sibling's exact recovery permission.
    const repairBindingValid = (binding: SourceRepairUpgradeBinding) => binding.policy === sourceRepairReferencePolicy &&
      Number.isSafeInteger(binding.finding_index) && binding.finding_index >= 0 &&
      ['checkpoint_hash', 'finding_hash', 'review_hash', 'findings_hash', 'current_hash'].every(field =>
        /^[a-f0-9]{64}$/.test(binding[field as keyof SourceRepairUpgradeBinding] as string))
    const repairInitialGate = !!options.ordinaryRepairDispatch &&
      (args[3]?.name === 'script_source_quality_repair' || args[3]?.name === 'script_source_quality_repair_batch' && !!currentInitialSourceRepairRequest()?.batch) &&
      currentModelRequestContext()?.operationStage !== 'format_correction'
    const repairCorrectionGate = !!options.ordinaryRepairCorrectionDispatch && args[3]?.name === 'script_source_quality_repair' &&
      currentModelRequestContext()?.operationStage === 'format_correction'
    const ordinaryDispatchAllowed = () => {
      const proof = currentInitialSourceStoryRequest(), qualityProof = currentInitialSourceQualityRequest()
      const correctionProof = currentDerivedSourceCorrectionRequest(), repairProof = currentInitialSourceRepairRequest()
      const repairCorrectionProof = currentDerivedSourceRepairCorrectionRequest()
      const model = identity && typeof identity === 'object' ? (identity as { model?: unknown }).model : undefined
      if (model !== args[1] || epoch || row?.state === 'dispatched' || frozenSourceRequest(projectId, scope, key)) return false
      const story = proof && proof.request_key === baseKey && options.ordinaryStoryDispatch &&
        /^script_source_story_(overview|characters|characters_merge|timeline|threads|uncertainties)$/.test(args[3]?.name || '') &&
        /^[a-f0-9]{64}$/.test(proof.candidate_hash) &&
        proof.task_key.split(':')[0] === args[3]!.name.replace('script_source_story_', '')
      const quality = qualityProof && qualityProof.request_key === baseKey && options.ordinaryQualityDispatch &&
        /^[a-f0-9]{64}$/.test(qualityProof.candidate_hash) &&
        (qualityProof.task_key === 'quality:initial' && args[3]?.name === 'script_source_quality' ||
          qualityProof.task_key === 'quality:page' && args[3]?.name === 'script_source_quality_page') &&
        currentModelRequestContext()?.operationStage !== 'format_correction'
      const correction = correctionProof && correctionProof.request_key === baseKey && options.ordinaryCorrectionDispatch &&
        ['candidate_hash', 'base_input_hash', 'initial_request_key', 'initial_response_hash', 'correction_input_hash'].every(field =>
          /^[a-f0-9]{64}$/.test(correctionProof[field as keyof DerivedSourceCorrectionRequest])) &&
        correctionProof.initial_request_key !== baseKey && currentModelRequestContext()?.operationStage === 'format_correction' &&
        (correctionProof.task_key === 'quality:initial' && args[3]?.name === 'script_source_quality' ||
          /^script_source_story_(overview|characters|characters_merge|timeline|threads|uncertainties)(?:_local_repair)?$/.test(args[3]?.name || '') &&
          correctionProof.task_key.split(':')[0] === args[3]!.name.replace('script_source_story_', '').replace(/_local_repair$/, '')) &&
        correctionProof.correction_input_hash === createHash('sha256').update(JSON.stringify([args[2], args[3]])).digest('hex')
      const repair = repairInitialGate && repairProof && repairProof.requestKey === baseKey && repairBindingValid(repairProof.binding) &&
        (repairProof.batch ? args[3]?.name === 'script_source_quality_repair_batch' : args[3]?.name === 'script_source_quality_repair')
      const repairCorrection = repairCorrectionGate && repairCorrectionProof && repairCorrectionProof.request_key === baseKey &&
        repairBindingValid(repairCorrectionProof.binding) &&
        ['base_input_hash', 'initial_request_key', 'initial_response_hash', 'correction_input_hash'].every(field =>
          /^[a-f0-9]{64}$/.test(repairCorrectionProof[field as keyof DerivedSourceRepairCorrectionRequest] as string)) &&
        repairCorrectionProof.initial_request_key !== baseKey &&
        repairCorrectionProof.correction_input_hash === createHash('sha256').update(JSON.stringify([args[2], args[3]])).digest('hex')
      if (!story && !quality && !correction && !repair && !repairCorrection) return false
      const latest = db.prepare('SELECT state,delivery FROM source_model_requests WHERE project_id=? AND scope=? AND request_key=?')
        .get(projectId, scope, key) as { state: string; delivery: string } | undefined
      // Recheck the live owner as well as the captured row: concurrent callers
      // cannot both turn an ordinary grant into a POST for the same identity.
      if (latest?.state === 'dispatched' && !(dispatched && ['not_sent', 'rejected'].includes(delivery))) return false
      if (correction || repair || repairCorrection) {
        // A repair/derived grant never authorizes another POST once this exact
        // identity completed or was accepted, including a concurrent owner.
        if (latest && !(latest.state === 'prepared' && latest.delivery === 'not_sent' ||
          latest.state === 'settled' && ['not_sent', 'rejected'].includes(latest.delivery) ||
          latest.state === 'dispatched' && dispatched && ['not_sent', 'rejected'].includes(delivery)) ||
          row && !(row.state === 'prepared' && row.delivery === 'not_sent' || row.state === 'settled' && ['not_sent', 'rejected'].includes(row.delivery))) return false
        if (repair) return options.ordinaryRepairDispatch!(repairProof!) === true
        const derived = repairCorrection ? repairCorrectionProof! : correctionProof!
        // A correction's original bytes must be an ordinary complete dispatch,
        // not an unknown request or a dedicated recovery response.
        if (frozenSourceRequest(projectId, scope, ledgerKey(derived.initial_request_key, options.requestNamespace))) return false
        const initial = db.prepare('SELECT state,run_id,result,delivery FROM source_model_requests WHERE project_id=? AND scope=? AND request_key=?')
          .get(projectId, scope, ledgerKey(derived.initial_request_key, options.requestNamespace)) as RequestRow | undefined
        if (!initial || initial.state !== 'completed' || initial.delivery !== 'completed' || initial.result === null ||
          createHash('sha256').update(initial.result).digest('hex') !== derived.initial_response_hash ||
          !db.prepare('SELECT 1 FROM source_request_dispatch_links WHERE project_id=? AND scope=? AND request_key=? AND run_id=?')
            .get(projectId, scope, ledgerKey(derived.initial_request_key, options.requestNamespace), initial.run_id)) return false
        return repairCorrection ? options.ordinaryRepairCorrectionDispatch!(repairCorrectionProof!, initial.run_id) === true
          : options.ordinaryCorrectionDispatch!(correctionProof!, initial.run_id) === true
      }
      return story ? options.ordinaryStoryDispatch!(proof!) === true : options.ordinaryQualityDispatch!(qualityProof!) === true
    }
    const blockSibling = (requireOrdinary = false) => {
      const otherPending = pendingSourceRecoveryEpochs(projectId, [runId, ...completedStoryRuns])
        .some(pending => pending.scope !== scope || pending.request_key !== key)
      const oldUnknown = sourceRequestBlockers(projectId, [runId, ...completedStoryRuns])
        .some(item => item.run_id !== runId && (item.scope !== scope || item.request_key !== key))
      const independent = !oldUnknown && ordinaryDispatchAllowed()
      if ((storyPart || currentInitialSourceQualityRequest() || currentDerivedSourceCorrectionRequest() ||
        currentDerivedSourceRepairCorrectionRequest() || repairCorrectionGate || requireOrdinary && repairInitialGate) &&
        (oldUnknown || otherPending && !independent || requireOrdinary && !independent ||
          (currentDerivedSourceCorrectionRequest() || currentDerivedSourceRepairCorrectionRequest() || repairCorrectionGate) && !independent)) throw Object.assign(new Error('其他全剧整合子任务仍有待核对请求或专属恢复许可；当前子任务须有独立的新任务授权，不能借用旧请求的许可派发'), {
        statusCode: 409, code: 'source_request_sibling_pending', failure_stage: 'recovery', delivery: 'not_sent', retryable: false,
      })
      return (otherPending || repairInitialGate || repairCorrectionGate) && independent
    }
    if (differsFromPending && storyPart && row?.state === 'completed' && row.delivery === 'completed' && row.result !== null &&
      (row.run_id === runId || completedStoryRuns.has(row.run_id)) && !delivered.has(key)) {
      delivered.add(key)
      return row.result
    }
    // A genuine same-finding protocol upgrade retains its existing strict
    // recovery path. Marked ordinary finding work requires its own grant even
    // without a sibling; unmarked legacy repairs retain their existing path.
    const independentOrdinary = blockSibling(repairCorrectionGate || repairInitialGate &&
      currentInitialSourceRepairRequest()?.ordinary === true && !epoch && !differsFromPending)
    if (differsFromPending && !independentOrdinary) {
      if (options.requestNamespace) sourceRecoveryConflict('本次新授权不能借用、替换或消耗旧请求恢复许可，未派发请求')
      const model = identity && typeof identity === 'object' ? (identity as { model?: unknown }).model : undefined
      if (supersession && args[3]?.name === 'script_source_quality' && model === args[1]) {
        validateSupersededSourceCheckpoint(pendingEpoch, scope, key, [runId, ...completedStoryRuns], supersession)
      } else validateSourceRepairContractUpgrade(pendingEpoch, scope, key, runId, [runId, ...completedStoryRuns], repairUpgrade())
    }
    if (epoch && ['completed', 'settled', 'failed'].includes(epoch.state)) { epoch = nextOrdinarySourceEpoch(epoch, runId); row = epoch }
    if (epoch && epoch.run_id !== runId) {
      const saved = epoch.response_key ? db.prepare('SELECT payload FROM source_model_responses WHERE project_id=? AND scope=? AND response_key=?').get(projectId, scope + ':epoch:' + epoch.id, epoch.response_key) as { payload: string } | undefined : undefined
      let accepted = false
      try { const value = saved && JSON.parse(saved.payload); accepted = value?.state === 'accepted' && /^resp_[a-zA-Z0-9_-]+$/.test(value.id) } catch { /* Cannot infer acceptance. */ }
      const allowed = epoch.state === 'prepared' && !epoch.consumed_at || epoch.state === 'dispatched' && accepted
      if (!allowed || !sourceRecoveryEpochCurrent(epoch)) sourceRecoveryConflict('恢复执行身份已变化，不能重复派发')
      const changed = db.prepare('UPDATE source_request_recovery_epochs SET run_id=? WHERE id=? AND run_id=? AND state=?').run(runId, epoch.id, epoch.run_id, epoch.state)
      if (changed.changes !== 1) sourceRecoveryConflict('恢复执行身份已变化，不能重复派发')
      epoch = { ...epoch, run_id: runId }; row = epoch
    }
    const parent = currentModelRequestContext()
    let backgroundKey = row?.response_key || null, backgroundPending = false
    let ownedRequestId: string | null = null
    const createdBackgrounds = new Map<string, { scope: string; payload: string }>()
    cleanupUnsentBackground = () => {
      for (const [responseKey, own] of createdBackgrounds) {
        const removed = db.prepare('DELETE FROM source_model_responses WHERE project_id=? AND scope=? AND response_key=? AND payload=?')
          .run(projectId, own.scope, responseKey, own.payload)
        if (removed.changes !== 1) sourceRecoveryConflict('本次未发送请求的后台标记已变化，已保留现场停止本地释放')
      }
    }
    const upsert = (state: string, delivery: string, result: string | null = null) => {
      if (epoch) {
        if (!sourceRecoveryEpochCurrent({ ...epoch, run_id: runId })) { recordLateSourceRequest(projectId, scope, key, runId, state, delivery, result, epoch.id); return false }
        const owner = db.prepare('SELECT consumed_at,local_request_id FROM source_request_recovery_epochs WHERE id=?').get(epoch.id) as { consumed_at: string | null; local_request_id: string | null }
        if (owner.consumed_at && owner.local_request_id !== ownedRequestId) { recordLateSourceRequest(projectId, scope, key, runId, state, delivery, result, epoch.id); return false }
        const changed = db.prepare('UPDATE source_request_recovery_epochs SET state=?,delivery=?,result=?,response_key=?,updated_at=? WHERE id=? AND run_id=?')
          .run(state, delivery, result, backgroundKey, now(), epoch.id, runId)
        if (changed.changes !== 1) recordLateSourceRequest(projectId, scope, key, runId, state, delivery, result, epoch.id)
        return changed.changes === 1
      }
      if (frozenSourceRequest(projectId, scope, key)) { recordLateSourceRequest(projectId, scope, key, runId, state, delivery, result); return false }
      db.prepare(`INSERT INTO source_model_requests (project_id,scope,request_key,run_id,state,delivery,result,response_key,updated_at) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(project_id,scope,request_key) DO UPDATE SET run_id=excluded.run_id,state=excluded.state,delivery=excluded.delivery,result=excluded.result,response_key=excluded.response_key,updated_at=excluded.updated_at`)
        .run(projectId, scope, key, runId, state, delivery, result, backgroundKey, now())
      return true
    }
    // Only a background identity for THIS exact request permits re-entry to
    // the provider wrapper; that wrapper then queries, never blindly POSTs.
    const requestRecovery = {
      read(responseKey: string) {
        if (epoch && !sourceRecoveryEpochCurrent({ ...epoch, run_id: runId })) sourceRecoveryConflict('恢复许可已变化，不能沿用原执行查询后台响应')
        const value = epoch ? (() => { const saved = db.prepare('SELECT payload FROM source_model_responses WHERE project_id=? AND scope=? AND response_key=?').get(projectId, scope + ':epoch:' + epoch.id, responseKey) as { payload: string } | undefined; return saved ? JSON.parse(saved.payload) as BackgroundResponse : undefined })() : recovery.read(responseKey)
        if (value) { existingBarrier = true; protectStructuredDispatchIntent(intent) }
        if (value && (!['creating', 'accepted'].includes(value.state) || value.id !== undefined && !/^resp_[a-zA-Z0-9_-]+$/.test(value.id))) sourceRecoveryConflict('原稿分析的上游响应身份损坏，已停止自动派发')
        backgroundPending = !!value
        if (value) backgroundKey = responseKey
        if (row?.state === 'dispatched' && !value) { blockedDispatch = true; throw Object.assign(new Error('上次原稿分析请求的受理结果未知，已保留完成步骤；请先核对提供商记录，不能自动重新生成。'), { statusCode: 409, code: 'source_request_unknown', outcome_certainty: 'unknown' }) }
        if (value?.state === 'accepted' && value.id) {
          if (epoch) ownedRequestId = epoch.local_request_id
          backgroundKey = responseKey
          if (epoch && sourceRecoveryEpochCurrent({ ...epoch, run_id: runId })) db.prepare('UPDATE source_request_recovery_epochs SET response_key=? WHERE id=? AND run_id=?').run(responseKey, epoch.id, runId)
          else if (!frozenSourceRequest(projectId, scope, key)) db.prepare('UPDATE source_model_requests SET response_key=? WHERE project_id=? AND scope=? AND request_key=?').run(responseKey, projectId, scope, key)
        }
        return value
      },
      save(responseKey: string, value?: BackgroundResponse) {
        const responseScope = epoch ? scope + ':epoch:' + epoch.id : scope
        const previous = value?.state === 'creating' ? db.prepare('SELECT payload FROM source_model_responses WHERE project_id=? AND scope=? AND response_key=?')
          .get(projectId, responseScope, responseKey) : undefined
        backgroundPending = !!value
        if (value) backgroundKey = responseKey
        if (epoch) {
          if (!sourceRecoveryEpochCurrent({ ...epoch, run_id: runId })) return
          const responseScope = scope + ':epoch:' + epoch.id
          if (!value) db.prepare('DELETE FROM source_model_responses WHERE project_id=? AND scope=? AND response_key=?').run(projectId, responseScope, responseKey)
          else db.prepare('INSERT INTO source_model_responses (project_id,scope,response_key,payload) VALUES (?,?,?,?) ON CONFLICT(project_id,scope,response_key) DO UPDATE SET payload=excluded.payload').run(projectId, responseScope, responseKey, JSON.stringify(value))
        } else if (!frozenSourceRequest(projectId, scope, key)) recovery.save(responseKey, value)
        if (value?.state === 'accepted' && value.id) {
          existingBarrier = true; protectStructuredDispatchIntent(intent)
          backgroundKey = responseKey
          if (epoch && sourceRecoveryEpochCurrent({ ...epoch, run_id: runId })) db.prepare('UPDATE source_request_recovery_epochs SET response_key=? WHERE id=? AND run_id=?').run(responseKey, epoch.id, runId)
          else if (!frozenSourceRequest(projectId, scope, key)) db.prepare('UPDATE source_model_requests SET response_key=? WHERE project_id=? AND scope=? AND request_key=?').run(responseKey, projectId, scope, key)
        }
        if (value?.state === 'creating' && !previous) createdBackgrounds.set(responseKey, { scope: responseScope, payload: JSON.stringify(value) })
        else if (!value || value.state === 'accepted') createdBackgrounds.delete(responseKey)
      },
    }
    if (!epoch && (!row || row.state !== 'dispatched')) upsert('prepared', 'not_sent')
    let enteredRecovery = false, blockedDispatch = false
    const scopedRecovery = { ...requestRecovery, read(key: string) { enteredRecovery = true; return requestRecovery.read(key) } }
    const upgradingRepair = !!differsFromPending && !independentOrdinary && !(supersession && args[3]?.name === 'script_source_quality')
    enteredProvider = true
    return await withTextResponseRecovery(scopedRecovery, () => withModelRequestContext({ ...parent, policy: parent?.policy || modelTaskPolicies.generation,
      onDispatch: value => {
        const metric = value && typeof value === 'object' ? value as Record<string, unknown> : {}
        if (metric.kind !== 'transport') {
          try {
            db.transaction(() => {
              blockSibling(independentOrdinary)
              // This callback must finish synchronously before the provider
              // can POST. A rejection rolls back this attempt's journal and
              // permit consumption together, without settling another owner.
              if (row?.state === 'dispatched' && !enteredRecovery) throw Object.assign(new Error('上次原稿分析请求的受理结果未知，不能自动重新生成。'), { statusCode: 409, code: 'source_request_unknown', outcome_certainty: 'unknown' })
              const live = epoch ? undefined : db.prepare('SELECT state,delivery FROM source_model_requests WHERE project_id=? AND scope=? AND request_key=?').get(projectId, scope, key) as { state: string; delivery: string } | undefined
              if (live?.state === 'dispatched' && !(dispatched && ['not_sent', 'rejected'].includes(delivery))) {
                existingBarrier = true; protectStructuredDispatchIntent(intent)
                sourceRecoveryConflict('同一请求已有派发身份，不能由另一次尝试覆盖')
              }
              if (!epoch && frozenSourceRequest(projectId, scope, key)) sourceRecoveryConflict('原请求已冻结；当前执行没有新的恢复许可')
              if (epoch) recordSourceDispatch(projectId, scope, key, runId, now(), metric.request_id, epoch.id)
              else {
                if (upgradingRepair && pendingEpoch) supersedeSourceRepairContract(pendingEpoch, scope, key, runId, [runId, ...completedStoryRuns], metric.request_id, repairUpgrade())
                else if (!independentOrdinary && supersession && pendingEpoch) supersedeSourceCheckpoint(pendingEpoch, scope, key, runId, [runId, ...completedStoryRuns], metric.request_id, supersession)
                if (!upsert('dispatched', 'unknown')) sourceRecoveryConflict('当前请求的派发身份已变化，已停止请求')
                const stamp = (db.prepare('SELECT updated_at FROM source_model_requests WHERE project_id=? AND scope=? AND request_key=?').get(projectId, scope, key) as { updated_at: string }).updated_at
                recordSourceDispatch(projectId, scope, key, runId, stamp, metric.request_id)
              }
              parent?.onDispatch?.(value)
              recordSourceModelAdmission(projectId, runId, scope, key, intent, 'dispatched')
              if (options.requestNamespace) {
                if (typeof metric.request_id !== 'string' || !metric.request_id) sourceRecoveryConflict('受控恢复请求缺少精确派发身份')
                options.onControlledDispatch!({ scope, request_key: key, base_request_key: baseKey,
                  local_request_id: metric.request_id, contract_name: args[3]?.name, intent })
              }
            }).immediate()
          } catch (issue) {
            blockedDispatch = true; dispatchDenied = true
            throw issue
          }
          // Never claim a possible send until every synchronous admission
          // observer and durable journal has completed successfully.
          completedDispatch = true; dispatched = true; delivery = 'unknown'; protectStructuredDispatchIntent(intent)
          if (epoch) ownedRequestId = String(metric.request_id)
        }
        else parent?.onDispatch?.(value)
      },
      onMetrics: value => {
        const metric = value && typeof value === 'object' ? value as Record<string, unknown> : {}
        if (metric.kind !== 'transport') recordSourceUpstream(metric.request_id, metric.upstream_request_id, epoch?.id)
        if (!blockedDispatch && metric.kind !== 'transport' && typeof metric.delivery === 'string') delivery = metric.delivery
        parent?.onMetrics?.(value)
      },
    }, async () => {
      let result: string
      try { result = await generate(...args) } catch (issue) {
        const terminated = !args[4].aborted && !blockedDispatch && parent?.policy.readOnly !== false &&
          !['tool', 'paid'].includes(parent?.policy.recovery || '') && isSourceAnalysisContract(args[3]?.name) &&
          issue instanceof TextProviderError && issue.retryable && issue.responseTerminated
        if (backgroundPending && dispatched && !blockedDispatch) upsert('dispatched', delivery === 'completed' ? 'accepted' : delivery)
        else if (terminated) upsert('failed', delivery)
        else if (!blockedDispatch && (!dispatched || delivery === 'not_sent' || delivery === 'rejected' || delivery === 'completed')) upsert('settled', delivery)
        // Unknown/accepted dispatch identity remains durable across automatic
        // startup recovery and an explicit retry with a new analyzer run ID.
        throw issue
      }
      // Completion persistence is outside the provider-failure catch. A failed
      // write must preserve the dispatch barrier even if upstream completed.
      if (!upsert('completed', 'completed', result)) sourceRecoveryConflict('原执行结果晚于新的恢复决定，已隔离保存而未采用')
      delivered.add(key)
      args[4].throwIfAborted()
      return result
    }))
    } catch (issue) {
      // Only these code-owned synchronous windows prove this exact attempt
      // could not reach the provider. Existing accepted/unknown work and any
      // post-response failure retain their original durable barrier.
      if (!existingBarrier && !completedDispatch && (!enteredProvider || dispatchDenied)) {
        const denied = db.transaction(() => {
          cleanupUnsentBackground?.()
          return sourceModelAdmissionDenied(projectId, runId, scope, key, intent,
            dispatchDenied ? 'source_dispatch_journal' : 'source_admission_gate', issue)
        }).immediate()
        throw denied
      }
      throw issue
    }
  }
  // Probe legacy complete part replies without touching their execution identity.
  // All business validation happens again at the caller before any adoption.
  wrapped.readCompleted = async (...args) => {
    args[4].throwIfAborted()
    const boundary = args[3]?.name === 'script_source_map_boundary_repair'
    if (!boundary && !['script_source_story', 'script_source_story_structure_repair', 'script_source_story_local_repair'].includes(args[3]?.name || '') &&
      !/^script_source_story_(overview|characters|characters_merge|timeline|threads|uncertainties)(?:_(?:structure|local)_repair)?$/.test(args[3]?.name || '')) return
    const key = ledgerKey(digest([args[1], args[2], args[3]]), options.requestNamespace)
    const baseRow = db.prepare('SELECT state,run_id,result,delivery,response_key FROM source_model_requests WHERE project_id=? AND scope=? AND request_key=?').get(projectId, scope, key) as RequestRow | undefined
    let epoch = latestSourceRecoveryEpoch(projectId, scope, key, [runId, ...completedStoryRuns])
    const row = epoch ?? baseRow
    if (!row || row.run_id !== runId && (boundary || !completedStoryRuns.has(row.run_id))) return
    if (row.state === 'dispatched') throw Object.assign(new Error('上次原稿分析请求的受理结果未知，不能自动重新生成。'), { statusCode: 409, code: 'source_request_unknown', outcome_certainty: 'unknown' })
    if (row.state === 'completed' && row.delivery === 'completed' && row.result !== null) return row.result
  }
  return wrapped
}
