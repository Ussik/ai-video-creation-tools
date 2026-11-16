import { createHash, randomUUID } from 'node:crypto'
import { canonicalAiValue } from '@video-studio/shared/api/ai-operations'
import { db, now } from '../../infrastructure/database/db.js'
import { sourceRepairReferencePolicy, type SourceRepairContractUpgrade, type SourceRepairUpgradeBinding } from './source-repair-request-identity.js'

export type SourceRequestRow = { state: string; run_id: string; result: string | null; delivery: string; response_key?: string | null; updated_at: string }
export type SourceRequestBlocker = SourceRequestRow & { id: string; scope: string; request_key: string; epoch_id: string | null; local_request_id: string | null; upstream_request_id: string | null; identity_binding: 'native' | 'unbound' }
export type SupersededSourceCheckpoint = { analysisBinding: string; reason: 'stale_quality_checkpoint'; checkpointHash: string; currentCheckpointHash: string }
export type SourceRecoveryEpoch = SourceRequestRow & { id: string; action_id: string; project_id: string; scope: string; request_key: string; consumed_at: string | null; local_request_id: string | null; upstream_request_id: string | null }
const exists = (table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
export const sourceRecoveryDigest = (value: unknown) => createHash('sha256').update(canonicalAiValue(value)).digest('hex')
export function sourceRecoveryConflict(message: string): never { throw Object.assign(new Error(message), { statusCode: 409, code: 'source_request_recovery_conflict' }) }

export function initSourceRequestRecovery() {
  db.exec(`CREATE TABLE IF NOT EXISTS source_request_recovery_actions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    client_action_id TEXT NOT NULL, request_digest TEXT NOT NULL, original_digest TEXT NOT NULL,
    original_snapshot TEXT NOT NULL, analysis_binding TEXT NOT NULL, target_run_id TEXT NOT NULL,
    decision TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(project_id,client_action_id), UNIQUE(project_id,original_digest));
    CREATE TABLE IF NOT EXISTS source_request_recovery_epochs (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,action_id TEXT NOT NULL REFERENCES source_request_recovery_actions(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,scope TEXT NOT NULL,request_key TEXT NOT NULL,
    run_id TEXT NOT NULL,state TEXT NOT NULL,delivery TEXT NOT NULL,result TEXT,response_key TEXT,updated_at TEXT NOT NULL,
    consumed_at TEXT,local_request_id TEXT,upstream_request_id TEXT);
    CREATE TABLE IF NOT EXISTS source_request_dispatch_links (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,scope TEXT NOT NULL,request_key TEXT NOT NULL,
    run_id TEXT NOT NULL,source_updated_at TEXT NOT NULL,local_request_id TEXT PRIMARY KEY,upstream_request_id TEXT);
    CREATE TABLE IF NOT EXISTS source_request_late_events (
    id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,request_key TEXT NOT NULL,run_id TEXT NOT NULL,epoch_id TEXT,state TEXT NOT NULL,
    delivery TEXT NOT NULL,result TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_request_recovery_resolutions (
    id TEXT PRIMARY KEY,epoch_id TEXT NOT NULL UNIQUE,action_id TEXT NOT NULL REFERENCES source_request_recovery_actions(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,old_scope TEXT NOT NULL,old_request_key TEXT NOT NULL,
    new_scope TEXT NOT NULL,new_request_key TEXT NOT NULL,new_run_id TEXT NOT NULL,new_local_request_id TEXT NOT NULL,
    reason TEXT NOT NULL,checkpoint_hash TEXT NOT NULL,current_checkpoint_hash TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_request_local_recoveries (
    id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    client_action_id TEXT NOT NULL,request_digest TEXT NOT NULL,analysis_binding TEXT NOT NULL,analysis_id TEXT NOT NULL,
    before_snapshot TEXT NOT NULL,after_snapshot TEXT NOT NULL,facts TEXT NOT NULL,created_at TEXT NOT NULL,
    UNIQUE(project_id,client_action_id));
    CREATE TABLE IF NOT EXISTS source_request_recovery_workflows (
    id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    client_action_id TEXT NOT NULL,request_digest TEXT NOT NULL,analysis_binding TEXT NOT NULL,
    analysis_id TEXT NOT NULL,target_run_id TEXT,phase TEXT NOT NULL,before_snapshot TEXT NOT NULL,
    local_action_id TEXT,local_snapshot TEXT,scope TEXT,scope_token TEXT,authorization_id TEXT,
    authorization_snapshot TEXT,result TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    UNIQUE(project_id,client_action_id));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_source_recovery_workflow_active ON source_request_recovery_workflows(project_id,analysis_id)
      WHERE phase IN ('inspect','reconcile','local_replay','awaiting_risk','queued');
    CREATE INDEX IF NOT EXISTS idx_source_recovery_epoch_request ON source_request_recovery_epochs(project_id,scope,request_key,sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_source_recovery_dispatch_request ON source_request_dispatch_links(project_id,scope,request_key,run_id,source_updated_at);`)
}
export function latestSourceRecoveryEpoch(projectId: string, scope: string, key: string, runs: string[]): SourceRecoveryEpoch | undefined {
  if (!exists('source_request_recovery_epochs')) return
  const row = db.prepare('SELECT * FROM source_request_recovery_epochs WHERE project_id=? AND scope=? AND request_key=? ORDER BY sequence DESC LIMIT 1').get(projectId, scope, key) as SourceRecoveryEpoch | undefined
  return row && runs.includes(row.run_id) ? row : undefined
}
export function pendingSourceRecoveryEpochs(projectId: string, runs: string[]): SourceRecoveryEpoch[] {
  if (!exists('source_request_recovery_epochs')) return []
  const rows = db.prepare("SELECT * FROM source_request_recovery_epochs WHERE project_id=? AND state='prepared' AND consumed_at IS NULL ORDER BY sequence DESC").all(projectId) as SourceRecoveryEpoch[]
  return rows.filter(row => runs.includes(row.run_id) && sourceRecoveryEpochCurrent(row))
}
export function pendingSourceRecoveryEpoch(projectId: string, runs: string[]): SourceRecoveryEpoch | undefined {
  return pendingSourceRecoveryEpochs(projectId, runs)[0]
}
export function frozenSourceRequest(projectId: string, scope: string, key: string): boolean {
  return exists('source_request_recovery_epochs') && !!db.prepare('SELECT 1 FROM source_request_recovery_epochs WHERE project_id=? AND scope=? AND request_key=?').get(projectId, scope, key)
}
export function sourceRequestBlockers(projectId: string, runIds: string[]): SourceRequestBlocker[] {
  if (!exists('source_model_requests')) return []
  const runs = [...new Set(runIds)].filter(Boolean)
  const original = (db.prepare("SELECT * FROM source_model_requests WHERE project_id=? AND state='dispatched'").all(projectId) as Array<SourceRequestRow & { scope: string; request_key: string }>).filter(row => runs.includes(row.run_id) || !!latestSourceRecoveryEpoch(projectId, row.scope, row.request_key, runs))
  const result: SourceRequestBlocker[] = []
  for (const base of original) {
    const epoch = latestSourceRecoveryEpoch(projectId, base.scope, base.request_key, runs)
    const row = epoch ?? base
    if (epoch && epoch.state !== 'dispatched') continue
    // A native accepted Responses identity retains the existing exact GET path.
    const responseScope = epoch ? base.scope + ':epoch:' + epoch.id : base.scope
    const responses = row.response_key ? db.prepare('SELECT payload FROM source_model_responses WHERE project_id=? AND scope=? AND response_key=?').all(projectId, responseScope, row.response_key)
      : db.prepare('SELECT payload FROM source_model_responses WHERE project_id=? AND scope=?').all(projectId, responseScope)
    if ((responses as Array<{ payload: string }>).some(item => { try { const value = JSON.parse(item.payload); return value.state === 'accepted' && typeof value.id === 'string' && /^resp_[a-zA-Z0-9_-]+$/.test(value.id) } catch { return false } })) continue
    const links = !epoch && exists('source_request_dispatch_links') ? db.prepare('SELECT local_request_id,upstream_request_id FROM source_request_dispatch_links WHERE project_id=? AND scope=? AND request_key=? AND run_id=? AND source_updated_at=?').all(projectId, base.scope, base.request_key, base.run_id, base.updated_at) as Array<{ local_request_id: string; upstream_request_id: string | null }> : []
    const link = epoch?.local_request_id ? epoch : links.length === 1 ? links[0] : undefined
    const entry = { ...row, scope: base.scope, request_key: base.request_key, epoch_id: epoch?.id ?? null,
      local_request_id: link?.local_request_id ?? null, upstream_request_id: link?.upstream_request_id ?? null,
      identity_binding: link ? 'native' as const : 'unbound' as const }
    result.push({ ...entry, id: sourceRecoveryDigest(entry) })
  }
  return result.sort((a, b) => a.id.localeCompare(b.id))
}
export function recordSourceDispatch(projectId: string, scope: string, key: string, runId: string, stamp: string, requestId: unknown, epochId?: string) {
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(requestId)) {
    if (epochId) sourceRecoveryConflict('模型派发缺少精确请求身份，已停止请求')
    return
  }
  if (epochId) {
    const current = db.prepare('SELECT * FROM source_request_recovery_epochs WHERE id=?').get(epochId) as SourceRecoveryEpoch | undefined
    if (!current || !sourceRecoveryEpochCurrent(current)) sourceRecoveryConflict('恢复执行身份已变化，不能重复派发')
    const changed = db.prepare("UPDATE source_request_recovery_epochs SET state='dispatched',delivery='unknown',consumed_at=?,local_request_id=?,updated_at=? WHERE id=? AND run_id=? AND state='prepared' AND consumed_at IS NULL")
      .run(stamp, requestId, stamp, epochId, runId)
    if (changed.changes !== 1) sourceRecoveryConflict('本次恢复许可已使用或执行身份已变化，不能重复派发')
  } else db.prepare('INSERT INTO source_request_dispatch_links (project_id,scope,request_key,run_id,source_updated_at,local_request_id) VALUES (?,?,?,?,?,?)').run(projectId, scope, key, runId, stamp, requestId)
}
export function recordSourceUpstream(requestId: unknown, upstreamId: unknown, epochId?: string) {
  if (typeof requestId !== 'string' || typeof upstreamId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(upstreamId)) return
  if (epochId) {
    const current = db.prepare('SELECT * FROM source_request_recovery_epochs WHERE id=?').get(epochId) as SourceRecoveryEpoch | undefined
    if (!current || !sourceRecoveryEpochCurrent(current)) return
    db.prepare('UPDATE source_request_recovery_epochs SET upstream_request_id=COALESCE(upstream_request_id,?) WHERE id=? AND local_request_id=?').run(upstreamId, epochId, requestId)
  } else db.prepare(`UPDATE source_request_dispatch_links SET upstream_request_id=COALESCE(upstream_request_id,?) WHERE local_request_id=? AND NOT EXISTS (SELECT 1 FROM source_request_recovery_epochs e WHERE e.project_id=source_request_dispatch_links.project_id AND e.scope=source_request_dispatch_links.scope AND e.request_key=source_request_dispatch_links.request_key)`).run(upstreamId, requestId)
}
export function recordLateSourceRequest(projectId: string, scope: string, key: string, runId: string, state: string, delivery: string, result: string | null, epochId?: string) {
  db.prepare('INSERT INTO source_request_late_events (id,project_id,scope,request_key,run_id,epoch_id,state,delivery,result,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), projectId, scope, key, runId, epochId ?? null, state, delivery, result, now())
}

export function sourceRecoveryEpochCurrent(epoch: SourceRecoveryEpoch): boolean {
  const latest = db.prepare('SELECT id,run_id,state FROM source_request_recovery_epochs WHERE project_id=? AND scope=? AND request_key=? ORDER BY sequence DESC LIMIT 1').get(epoch.project_id, epoch.scope, epoch.request_key) as { id: string; run_id: string; state: string } | undefined
  return latest?.id === epoch.id && latest.run_id === epoch.run_id && latest.state !== 'superseded'
}
/** A complete or explicitly settled replacement releases only ordinary,
 * already-safe work. An unknown replacement always needs another decision. */
export function nextOrdinarySourceEpoch(previous: SourceRecoveryEpoch, runId: string): SourceRecoveryEpoch {
  return db.transaction(() => {
    if (!sourceRecoveryEpochCurrent(previous) || !['completed', 'settled', 'failed'].includes(previous.state)) sourceRecoveryConflict('请求执行身份已变化，不能重新派发')
    const id = randomUUID(), stamp = now()
    db.prepare("INSERT INTO source_request_recovery_epochs (id,action_id,project_id,scope,request_key,run_id,state,delivery,updated_at) VALUES (?,?,?,?,?,?,'prepared','not_sent',?)").run(id, previous.action_id, previous.project_id, previous.scope, previous.request_key, runId, stamp)
    return db.prepare('SELECT * FROM source_request_recovery_epochs WHERE id=?').get(id) as SourceRecoveryEpoch
  }).immediate()
}

/** A creator's earlier abandonment may outlive the checkpoint that originally
 * scheduled the unknown request. Retiring that unused permit never transfers
 * it to the fresh audit and never changes the original remote-outcome facts. */
export function validateSupersededSourceCheckpoint(epoch: SourceRecoveryEpoch, scope: string, key: string, runs: string[], checkpoint: SupersededSourceCheckpoint) {
  if (epoch.scope !== scope || epoch.request_key === key || epoch.state !== 'prepared' || epoch.consumed_at ||
    !sourceRecoveryEpochCurrent(epoch) || checkpoint.reason !== 'stale_quality_checkpoint' ||
    ![checkpoint.analysisBinding, checkpoint.checkpointHash, checkpoint.currentCheckpointHash].every(value => /^[a-f0-9]{64}$/.test(value)) ||
    checkpoint.checkpointHash === checkpoint.currentCheckpointHash) sourceRecoveryConflict('待恢复请求与当前检查点不匹配，不能使用原许可')
  const action = db.prepare('SELECT decision,analysis_binding,target_run_id FROM source_request_recovery_actions WHERE id=? AND project_id=?').get(epoch.action_id, epoch.project_id) as
    { decision: string; analysis_binding: string; target_run_id: string } | undefined
  if (!action || action.decision !== 'abandon_and_resume' || action.analysis_binding !== checkpoint.analysisBinding || !runs.includes(action.target_run_id)) sourceRecoveryConflict('原放弃决定对应的原稿、模型或反馈已变化，请重新核对')
  const original = db.prepare('SELECT response_key FROM source_model_requests WHERE project_id=? AND scope=? AND request_key=?').get(epoch.project_id, epoch.scope, epoch.request_key) as { response_key: string | null } | undefined
  if (!original || original.response_key || epoch.response_key || sourceRequestBlockers(epoch.project_id, runs).length) sourceRecoveryConflict('当前存在其他未知请求或后台响应身份，不能替代原恢复步骤')
}
export function supersedeSourceCheckpoint(epoch: SourceRecoveryEpoch, scope: string, key: string, runId: string, runs: string[], requestId: unknown, checkpoint: SupersededSourceCheckpoint) {
  validateSupersededSourceCheckpoint(epoch, scope, key, runs, checkpoint)
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(requestId)) sourceRecoveryConflict('新独立核对缺少精确请求身份，已停止派发')
  const stamp = now()
  const changed = db.prepare("UPDATE source_request_recovery_epochs SET state='superseded',updated_at=? WHERE id=? AND run_id=? AND state='prepared' AND consumed_at IS NULL").run(stamp, epoch.id, epoch.run_id)
  if (changed.changes !== 1) sourceRecoveryConflict('原恢复许可已变化，不能重复处理')
  db.prepare(`INSERT INTO source_request_recovery_resolutions (id,epoch_id,action_id,project_id,old_scope,old_request_key,new_scope,new_request_key,new_run_id,new_local_request_id,reason,checkpoint_hash,current_checkpoint_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), epoch.id, epoch.action_id, epoch.project_id, epoch.scope, epoch.request_key,
      scope, key, runId, requestId, checkpoint.reason, checkpoint.checkpointHash, checkpoint.currentCheckpointHash, stamp)
}

/** Do not let a moved/consumed epoch disappear from this action's producer
 * check merely because it no longer appears in the captured run lineage. */
export function unsettledSourceRepairUpgradeEpoch(projectId: string, targetRunId: string): SourceRecoveryEpoch | undefined {
  return db.prepare(`SELECT e.* FROM source_request_recovery_epochs e JOIN source_request_recovery_actions a ON a.id=e.action_id
    WHERE e.project_id=? AND a.target_run_id=? AND e.state IN ('prepared','dispatched') ORDER BY e.sequence DESC LIMIT 1`)
    .get(projectId, targetRunId) as SourceRecoveryEpoch | undefined
}

/** Retire only an unused, newly admitted repair permit when the producer has
 * upgraded its wire contract for the exact same saved finding. This records a
 * new ordinary request; it does not relabel or transfer the unknown outcome. */
export function validateSourceRepairContractUpgrade(epoch: SourceRecoveryEpoch, scope: string, key: string, runId: string,
  runs: string[], upgrade: SourceRepairContractUpgrade) {
  const binding = upgrade.binding
  if (epoch.scope !== scope || epoch.request_key === key || epoch.run_id !== runId || epoch.state !== 'prepared' ||
    epoch.delivery !== 'not_sent' || epoch.consumed_at || epoch.local_request_id || epoch.response_key || !sourceRecoveryEpochCurrent(epoch) ||
    binding.policy !== sourceRepairReferencePolicy || !Number.isSafeInteger(binding.finding_index) || binding.finding_index < 0 ||
    ![upgrade.analysisBinding, binding.checkpoint_hash, binding.finding_hash, binding.review_hash, binding.findings_hash, binding.current_hash]
      .every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) sourceRecoveryConflict('修补协议升级与当前检查点不匹配，不能使用原许可')
  const action = db.prepare('SELECT * FROM source_request_recovery_actions WHERE project_id=? ORDER BY rowid DESC LIMIT 1')
    .get(epoch.project_id) as { id: string; decision: string; analysis_binding: string; target_run_id: string; original_snapshot: string; original_digest: string } | undefined
  if (!action || action.id !== epoch.action_id || action.decision !== 'abandon_and_resume' ||
    action.analysis_binding !== upgrade.analysisBinding || action.target_run_id !== runId || !runs.includes(action.target_run_id)) {
    sourceRecoveryConflict('修补协议升级对应的最新人工决定或执行身份已变化，请重新核对')
  }
  let snapshot: { original?: SourceRequestRow; original_epoch?: SourceRecoveryEpoch; blocker?: SourceRequestBlocker; repair_contract_upgrade?: SourceRepairUpgradeBinding }
  try { snapshot = JSON.parse(action.original_snapshot) } catch { sourceRecoveryConflict('原恢复决定缺少可验证的修补检查点，不能升级协议') }
  if (!snapshot?.repair_contract_upgrade || sourceRecoveryDigest(snapshot.repair_contract_upgrade) !== sourceRecoveryDigest(binding) ||
    snapshot.blocker?.id !== action.original_digest || snapshot.blocker.scope !== epoch.scope || snapshot.blocker.request_key !== epoch.request_key ||
    snapshot.blocker.state !== 'dispatched' || snapshot.blocker.result !== null || snapshot.blocker.response_key ||
    !['unknown', 'accepted', 'output_started'].includes(snapshot.blocker.delivery)) {
    sourceRecoveryConflict('原恢复决定未绑定相同的核对意见、修补进度和协议，不能升级请求')
  }
  if (snapshot.blocker.epoch_id) {
    const previous = db.prepare('SELECT * FROM source_request_recovery_epochs WHERE id=? AND project_id=?')
      .get(snapshot.blocker.epoch_id, epoch.project_id) as SourceRecoveryEpoch | undefined
    if (!previous || !snapshot.original_epoch || previous.id === epoch.id || previous.scope !== epoch.scope || previous.request_key !== epoch.request_key ||
      previous.state !== 'dispatched' || previous.result !== null || previous.response_key ||
      sourceRecoveryDigest(previous) !== sourceRecoveryDigest(snapshot.original_epoch)) {
      sourceRecoveryConflict('原未知恢复请求或后台身份已变化，不能升级修补协议')
    }
  }
  const original = db.prepare('SELECT * FROM source_model_requests WHERE project_id=? AND scope=? AND request_key=?')
    .get(epoch.project_id, epoch.scope, epoch.request_key) as SourceRequestRow | undefined
  if (!original || original.state !== 'dispatched' || original.result !== null || original.response_key ||
    sourceRecoveryDigest(original) !== sourceRecoveryDigest(snapshot.original) || sourceRequestBlockers(epoch.project_id, runs).length) {
    sourceRecoveryConflict('原未知请求或后台响应身份已变化，不能升级修补协议')
  }
}
export function supersedeSourceRepairContract(epoch: SourceRecoveryEpoch, scope: string, key: string, runId: string,
  runs: string[], requestId: unknown, upgrade: SourceRepairContractUpgrade) {
  validateSourceRepairContractUpgrade(epoch, scope, key, runId, runs, upgrade)
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(requestId)) sourceRecoveryConflict('新定点修补缺少精确请求身份，已停止派发')
  const stamp = now()
  const changed = db.prepare("UPDATE source_request_recovery_epochs SET state='superseded',updated_at=? WHERE id=? AND run_id=? AND state='prepared' AND consumed_at IS NULL")
    .run(stamp, epoch.id, runId)
  if (changed.changes !== 1) sourceRecoveryConflict('原恢复许可已变化，不能重复处理')
  db.prepare(`INSERT INTO source_request_recovery_resolutions (id,epoch_id,action_id,project_id,old_scope,old_request_key,new_scope,new_request_key,new_run_id,new_local_request_id,reason,checkpoint_hash,current_checkpoint_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'repair_contract_upgrade',?,?,?)`).run(randomUUID(), epoch.id, epoch.action_id, epoch.project_id, epoch.scope,
      epoch.request_key, scope, key, runId, requestId, upgrade.binding.checkpoint_hash, upgrade.binding.checkpoint_hash, stamp)
}
