import { createScriptRequestUsage, withTextRequestUsage, type ScriptRequestUsage, type ScriptRequestUsageLimits } from '../../infrastructure/providers/text-request-usage.js'
import { now, one, run } from '../../infrastructure/database/db.js'
import { originalScriptSource, scriptDocumentVersion } from './script-source-versions.js'

const namespace = 'source-proposal-usage'
type Ledger = { version: 1; scopes: Record<string, ScriptRequestUsage> }
function configuredLimit(name: string, fallback: number) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`)
  return value
}
function readLedger(projectId: string, uploadVersion: string): Ledger {
  const row = one<{ payload: string }>('SELECT payload FROM script_step_checkpoints WHERE project_id=? AND namespace=? AND cache_key=?', projectId, namespace, uploadVersion)
  if (!row) return { version: 1, scopes: {} }
  const saved = JSON.parse(row.payload) as Ledger
  if (saved.version !== 1 || !saved.scopes || typeof saved.scopes !== 'object' || Array.isArray(saved.scopes) || Object.keys(saved.scopes).length > 1000) {
    throw new Error('剧本分析用量检查点无效，不能自动重置累计预算')
  }
  return saved
}
export function scriptProposalBudgetScope(draft: { stage: string; scope: string; episode_number: number }) {
  return JSON.stringify([draft.stage, draft.scope, draft.episode_number])
}

/** One stage of one upload retains its budget across revised candidates,
 * transport recovery and creator continuations. Formal source saves do not
 * grant a new budget; replacing/removing the upload clears this private ledger. */
export function sourceProposalBudget(projectId: string, scope: string, onUpdate?: (usage: ScriptRequestUsage) => void) {
  const source = originalScriptSource(projectId)
  if (!source) throw new Error('原始剧本来源已移除，不能继续候选稿分析')
  const uploadVersion = scriptDocumentVersion(source)
  const ledger = readLedger(projectId, uploadVersion)
  const limits: ScriptRequestUsageLimits = {
    max_requests: configuredLimit('VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS', 120),
    max_tokens: configuredLimit('VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_TOKENS', 3_000_000), unknown_output_tokens: 4096,
  }
  const usage = Object.hasOwn(ledger.scopes, scope) ? ledger.scopes[scope]! : createScriptRequestUsage()
  const save = () => {
    const current = originalScriptSource(projectId)
    if (!current || scriptDocumentVersion(current) !== uploadVersion) throw new Error('原始剧本来源已变化，已停止旧候选稿的模型请求')
    const latest = readLedger(projectId, uploadVersion)
    latest.scopes[scope] = usage
    run('INSERT INTO script_step_checkpoints (project_id,namespace,cache_key,payload,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(project_id,namespace) DO UPDATE SET cache_key=excluded.cache_key,payload=excluded.payload,updated_at=excluded.updated_at',
      projectId, namespace, uploadVersion, JSON.stringify(latest), now())
    onUpdate?.(usage)
  }
  // Validate restored counters before they reach public progress or dispatch.
  withTextRequestUsage({ usage, limits }, () => {})
  return { limits, usage,
    run<T>(work: () => T): T { return withTextRequestUsage({ usage, limits, onUpdate: save }, work) },
  }
}
