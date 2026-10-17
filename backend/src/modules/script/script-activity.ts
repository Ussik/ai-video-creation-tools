import { z } from 'zod'
import { stageOperations } from '@video-studio/shared/script/script-stage-access'
import { newId } from '../../infrastructure/database/db.js'
import { skillStageLabels, type SkillStage, type skillContext } from '../skills/skills.js'
import type { ScriptActivity } from '@video-studio/shared/script/script-activity-types'
export type { ScriptActivity } from '@video-studio/shared/script/script-activity-types'

// These records contain application operations and public model text only.
// Provider protocol history, credentials and private reasoning never enter them.
export const scriptActivitySchema = z.object({
  id: z.string().min(1).max(160),
  task_id: z.string().max(160).optional(), step_id: z.string().max(160).optional(),
  attempt: z.number().int().min(1).max(3).optional(), sequence: z.number().int().min(0).optional(),
  kind: z.enum(['skill', 'tool', 'model', 'context']),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  label: z.string().min(1).max(200), summary: z.string().max(3000),
  started_at: z.number().int().min(0), ended_at: z.number().int().min(0).optional(),
  duration_ms: z.number().int().min(0).optional(), round: z.number().int().min(1).max(20).optional(),
  scope: z.enum(['task', 'step', 'notice']).optional(), parent_id: z.string().max(160).optional(), reused: z.boolean().optional(),
  name: z.string().max(200).optional(), skill_id: z.string().max(160).optional(), revision: z.string().max(160).optional(),
  files: z.array(z.string().max(500)).max(100).optional(),
  input: z.string().max(4000).optional(), output: z.string().max(4000).optional(),
  input_truncated: z.boolean().optional(), output_truncated: z.boolean().optional(),
  request_bytes: z.number().int().min(0).optional(), response_chars: z.number().int().min(0).optional(),
  first_event_ms: z.number().int().min(0).optional(), input_tokens: z.number().int().min(0).optional(),
  output_tokens: z.number().int().min(0).optional(), reasoning_tokens: z.number().int().min(0).optional(),
  output_limit: z.number().int().min(1).optional(), upstream_request_id: z.string().max(160).optional(),
  estimated_input_tokens: z.number().int().min(0).optional(), context_window_tokens: z.number().int().min(1).optional(),
  reserved_output_tokens: z.number().int().min(1).optional(),
  http_status: z.number().int().min(100).max(599).optional(),
  targets: z.array(z.object({ kind: z.enum(['document', 'scene', 'shot', 'visual_profile']), id: z.string().min(1).max(160), title: z.string().max(200) }).strict()).max(100).optional(),
}).strict()
export const scriptExecutionSchema = z.object({
  title: z.string().min(1).max(200), request: z.string().max(8000), started_at: z.number().int().min(0), targets: z.array(z.string().max(200)).max(50).optional(),
  focus_artifact: z.enum(['all', 'character', 'location', 'prop']).optional(), mode: z.enum(['all', 'script', 'director']).optional(),
  document_action: z.object({ operation: z.enum(['review', 'revise']), document_ids: z.array(z.string().min(1).max(160)).min(1).max(8) }).strict().optional(),
  workflow: z.object({ operation: z.enum(stageOperations).optional(), stage: z.enum(['outline', 'characters', 'locations', 'props', 'episode']), scope: z.enum(['project', 'episode']).optional(), episode_number: z.number().int().min(0).max(200), target_duration: z.number().int().min(5).max(600).optional() }).strict().optional(),
  outcome: z.object({ kind: z.enum(['reply', 'question', 'draft', 'partial', 'saved', 'discarded', 'review', 'next_step', 'failed', 'cancelled']), summary: z.string().max(3000), draft_id: z.string().max(160).optional(), draft_version: z.string().max(160).optional() }).strict().optional(),
}).strict()
export const scriptActivitiesSchema = z.array(scriptActivitySchema).max(2000)
  .refine(value => new Set(value.map(event => event.id)).size === value.length, '执行记录 ID 不能重复')
  .refine(value => JSON.stringify(value).length <= 1_000_000, '执行记录内容过长')

export function activityPreview(value: unknown, field: 'input' | 'output') {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) || ''
  return { [field]: text.slice(0, 4000), [`${field}_truncated`]: text.length > 4000 }
}

export function activityRecorder(onEvent: (event: Record<string, unknown>) => void) {
  const entries: ScriptActivity[] = []
  function emit(entry: ScriptActivity) {
    const index = entries.findIndex(item => item.id === entry.id)
    if (index < 0) entries.push(entry)
    else entries[index] = entry
    onEvent({ type: 'activity', activity: entry })
    return entry
  }
  return {
    entries,
    start(entry: Omit<ScriptActivity, 'id' | 'status' | 'started_at'>) {
      return emit({ ...entry, id: newId(), status: 'running', started_at: Date.now() })
    },
    finish(entry: ScriptActivity, status: Exclude<ScriptActivity['status'], 'running'>, changes: Partial<ScriptActivity> = {}) {
      // A request deadline may settle a step before its nested promise rejects.
      const current = entries.find(item => item.id === entry.id)
      if (current && current.status !== 'running') return current
      const ended_at = Date.now()
      return emit({ ...entry, ...changes, status, ended_at, duration_ms: Math.max(0, ended_at - entry.started_at) })
    },
    skills(stage: SkillStage, context: ReturnType<typeof skillContext>) {
      if (!context.skills.length) {
        const entry = this.start({ kind: 'context', label: 'Skill 配置', summary: '本轮使用基础创作规则，未加载外部 Skill' })
        this.finish(entry, 'succeeded'); return
      }
      for (const skill of context.skills) {
        const entry = this.start({ kind: 'skill', label: skill.name, name: skill.name, skill_id: skill.id,
          revision: skill.revision, files: skill.files,
          summary: `已加载${skillStageLabels[stage]}${skill.role === 'auxiliary' ? '辅助技能' : '主技能'}规则与参考资料，随本轮请求提供给模型` })
        this.finish(entry, 'succeeded')
      }
    },
  }
}
