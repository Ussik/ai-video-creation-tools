import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { all, db, newId, now, one, required, run } from '../../infrastructure/database/db.js'
import type { Project, ScriptArtifact, ScriptScene, Shot } from '../../infrastructure/database/db.js'
import { analyzeVisualProfiles, applyProfileShotUsage, inheritSceneVisualBindings, profileDraft, validateProfileShotUsage, visualProjectData, type VisualProfile } from '../visuals/visual-profiles.js'
import type { OutputContract } from '../generation/model-output.js'
import { projectVisualStyle } from '../visuals/project-visual-style.js'
import { shotImagePrompt, shotVideoPrompt } from '@video-studio/shared/storyboard/shot-prompts'
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
  const visuals = visualProjectData(id)
  const style = projectVisualStyle(id)
  const shots = all<Shot>('SELECT * FROM shots WHERE project_id=? ORDER BY position, id', id)
    .filter(shot => sceneIds.includes(shot.source_scene_id || ''))
  const signatureFor = (scene: ScriptScene) => hash({
    brief: project.brief, outline: script.outline, characters: script.characters,
    artifacts: (script.artifacts || []).filter(item => !item.episode_number || item.episode_number === scene.episode_number)
      .map(item => [item.id, item.artifact_type, item.episode_number, item.content]), scene, style: style.version,
    shots: shots.filter(shot => shot.source_scene_id === scene.id).map(shot => ({
      id: shot.id, title: shot.title, prompt: shot.prompt, image_prompt: shot.image_prompt, video_prompt: shot.video_prompt,
      start_state: shot.start_state, end_state: shot.end_state, cut_note: shot.cut_note, duration: shot.duration,
    })),
  })
  const needsAnalysis = scenes.filter(scene => {
    const prepared = one<{ signature: string; profile_ids: string }>('SELECT * FROM script_canvas_preparations WHERE scene_id=?', scene.id)
    if (!prepared || prepared.signature !== signatureFor(scene)) return true
    const bindings = visuals.scene_visual_bindings.filter(binding => binding.scene_id === scene.id).map(binding => binding.profile_id).sort()
    return JSON.stringify(bindings) !== prepared.profile_ids
  })
  // Include definitions and bindings in the commit version, so a model response
  // cannot race a user editing the same settings during preparation.
  const signature = hash({ sources: scenes.map(signatureFor), profiles: visuals.visual_profiles,
    bindings: visuals.scene_visual_bindings, shot_bindings: visuals.shot_visual_bindings.filter(binding => shots.some(shot => shot.id === binding.shot_id)), shots })
  return { scenes, shots, visuals, signature, signatureFor, needsAnalysis }
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
    const drafts = state.needsAnalysis.length ? await analyzeVisualProfiles(id, {
      model_id: data.model_id || invalid('请选择文本模型，以整理缺少的视觉设定'),
      scene_ids: state.needsAnalysis.map(scene => scene.id),
      skill_ids: data.skill_ids,
    }, context) : { profiles: [], skills: [], loaded_files: [] }
    if (scriptCanvasPreparationSnapshot(id, data.scene_ids, context).signature !== state.signature) conflict()
    return { signature: state.signature, scene_ids: data.scene_ids, profiles: drafts.profiles,
      reference_usage_version: 1,
      used_skills: drafts.skills, loaded_files: drafts.loaded_files }
  })
  app.post('/api/projects/:id/script/canvas/commit', async request => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params)
    const data = commitInput.parse(request.body)
    return db.transaction(() => {
      const state = scriptCanvasPreparationSnapshot(id, data.scene_ids, context)
      if (state.signature !== data.signature) conflict()
      const allowed = new Set(state.needsAnalysis.map(scene => scene.id))
      if (data.profiles.some(profile => !profile.scene_ids.length || profile.scene_ids.some(sceneId => !allowed.has(sceneId)))) invalid('视觉草稿必须引用本次需要整理的场次')
      for (const input of data.profiles) validateProfileShotUsage(id, input)
      const merged = new Map<string, z.infer<typeof profileDraft>['profiles'][number]>()
      for (const input of data.profiles) {
        const key = JSON.stringify([input.kind, input.name, input.variant])
        const previous = merged.get(key)
        if (previous && (previous.definition !== input.definition || previous.view_requirements !== input.view_requirements)) invalid(`「${input.name}」同一版本的视觉草稿存在冲突，请重新整理`)
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
      let createdProfiles = 0
      for (const input of merged.values()) {
        let profile = one<VisualProfile>('SELECT * FROM visual_profiles WHERE project_id=? AND kind=? AND name=? AND variant=?', id, input.kind, input.name, input.variant)
        if (!profile) {
          const profileId = newId(), timestamp = now()
          run(`INSERT INTO visual_profiles (id, project_id, kind, name, variant, definition, view_requirements, revision, definition_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'draft', ?, ?)`, profileId, id, input.kind, input.name, input.variant, input.definition, input.view_requirements, timestamp, timestamp)
          profile = required<VisualProfile>('visual_profiles', profileId)
          createdProfiles++
        }
        // Existing definitions, approved boards and optional bindings are kept.
        for (const sceneId of input.scene_ids) run('INSERT OR IGNORE INTO scene_visual_bindings VALUES (?, ?, 1)', sceneId, profile.id)
      }
      for (const scene of state.scenes) {
        const count = one<{ total: number }>('SELECT COUNT(*) AS total FROM scene_visual_bindings WHERE scene_id=?', scene.id)!.total
        if (count > 50) invalid('单个场次最多引用 50 份视觉设定，请缩小整理范围')
      }
      let nextPosition = one<{ next: number }>('SELECT COALESCE(MAX(position), -1)+1 AS next FROM shots WHERE project_id=?', id)!.next
      let createdShots = 0
      for (const scene of state.scenes) {
        let shots = all<Shot>('SELECT * FROM shots WHERE project_id=? AND source_scene_id=? ORDER BY position', id, scene.id)
        if (!shots.length) {
          const shotId = newId(), prompt = context.scenePrompt(scene)
          run(`INSERT INTO shots (id, project_id, position, title, prompt, duration, selected_asset_id, created_at, source_scene_id, image_prompt, video_prompt)
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`, shotId, id, nextPosition++, scene.heading, prompt, scene.duration, now(), scene.id, shotImagePrompt({ prompt }), shotVideoPrompt({ prompt }))
          shots = [required<Shot>('shots', shotId)]
          createdShots++
        }
        for (const shot of shots) inheritSceneVisualBindings(shot.id, scene.id)
      }
      // Scoped analysis replaces whole-scene inheritance. Scene candidates
      // omitted from the new result stay available without becoming shot inputs.
      if (data.reference_usage_version === 1 || [...merged.values()].some(input => input.shot_usage !== undefined)) {
        for (const shot of state.shots.filter(shot => allowed.has(shot.source_scene_id || ''))) run(`UPDATE shot_visual_bindings SET usage='none'
          WHERE shot_id=? AND profile_id IN (SELECT profile_id FROM scene_visual_bindings WHERE scene_id=?)`, shot.id, shot.source_scene_id)
      }
      for (const input of merged.values()) {
        const profile = one<VisualProfile>('SELECT * FROM visual_profiles WHERE project_id=? AND kind=? AND name=? AND variant=?', id, input.kind, input.name, input.variant)!
        applyProfileShotUsage(profile, input)
      }
      // The legacy preparation route can create a scene template. Record the
      // final shot contents so that creation itself does not invalidate the cache.
      const prepared = scriptCanvasPreparationSnapshot(id, data.scene_ids, context)
      for (const scene of prepared.scenes) {
        const profileIds = all<{ profile_id: string }>('SELECT profile_id FROM scene_visual_bindings WHERE scene_id=? ORDER BY profile_id', scene.id).map(item => item.profile_id)
        run(`INSERT INTO script_canvas_preparations (scene_id, signature, profile_ids) VALUES (?, ?, ?)
          ON CONFLICT(scene_id) DO UPDATE SET signature=excluded.signature, profile_ids=excluded.profile_ids`, scene.id, prepared.signatureFor(scene), JSON.stringify(profileIds))
      }
      run('UPDATE projects SET updated_at=? WHERE id=?', now(), id)
      const visuals = visualProjectData(id)
      const shots = all<Shot>('SELECT * FROM shots WHERE project_id=? ORDER BY position', id).filter(shot => data.scene_ids.includes(shot.source_scene_id || ''))
      const shotIds = new Set(shots.map(shot => shot.id))
      const bindings = visuals.shot_visual_bindings.filter(binding => shotIds.has(binding.shot_id))
      const profileIds = new Set(bindings.map(binding => binding.profile_id))
      return { scene_ids: data.scene_ids, shots, visual_profiles: visuals.visual_profiles.filter(profile => profileIds.has(profile.id)), shot_visual_bindings: bindings, created_profiles: createdProfiles, created_shots: createdShots }
    })()
  })
}
