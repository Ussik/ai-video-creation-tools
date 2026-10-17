import type { ScriptActivity, ScriptActivityTarget, ScriptExecution } from '@video-studio/shared/script/script-activity-types'
import type { DocumentReview } from '@video-studio/shared/script/script-review-types'
export type { ScriptActivity, ScriptExecution }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function sourceTarget(value: unknown): ScriptActivityTarget | null {
  const item = record(value)
  if (!item || !['document', 'scene', 'shot', 'visual_profile'].includes(String(item.kind)) || typeof item.id !== 'string' || !item.id.trim() || typeof item.title !== 'string' || !item.title.trim()) return null
  return { kind: item.kind as ScriptActivityTarget['kind'], id: item.id, title: item.title.slice(0, 200) }
}

export function readActivity(value: unknown): ScriptActivity[] {
  if (!Array.isArray(value)) return []
  const entries: ScriptActivity[] = []
  for (const item of value) {
    if (!item || typeof item.id !== 'string' || typeof item.label !== 'string' || typeof item.summary !== 'string') continue
    const kind = ['skill', 'tool', 'model', 'context'].includes(item.kind) ? item.kind : 'context'
    const status = ['running', 'succeeded', 'failed', 'cancelled'].includes(item.status) ? item.status : 'succeeded'
    const legacyNotice = !item.scope && kind === 'context' && status === 'succeeded' && /^正在生成/.test(item.label) && typeof item.duration_ms === 'number' && item.duration_ms < 100
    entries.push({ ...item, kind, status, started_at: Number.isFinite(item.started_at) && item.started_at >= 0 && item.started_at <= 8.64e15 ? item.started_at : 0,
      ...(legacyNotice ? { scope: 'notice' } : {}),
      ...(Array.isArray(item.targets) ? { targets: item.targets.map(sourceTarget).filter((target: ScriptActivityTarget | null): target is ScriptActivityTarget => target !== null).slice(0, 100) } : {}) })
  }
  return entries
}

export function updateActivity(entries: ScriptActivity[] | undefined, event: ScriptActivity) {
  const current = readActivity(entries)
  return current.some(item => item.id === event.id) ? current.map(item => item.id === event.id ? event : item) : [...current, event]
}

export function settleActivity(entries: ScriptActivity[] | undefined, status: 'failed' | 'cancelled', endedAt = Date.now()) {
  return readActivity(entries).map(item => item.status === 'running' ? { ...item, status, ended_at: endedAt,
    duration_ms: Math.max(0, endedAt - item.started_at),
    summary: status === 'cancelled' ? '已停止等待，未收到此步骤的最终结果；请检查项目当前状态' : '连接中断，未收到此步骤的最终结果；请检查项目当前状态' } : item)
}

// Use the same serializer for debounced saves and closing the panel.
export function conversationMessage<T extends { id: string; role: 'assistant' | 'user'; text: string; activity?: ScriptActivity[];
  stage_context?: unknown; reference_documents?: unknown[]; processing_duration_ms?: number | null; review?: DocumentReview; execution?: ScriptExecution;
  pending?: boolean; task_id?: string; classification?: unknown; classification_version?: number; classification_context?: string; classification_source?: string }>(message: T) {
  const { id, role, text, stage_context, reference_documents, processing_duration_ms } = message
  const activity = readActivity(message.activity)
  const reply_metadata = { ...(message.classification_source && message.classification ? { classification: message.classification,
    classification_version: message.classification_version, classification_context: message.classification_context, classification_source: message.classification_source } : {}),
    ...(message.task_id ? { task_id: message.task_id } : {}),
    ...(message.review ? { review: message.review } : {}), ...(message.execution ? { execution: message.pending && !message.task_id ? { ...message.execution,
      outcome: { ...message.execution.outcome, kind: 'cancelled', summary: '本轮尚未记录完整结果，请检查草稿和项目当前状态。' } } : message.execution } : {}) }
  return { id, role, text, ...(stage_context ? { stage_context } : {}), ...(reference_documents?.length ? { reference_documents } : {}),
    ...(processing_duration_ms != null ? { processing_duration_ms } : {}), ...(role === 'assistant' && activity.length ? { activity } : {}),
    ...(role === 'assistant' && Object.keys(reply_metadata).length ? { reply_metadata } : {}) }
}

const readTools = new Set(['get_creation_state', 'get_project_visual_style', 'search_project_content', 'read_documents', 'find_related_content', 'get_document_review_context', 'read_visual_profiles', 'get_storyboard_context'])
const nonMutatingTools = new Set([...readTools, 'ask_creator'])
function readPayload(event: ScriptActivity) {
  if (event.output_truncated || !event.output) return null
  try { return record(JSON.parse(event.output)) } catch { return null }
}
export function activityGroup(event: ScriptActivity): 'sources' | 'rules' | 'model' | 'results' {
  if (event.kind === 'skill' || event.label === 'Skill 配置') return 'rules'
  if (event.kind === 'model' || event.scope) return 'model'
  if (event.kind === 'tool' && !readTools.has(event.name || '') && !(['manage_document_draft', 'manage_revision_task'].includes(event.name || '') && readDraftOnly(event))) return 'results'
  return 'sources'
}
export function activityStatusLabel(event: ScriptActivity) {
  if (event.scope === 'notice') return '开始提示'
  if (event.reused && event.status === 'succeeded') return '已复用'
  return { running: '进行中', succeeded: '已完成', failed: '未完成', cancelled: '已停止' }[event.status]
}

export function activityDepth(event: ScriptActivity, events: ScriptActivity[]) {
  const seen = new Set([event.id])
  let depth = 0, parentId = event.parent_id
  while (parentId && depth < 3 && !seen.has(parentId)) {
    const parent = events.find(item => item.id === parentId)
    if (!parent) break
    seen.add(parentId); depth++; parentId = parent.parent_id
  }
  return depth
}
function readDraftOnly(event: ScriptActivity) {
  try { return JSON.parse(event.input || '{}').operation === 'read' } catch { return false }
}
export function canRetryExecution(activity: ScriptActivity[] | undefined) {
  return !readActivity(activity).some(event => event.kind === 'tool' && !nonMutatingTools.has(event.name || '') && !(['manage_document_draft', 'manage_revision_task'].includes(event.name || '') && readDraftOnly(event)))
}
export function activityDraftId(activity: ScriptActivity[] | undefined) {
  for (const event of readActivity(activity).reverse()) {
    if (event.kind !== 'tool') continue
    const output = event.status === 'succeeded' ? readPayload(event) : null
    if (typeof output?.draft_id === 'string' && output.draft_id) return output.draft_id
    if (['manage_document_draft', 'commit_document_draft'].includes(event.name || '') && !event.input_truncated) {
      try { const input = record(JSON.parse(event.input || '{}')); if (typeof input?.draft_id === 'string' && input.draft_id) return input.draft_id } catch { /* A preview may be incomplete. */ }
    }
  }
}
export function activitySources(activity: ScriptActivity[]): ScriptActivityTarget[] {
  const targets: ScriptActivityTarget[] = []
  for (const event of activity) {
    if (event.status !== 'succeeded') continue
    if (event.targets?.length) { targets.push(...event.targets.map(sourceTarget).filter((target): target is ScriptActivityTarget => target !== null)); continue }
    // Old histories retain complete payloads. Never invent source counts from
    // a truncated JSON preview or a human sentence.
    const output = readPayload(event)
    const items = event.name === 'read_documents' ? output?.documents : event.name === 'read_visual_profiles' ? output?.profiles : event.name === 'get_storyboard_context' ? output?.objects : undefined
    if (!Array.isArray(items)) continue
    for (const item of items) {
      const value = record(item)
      if (!value) continue
      const target = sourceTarget({ kind: event.name === 'read_documents' ? 'document' : event.name === 'read_visual_profiles' ? 'visual_profile' : value.type,
        id: value.id, title: event.name === 'read_visual_profiles' ? typeof value.name === 'string' ? `${value.name}${typeof value.variant === 'string' && value.variant ? ` · ${value.variant}` : ''}` : undefined : value.heading || value.title })
      if (target) targets.push(target)
    }
  }
  return [...new Map(targets.filter(item => item?.id && item.title).map(item => [`${item.kind}:${item.id}`, item])).values()]
}
export function executionView(activity: ScriptActivity[] | undefined, execution: ScriptExecution | undefined, pending?: boolean, failed?: boolean) {
  const events = readActivity(activity)
  const sources = activitySources(events)
  const skills = [...new Map(events.filter(event => event.kind === 'skill' && event.status === 'succeeded').map(event => [event.skill_id || event.name || event.label, event])).values()]
  const active = [...events].reverse().find(event => event.status === 'running')
  const groups = (['sources', 'rules', 'model', 'results'] as const).map(key => ({ key, events: events.filter(event => activityGroup(event) === key && !(event.kind === 'context' && event.label === 'Function Calling')) })).filter(group => group.events.length)
  const outcome = execution?.outcome
  const state = pending ? 'running' : outcome?.kind || (failed ? events.some(event => event.status === 'cancelled') ? 'cancelled' : 'failed' : 'reply')
  const labels = { running: '处理中', reply: '回复已完成', question: '待你回答', draft: '草稿待确认', partial: '部分完成', saved: '已保存', discarded: '草稿已放弃', review: '评审已完成', next_step: '可继续下一步', failed: '未完成', cancelled: '已停止' }
  const stats: string[] = []
  const counts = { document: 0, scene: 0, shot: 0, visual_profile: 0 }
  for (const source of sources) counts[source.kind]++
  if (counts.document) stats.push(`查阅 ${counts.document} 份文档`)
  if (counts.scene) stats.push(`${counts.scene} 个场次`)
  if (counts.shot) stats.push(`${counts.shot} 个镜头`)
  if (counts.visual_profile) stats.push(`${counts.visual_profile} 份视觉设定`)
  if (skills.length) stats.push(`${skills.length} 个 Skill 已加载`)
  const draftCount = events.filter(event => event.status === 'succeeded' && ['create_document_draft', 'propose_document_patch', 'propose_visual_profile_draft', 'propose_visual_binding_patch', 'propose_shot_plan', 'propose_shot_patch'].includes(event.name || '')).length
  if (draftCount) stats.push('已准备草稿')
  const rejected = events.filter(event => event.status === 'failed').length
  if (rejected && state !== 'failed') stats.push(`含 ${rejected} 条失败记录`)
  return { events, sources, skills, active, groups, state, stateLabel: labels[state], stats, outcome, canRetry: canRetryExecution(events) }
}
