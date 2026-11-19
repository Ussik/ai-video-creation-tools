import { all } from '../../infrastructure/database/db.js'
import { generationUnitStore } from '../generation/generation-unit-store.js'
import { creativeInputHash } from '../skills/creative-model-state.js'
import { applySkillRules, skillContext } from '../skills/skills.js'
import type { resolveCreationSkillContext } from '../skills/model-skill-selection.js'

type Rules = Awaited<ReturnType<typeof resolveCreationSkillContext>>
const policy = 'visual-profile-preparation-v1'
const historyFailures = new Set(['visual_profile_locked_field_changed', 'visual_profile_checkpoint_identity_mismatch',
  'visual_profile_legacy_delivery_pending', 'visual_profile_correction_exhausted', 'visual_profile_legacy_candidate_preserved',
  'visual_profile_migration_conflict', 'visual_catalog_legacy_response_preserved'])

/** Persist choices, not guesses about historical hashes. The key covers full
 * task/source/channel and the installed skill bodies/defaults. On reuse the
 * current loader must reconstruct the exact same rules and file identities. */
export function visualProfilePreparationState(input: {
  projectId: string; namespace: string; source: string; task: string; model: string; selectedIds?: string[];
}) {
  const registry = () => ({
    skills: all('SELECT * FROM installed_skills ORDER BY id'),
    stages: all('SELECT * FROM skill_stage_defaults ORDER BY stage'),
    projectStages: all('SELECT * FROM project_skill_defaults WHERE project_id=? ORDER BY stage', input.projectId),
    tasks: all('SELECT * FROM skill_task_defaults ORDER BY task'),
    projectTasks: all('SELECT * FROM project_skill_task_defaults WHERE project_id=? ORDER BY task', input.projectId),
  })
  const signature = creativeInputHash(registry())
  const identity = { policy, ...input, selectedIds: input.selectedIds ?? null, skills: signature }
  const store = generationUnitStore(input.projectId, `visual-preparation:${creativeInputHash(input.namespace)}`, identity)
  const snapshot = () => creativeInputHash(all('SELECT identity_hash,payload FROM model_unit_checkpoints WHERE project_id=? AND namespace=? ORDER BY identity_hash', input.projectId, input.namespace))
  const current = () => {
    if (creativeInputHash(registry()) !== signature) throw Object.assign(new Error('视觉整理期间技能或默认配置已变化，请重新加载'), { statusCode: 409 })
  }
  return {
    assertUnblocked() {
      current()
      const entry = store.read().steps.blocked?.value as { snapshot?: string; code?: string; message?: string; diagnostics?: string } | undefined
      if (entry?.snapshot !== snapshot() || !entry?.code || !historyFailures.has(entry.code)) return
      throw Object.assign(new Error(entry.message || '此档案的历史候选需要处理；相同输入不能继续自动请求。'), {
        code: 'visual_profile_history_action_required', statusCode: 409, retryable: false, recovery: { kind: 'review_candidate' },
        diagnostics: JSON.stringify({ stage: 'profile_expansion', original_code: entry.code, saved_diagnostics: entry.diagnostics,
          next_action: '检查保留的原答和具体单元；仅刷新或再次点击不会增加纠正额度。' }),
      })
    },
    async rules(resolve: () => Promise<Rules>, cachedOnly = false): Promise<Rules> {
      current()
      const cached = store.read().steps.rules?.value as Rules | undefined
      if (cached) {
        try {
          const refs = 'reference_assignment' in cached ? (cached.reference_assignment as { ids: string[] }).ids : []
          const rebuilt = skillContext('visual_assets', applySkillRules(input.task, { text: '', skills: [], files: [] }), cached.assignment.ids,
            input.projectId, { purpose: 'create' }, refs)
          if (rebuilt.text === cached.text && creativeInputHash(rebuilt.skills) === creativeInputHash(cached.skills) && creativeInputHash(rebuilt.files) === creativeInputHash(cached.files)) return structuredClone(cached)
        } catch { /* A failed reconstruction never supplies rules for generation. */ }
      }
      if (cachedOnly) throw Object.assign(new Error('本次续跑缺少可精确复用的技能记录，请先核对原任务配置；未重新选择技能或调用模型。'), {
        code: 'visual_profile_resume_context_missing', statusCode: 409, retryable: false,
      })
      const value = await resolve()
      current()
      const state = store.read()
      state.steps.rules = { input_hash: creativeInputHash(identity), value: structuredClone(value) }
      store.save(state)
      return value
    },
    rememberFailure(error: unknown) {
      if (!(error instanceof Error)) return
      const failure = error as Error & { code?: string; diagnostics?: string; retryable?: boolean; recovery?: { kind: string } }
      if (!failure.code || !historyFailures.has(failure.code)) return
      current()
      failure.retryable = false
      failure.recovery = { kind: 'review_candidate' }
      const state = store.read()
      state.steps.blocked = { input_hash: creativeInputHash(identity), value: {
        snapshot: snapshot(), code: failure.code, message: failure.message, diagnostics: failure.diagnostics,
      } }
      store.save(state)
    },
  }
}
