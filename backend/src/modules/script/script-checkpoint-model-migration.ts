import { z } from 'zod'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { GenerationCheckpoint } from './script-generation-steps.js'
import { scriptWorkPlan, legacyScriptWorkPlan } from './script-task-execution.js'
import { workflowGenerationDraftSchema, workflowRequest } from './script-workflow.js'

/** Runtime identities contain configuration only, never credentials, provider
 * response IDs, opaque reasoning or execution history. */
export type ScriptCheckpointRuntime = {
  model: { id: string; remote_id: string; protocol: string; settings: string }
  provider: { id: string; adapter: string; base_url: string; auth_header: string; auth_prefix: string }
}
export type ScriptCheckpointModelMigration = {
  from: ScriptCheckpointRuntime; to: ScriptCheckpointRuntime; sourceVersion: string | null
}
const migrations = new AsyncLocalStorage<ScriptCheckpointModelMigration>()
export function currentScriptCheckpointModelMigration() { return migrations.getStore() }
export function withScriptCheckpointModelMigration<T>(migration: ScriptCheckpointModelMigration, work: () => T): T {
  if (migration.from.model.id === migration.to.model.id && JSON.stringify(migration.from) === JSON.stringify(migration.to)) {
    throw Object.assign(new Error('请选择不同的模型配置后继续'), { statusCode: 409 })
  }
  return migrations.run(structuredClone(migration), work)
}
const fail = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 409 }) }
const checkpointSchema = z.object({ prompt: z.string().optional(), steps: z.record(z.string(), z.object({
  input_hash: z.string(), value: z.unknown(), duration_ms: z.number().nonnegative().optional(),
}).strict()) }).strict()

/** Older requests appended the default intent after serializing the other
 * workflow fields. Accept that exact historical identity only when replacing
 * its task_scope key order makes the complete prompt byte-for-byte identical.
 * The caller must still verify the reconstructed full identity hash. */
export function legacyScriptCheckpointIdentity(identity: unknown, checkpoint: GenerationCheckpoint): unknown | undefined {
  if (!identity || typeof identity !== 'object' || !('workflow' in identity) || !('prompt' in identity) || typeof identity.prompt !== 'string' || !checkpoint.prompt) return
  const request = workflowRequest.safeParse(identity.workflow)
  if (!request.success) return
  for (const match of checkpoint.prompt.matchAll(/\{"task_scope":(\{[^{}]*\}),/gu)) {
    let original: unknown
    try { original = JSON.parse(match[1]!) } catch { continue }
    const parsed = workflowRequest.safeParse(original)
    if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(request.data)) continue
    const start = match.index! + '{"task_scope":'.length
    const normalized = checkpoint.prompt.slice(0, start) + JSON.stringify(identity.workflow) + checkpoint.prompt.slice(start + match[1]!.length)
    if (normalized === identity.prompt) return { ...identity, prompt: checkpoint.prompt, workflow: original }
  }
}

const allowedSceneKeys = new Set(['source_scene_id', 'heading', 'location', 'time_of_day', 'characters', 'action', 'dialogue', 'narration', 'duration'])
const allowedDraftKeys = new Set(['stage', 'scope', 'episode_number', 'operation', 'target_duration', 'intent', 'artifact_types', 'artifacts', 'scenes'])

/** A deliberate switch carries business results only. Revalidation is repeated
 * by ordinary step execution and final business validation under the new model. */
export function migrateCompleteScriptDrafts(input: unknown, identity: unknown, sourceVersion: string | null): GenerationCheckpoint {
  const parsedCheckpoint = checkpointSchema.safeParse(input)
  if (!parsedCheckpoint.success) return fail('原任务检查点已损坏，不能迁移；已有任务和正式文档均未修改')
  const checkpoint = parsedCheckpoint.data as GenerationCheckpoint
  if (!identity || typeof identity !== 'object' || !('workflow' in identity)) return fail('此任务没有可迁移的剧本成果合同，请检查草稿后重新发起')
  const request = workflowRequest.safeParse((identity as { workflow: unknown }).workflow)
  if (!request.success) return fail('原任务合同无法验证，不能换模型续用旧成果')
  const binding = checkpoint.steps['progress:source']?.value as { source_version?: unknown } | undefined
  if (!binding || binding.source_version !== sourceVersion) return fail('已保留成果的来源无法与当前资料一致核对，不能迁移')
  const contracts = new Map<string, typeof request.data>([['draft', request.data], ['draft:whole', request.data]])
  for (const task of [...scriptWorkPlan(request.data), ...legacyScriptWorkPlan(request.data)]) {
    const contract = { ...request.data, artifact_types: task.artifact_types }
    contracts.set(`work:${task.id}/draft`, contract)
    contracts.set(`work:document:${task.id}/draft`, contract)
  }
  const steps: GenerationCheckpoint['steps'] = {}
  for (const [id, entry] of Object.entries(checkpoint.steps)) {
    const contract = contracts.get(id)
    if (!contract || !entry.value || typeof entry.value !== 'object' || Array.isArray(entry.value)) continue
    const value = entry.value as Record<string, unknown>
    if (Object.keys(value).some(key => !allowedDraftKeys.has(key))) continue
    if (Array.isArray(value.scenes) && value.scenes.some(scene => !scene || typeof scene !== 'object' || Object.keys(scene).some(key => !allowedSceneKeys.has(key)))) continue
    // Embedded contracts may not silently override the exact request contract.
    if (Object.entries(contract).some(([key, expected]) => key in value && JSON.stringify(value[key]) !== JSON.stringify(expected))) continue
    if (!workflowGenerationDraftSchema.safeParse({ ...contract, ...value }).success) continue
    if (!/^[a-f0-9]{64}$/.test(entry.input_hash) || entry.duration_ms !== undefined && (!Number.isFinite(entry.duration_ms) || entry.duration_ms < 0)) continue
    steps[id] = structuredClone(entry)
  }
  if (!Object.keys(steps).length) return fail('当前任务尚无可迁移的完整剧本成果；零散输出和远端请求不会转交给新模型')
  return { ...(checkpoint.prompt === undefined ? {} : { prompt: checkpoint.prompt }), steps }
}
