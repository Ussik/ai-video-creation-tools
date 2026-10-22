import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { all, db, newId, now, one, required, run } from '../../infrastructure/database/db.js'
import type { Project, ScriptArtifact, ScriptScene, Shot } from '../../infrastructure/database/db.js'
import { analyzeVisualProfiles, applyProfileShotUsage, inheritSceneVisualBindings, profileDraft, resolveVisualProfileDrafts, sceneVisualDesignIds, scopeVisualProfileDrafts, updateVisualProfile, validateProfileShotUsage, visualProjectData, type VisualProfile } from '../visuals/visual-profiles.js'
import type { OutputContract } from '../generation/model-output.js'
import { projectVisualStyle } from '../visuals/project-visual-style.js'
import { shotImagePrompt, shotVideoPrompt } from '@video-studio/shared/storyboard/shot-prompts'
import { assertStoryboardReferenceBudget, storyboardReferenceBudget, storyboardReferenceBudgetIssues } from '../storyboard/storyboard-reference-budget.js'
import { skillIdsInput } from '../skills/skills.js'

type Context = {
  script: (projectId: string) => { outline: string; characters: string; artifacts?: ScriptArtifact[]; scenes: ScriptScene[] };
  scenePrompt: (scene: ScriptScene) => string;
  generateText: (projectId: string, modelId: string, prompt: string, contract?: OutputContract) => Promise<string>;
}
const scopeInput = z.object({ scene_ids: z.array(z.string().min(1)).min(1).max(100) }).strict()
const planInput = scopeInput.extend({ signature: z.string().length(64), model_id: z.string().min(1).optional(), skill_ids: skillIdsInput.optional() })
const commitInput = scopeInput.extend({ signature: z.string().length(64), profiles: profileDraft.shape.profiles,
  reference_usage_version: z.literal(1).optional() })
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function conflict(): never { throw Object.assign(new Error('剧本或视觉设定已更新，请重新加入画布'), { statusCode: 409 }) }
function invalid(message: string): never { throw Object.assign(new Error(message), { statusCode: 422 }) }

export function scriptCanvasPreparationSnapshot(id: string, sceneIds: string[], context: Pick<Context, 'script'>) {
  const project = required<Project>('projects', id)
  const script = context.script(id)
  const scenes = script.scenes.filter(scene => sceneIds.includes(scene.id))
  if (new Set(sceneIds).size !== sceneIds.length || scenes.length !== sceneIds.length) invalid('所选场次不属于当前项目或重复')
  const style = projectVisualStyle(id)
  const shots = all<Shot>('SELECT * FROM shots WHERE project_id=? AND superseded_by IS NULL ORDER BY position, id', id)
    .filter(shot => sceneIds.includes(shot.source_scene_id || ''))
  const sceneDesigns = sceneVisualDesignIds(id, sceneIds)
  const designIds = new Set(sceneDesigns.values())
  const allVisuals = visualProjectData(id)
  const profiles = allVisuals.visual_profiles.filter(profile => designIds.has(profile.design_id || null))
  const profileIds = new Set(profiles.map(profile => profile.id))
  const visuals = { ...allVisuals, visual_profiles: profiles,
    scene_visual_bindings: allVisuals.scene_visual_bindings.filter(binding => sceneDesigns.has(binding.scene_id)
      && profiles.some(profile => profile.id === binding.profile_id && (profile.design_id || null) === sceneDesigns.get(binding.scene_id))),
    shot_visual_bindings: allVisuals.shot_visual_bindings.filter(binding => profileIds.has(binding.profile_id) && shots.some(shot => shot.id === binding.shot_id)),
  }
  const referenceBudget = storyboardReferenceBudget()
  const overBudgetScenes = new Set(storyboardReferenceBudgetIssues(id, sceneIds).map(issue => issue.scene_id))
  const signatureFor = (scene: ScriptScene) => hash({
    // Invalidate preparation caches created before definition refresh was supported.
    preparation_version: 3,
    design: sceneDesigns.get(scene.id) ? one('SELECT id, name, instructions FROM storyboard_designs WHERE id=?', sceneDesigns.get(scene.id)) : null,
    brief: project.brief, outline: script.outline, characters: script.characters,
    referenceBudget, artifacts: (script.artifacts || []).filter(item => !item.episode_number || item.episode_number === scene.episode_number)
      .map(item => [item.id, item.artifact_type, item.episode_number, item.content]), scene, style: style.version,
    shots: shots.filter(shot => shot.source_scene_id === scene.id).map(shot => ({
      id: shot.id, title: shot.title, prompt: shot.prompt, image_prompt: shot.image_prompt, video_prompt: shot.video_prompt,
      start_state: shot.start_state, end_state: shot.end_state, cut_note: shot.cut_note, duration: shot.duration,
    })),
  })
  const needsAnalysis = scenes.filter(scene => {
    if (overBudgetScenes.has(scene.id)) return true
    const prepared = one<{ signature: string; profile_ids: string }>('SELECT * FROM script_canvas_preparations WHERE scene_id=?', scene.id)
    if (!prepared || prepared.signature !== signatureFor(scene)) return true
    const bindings = visuals.scene_visual_bindings.filter(binding => binding.scene_id === scene.id).map(binding => binding.profile_id).sort()
    return JSON.stringify(bindings) !== prepared.profile_ids
  })
  // Include definitions and bindings in the commit version, so a model response
  // cannot race a user editing the same settings during preparation.
  const signature = hash({ sources: scenes.map(signatureFor), profiles: visuals.visual_profiles,
    bindings: visuals.scene_visual_bindings, shot_bindings: visuals.shot_visual_bindings.filter(binding => shots.some(shot => shot.id === binding.shot_id)), shots })
  const refreshSceneIds = new Set(needsAnalysis.filter(scene => one('SELECT 1 FROM script_canvas_preparations WHERE scene_id=?', scene.id)).map(scene => scene.id))
  return { scenes, shots, visuals, signature, signatureFor, needsAnalysis, refreshSceneIds, sceneDesigns }
}

export function checkScriptCanvasPreparation(id: string, sceneIds: string[], context: Pick<Context, 'script'>) {
  const state = scriptCanvasPreparationSnapshot(id, sceneIds, context)
  return { signature: state.signature, scene_ids: sceneIds, needs_analysis: state.needsAnalysis.map(scene => scene.id) }
}

export function registerScriptCanvasRoutes(app: FastifyInstance, context: Context) {
  app.post('/api/projects/:id/script/canvas/check', async request => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params)
    const data = scopeInput.parse(request.body)
    return checkScriptCanvasPreparation(id, data.scene_ids, context)
  })
  app.post('/api/projects/:id/script/canvas/prepare', async request => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params)
    const data = planInput.parse(request.body)
    const state = scriptCanvasPreparationSnapshot(id, data.scene_ids, context)
    if (state.signature !== data.signature) conflict()
    const groups = new Map<string | null, string[]>()
    for (const scene of state.needsAnalysis) {
      const designId = state.sceneDesigns.get(scene.id) || null
      groups.set(designId, [...(groups.get(designId) || []), scene.id])
    }
    const drafts = await Promise.all([...groups].map(([design_id, scene_ids]) => analyzeVisualProfiles(id, {
      model_id: data.model_id || invalid('请选择文本模型，以整理缺少的视觉设定'),
      scene_ids, design_id, skill_ids: data.skill_ids, inherit_scene_references: true,
      refresh_scene_ids: [...state.refreshSceneIds].filter(sceneId => scene_ids.includes(sceneId)),
    }, context)))
    if (scriptCanvasPreparationSnapshot(id, data.scene_ids, context).signature !== state.signature) conflict()
    return { signature: state.signature, scene_ids: data.scene_ids, profiles: drafts.flatMap(draft => draft.profiles),
      reference_usage_version: 1,
      used_skills: [...new Map(drafts.flatMap(draft => draft.skills).map(skill => [skill.id, skill])).values()],
      loaded_files: [...new Map(drafts.flatMap(draft => draft.loaded_files).map(file => [JSON.stringify(file), file])).values()] }
  })
  app.post('/api/projects/:id/script/canvas/commit', async request => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params)
    const data = commitInput.parse(request.body)
    return db.transaction(() => {
      const state = scriptCanvasPreparationSnapshot(id, data.scene_ids, context)
      if (state.signature !== data.signature) conflict()
      const allowed = new Set(state.needsAnalysis.map(scene => scene.id))
      if (data.profiles.some(profile => !profile.scene_ids.length || profile.scene_ids.some(sceneId => !allowed.has(sceneId)))) invalid('视觉草稿必须引用本次需要整理的场次')
      const scopedProfiles = scopeVisualProfileDrafts(id, data.profiles, state.sceneDesigns)
      for (const input of scopedProfiles) validateProfileShotUsage(id, input)
      const merged = new Map<string, z.infer<typeof profileDraft>['profiles'][number]>()
      for (const input of scopedProfiles) {
        const key = JSON.stringify([input.design_id || null, input.kind, input.name, input.variant])
        const previous = merged.get(key)
        if (previous && (previous.definition !== input.definition || previous.view_requirements !== input.view_requirements
          || previous.draft_key !== input.draft_key || previous.base_profile_id !== input.base_profile_id
          || previous.base_draft_key !== input.base_draft_key || previous.state_delta !== input.state_delta)) invalid(`「${input.name}」同一版本的视觉草稿存在冲突，请重新整理`)
        const usages = new Map((previous?.shot_usage || []).map(item => [item.shot_id, item]))
        for (const item of input.shot_usage || []) {
          if (usages.has(item.shot_id) && usages.get(item.shot_id)!.usage !== item.usage) invalid(`「${input.name}」同一镜头的参考用途存在冲突`)
          usages.set(item.shot_id, item)
        }
        merged.set(key, { ...input, scene_ids: [...new Set([...(previous?.scene_ids || []), ...input.scene_ids])],
          ...((previous?.shot_usage || input.shot_usage) ? { shot_usage: [...usages.values()] } : {}) })
      }
      if (data.reference_usage_version === 1) for (const input of merged.values()) {
        const expected = state.shots.filter(shot => input.scene_ids.includes(shot.source_scene_id || ''))
        if (expected.some(shot => !input.shot_usage?.some(item => item.shot_id === shot.id))) invalid('请明确每个已规划镜头的图片与视频参考用途')
      }
      assertStoryboardReferenceBudget(id, [...allowed], [...merged.values()], {
        replaceSceneBindings: data.reference_usage_version === 1 || [...merged.values()].some(input => input.shot_usage !== undefined),
        inheritSceneReferences: true,
      })
      let createdProfiles = 0
      const resolved = resolveVisualProfileDrafts(id, [...merged.values()])
      for (const { input, id: profileId, existing } of resolved) {
        if (!existing) {
          const timestamp = now()
          run(`INSERT INTO visual_profiles (id, project_id, kind, name, variant, definition, view_requirements, design_id, revision, definition_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'draft', ?, ?)`, profileId, id, input.kind, input.name, input.variant, input.definition, input.view_requirements, input.design_id || null, timestamp, timestamp)
          createdProfiles++
        }
      }
      for (const { input, id: profileId, existing, base_profile_id, state_delta } of resolved) {
        let profile = required<VisualProfile>('visual_profiles', profileId)
        const relationChanged = (profile.base_profile_id || null) !== base_profile_id || (profile.state_delta || '') !== state_delta
        if (!existing) {
          run('UPDATE visual_profiles SET base_profile_id=?, state_delta=? WHERE id=?', base_profile_id, state_delta, profileId)
          profile = required<VisualProfile>('visual_profiles', profileId)
        } else if (input.scene_ids.some(sceneId => state.refreshSceneIds.has(sceneId)) &&
          (profile.definition !== input.definition || profile.view_requirements !== input.view_requirements || relationChanged)) {
          profile = updateVisualProfile(profile.id, { expected_revision: profile.revision, definition: input.definition,
            view_requirements: input.view_requirements, base_profile_id, state_delta, definition_status: 'draft' }, { refreshUnresolvedBindings: false })
        } else if (relationChanged) {
          invalid('已有设定的基础关系已变化，请先打开设定检查并保存，再重新加入画布')
        }
        // Reanalysis updates this definition; unrelated shot snapshots stay frozen.
        for (const sceneId of input.scene_ids) run('INSERT OR IGNORE INTO scene_visual_bindings VALUES (?, ?, 1)', sceneId, profile.id)
      }
      for (const scene of state.scenes) {
        const count = one<{ total: number }>(`SELECT COUNT(*) AS total FROM scene_visual_bindings b JOIN visual_profiles p ON p.id=b.profile_id
          WHERE b.scene_id=? AND p.design_id IS ?`, scene.id, state.sceneDesigns.get(scene.id) || null)!.total
        if (count > 50) invalid('单个场次最多引用 50 份视觉设定，请缩小整理范围')
      }
      let nextPosition = one<{ next: number }>('SELECT COALESCE(MAX(position), -1)+1 AS next FROM shots WHERE project_id=?', id)!.next
      let createdShots = 0
      for (const scene of state.scenes) {
        let shots = all<Shot>('SELECT * FROM shots WHERE project_id=? AND source_scene_id=? AND superseded_by IS NULL ORDER BY position', id, scene.id)
        if (!shots.length) {
          const shotId = newId(), prompt = context.scenePrompt(scene)
          run(`INSERT INTO shots (id, project_id, position, title, prompt, duration, selected_asset_id, created_at, source_scene_id, image_prompt, video_prompt, design_id)
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`, shotId, id, nextPosition++, scene.heading, prompt, scene.duration, now(), scene.id, shotImagePrompt({ prompt }), shotVideoPrompt({ prompt }), state.sceneDesigns.get(scene.id) || null)
          shots = [required<Shot>('shots', shotId)]
          createdShots++
        }
        for (const shot of shots) inheritSceneVisualBindings(shot.id, scene.id)
      }
      // Scoped analysis replaces whole-scene inheritance. Scene candidates
      // omitted from the new result stay available without becoming shot inputs.
      if (data.reference_usage_version === 1 || [...merged.values()].some(input => input.shot_usage !== undefined)) {
        for (const shot of state.shots.filter(shot => allowed.has(shot.source_scene_id || ''))) run(`UPDATE shot_visual_bindings SET usage='none'
          WHERE shot_id=? AND profile_id IN (SELECT b.profile_id FROM scene_visual_bindings b JOIN visual_profiles p ON p.id=b.profile_id
          WHERE b.scene_id=? AND p.design_id IS ?)`, shot.id, shot.source_scene_id, shot.design_id || null)
      }
      for (const { input, id: profileId } of resolved) {
        const profile = required<VisualProfile>('visual_profiles', profileId)
        applyProfileShotUsage(profile, input, state.refreshSceneIds)
      }
      assertStoryboardReferenceBudget(id, data.scene_ids)
      // The legacy preparation route can create a scene template. Record the
      // final shot contents so that creation itself does not invalidate the cache.
      const prepared = scriptCanvasPreparationSnapshot(id, data.scene_ids, context)
      for (const scene of prepared.scenes) {
        const profileIds = prepared.visuals.scene_visual_bindings.filter(binding => binding.scene_id === scene.id).map(binding => binding.profile_id).sort()
        run(`INSERT INTO script_canvas_preparations (scene_id, signature, profile_ids) VALUES (?, ?, ?)
          ON CONFLICT(scene_id) DO UPDATE SET signature=excluded.signature, profile_ids=excluded.profile_ids`, scene.id, prepared.signatureFor(scene), JSON.stringify(profileIds))
      }
      run('UPDATE projects SET updated_at=? WHERE id=?', now(), id)
      const visuals = visualProjectData(id)
      const shots = all<Shot>('SELECT * FROM shots WHERE project_id=? AND superseded_by IS NULL ORDER BY position', id).filter(shot => data.scene_ids.includes(shot.source_scene_id || ''))
      const shotIds = new Set(shots.map(shot => shot.id))
      const bindings = visuals.shot_visual_bindings.filter(binding => shotIds.has(binding.shot_id))
      const profileIds = new Set(bindings.map(binding => binding.profile_id))
      const includeBase = (profileId: string) => {
        const baseId = visuals.visual_profiles.find(profile => profile.id === profileId)?.base_profile_id
        if (baseId && !profileIds.has(baseId)) { profileIds.add(baseId); includeBase(baseId) }
      }
      for (const profileId of [...profileIds]) includeBase(profileId)
      return { scene_ids: data.scene_ids, shots, visual_profiles: visuals.visual_profiles.filter(profile => profileIds.has(profile.id)), shot_visual_bindings: bindings, created_profiles: createdProfiles, created_shots: createdShots }
    })()
  })
}
