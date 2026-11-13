import { createHash } from 'node:crypto'
import { z } from 'zod'
import { all, newId, now, one, required, run, type AssetTask, type ScriptScene, type Shot } from '../../infrastructure/database/db.js'
import { profileInput, updateVisualProfile, checkBindings, insertShotBinding, inheritSceneVisualBindings, sceneVisualDesignIds, scopeVisualProfileDrafts, resolveVisualProfileDrafts, type VisualProfile, type VisualBinding } from '../visuals/visual-profiles.js'
import { visualProfileTextInstructions } from '@video-studio/shared/visuals/visual-profile-display-text'
import { visualBindingUsages } from '@video-studio/shared/visuals/visual-binding-usage'
import type { ResourceChange, ShotDraftValue } from '@video-studio/shared/script/script-resource-types'
import type { DraftImpact } from '@video-studio/shared/script/script-review-types'
import { projectVisualStyle } from '../visuals/project-visual-style.js'
import { normalizeVisualBinding, referenceSnapshot, visualReferenceAssets } from '../visuals/visual-reference-assets.js'
import { visualBindingReferenceAssetIds } from '@video-studio/shared/media/video-reference-manifest'
import type { VisualReferenceSnapshot } from '@video-studio/shared/visuals/visual-reference-types'
import { resourceReadPage, resourceReadTracker } from './script-resource-read-page.js'
import { markShotContinuityEdited } from '../storyboard/storyboard-continuity-state.js'

const id = z.string().min(1).max(160), uniqueIds = z.array(id).max(100).refine(items => new Set(items).size === items.length, '对象 ID 不可重复')
export const shotDraftValue = z.object({ title: z.string().trim().min(1).max(120), prompt: z.string().trim().min(1).max(16000),
  image_prompt: z.string().trim().min(1).max(16000), video_prompt: z.string().trim().min(1).max(16000), duration: z.number().int().min(1).max(30),
  start_state: z.string().max(3000).default(''), end_state: z.string().max(3000).default(''), cut_note: z.string().max(3000).default(''),
}).strict()
const bindings = z.array(z.object({ profile_id: id, required: z.boolean(), usage: z.enum(visualBindingUsages).optional() }).strict()).max(50)
export const resourceValueEdit = z.object({ index: z.number().int().min(0).max(299), value: z.union([profileInput, shotDraftValue, bindings]) }).strict()
// Model-only optional scope: strict tool protocols emit null for unspecified
// fields; restoreOptionalNulls restores it to omission before API validation.
const modelProfileInput = profileInput.extend({ design_id: z.string().min(1).optional() })
export const modelResourceValueEdit = resourceValueEdit.extend({ value: z.union([modelProfileInput, shotDraftValue, bindings]) })
export function editResourceValues(changes: ResourceChange[], edits: z.infer<typeof resourceValueEdit>[]) {
  if (new Set(edits.map(edit => edit.index)).size !== edits.length) fail('同一草稿对象不能重复编辑')
  if (edits.some(edit => edit.index >= changes.length)) fail('只能编辑当前草稿对象')
  return changes.map((change, index) => {
    const edit = edits.find(edit => edit.index === index)
    if (!edit) return change
    if (change.type === 'visual_profile') {
      const value = profileInput.parse(edit.value)
      if (value.design_id !== undefined && change.value.design_id !== undefined && value.design_id !== change.value.design_id) fail('视觉草稿不能迁移到其他设计方案')
      return { ...change, value: value.design_id === undefined && change.value.design_id !== undefined
        ? { ...value, design_id: change.value.design_id } : value }
    }
    if (change.type === 'visual_binding') {
      const value = bindings.parse(edit.value)
      return { ...change, value, refresh_profile_ids: change.refresh_profile_ids.filter(id => value.some(binding => binding.profile_id === id)) }
    }
    return { ...change, value: shotDraftValue.parse(edit.value) }
  }).map(change => change as ResourceChange)
}
export const resourceSchemas = {
  read_visual_profiles: z.object({ profile_ids: uniqueIds.optional(), query: z.string().trim().min(1).max(200).optional(), kind: z.enum(['character', 'location', 'prop']).optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(20).default(10), cursor: z.string().min(1).max(4096).optional() }).strict(),
  get_storyboard_context: z.object({ scene_ids: uniqueIds.optional(), shot_ids: uniqueIds.optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(10).default(3), catalog_offset: z.number().int().min(0).default(0), cursor: z.string().min(1).max(4096).optional() }).strict(),
  propose_visual_profile_draft: z.object({ summary: z.string().trim().min(1).max(3000), profiles: z.array(z.object({ profile_id: id.optional(), base_version: id.optional(), profile: profileInput }).strict()).min(1).max(20) }).strict(),
  propose_visual_binding_patch: z.object({ summary: z.string().trim().min(1).max(3000), targets: z.array(z.object({ target_type: z.enum(['scene', 'shot']), target_id: id, base_version: id, bindings, refresh_profile_ids: uniqueIds.default([]) }).strict()).min(1).max(20) }).strict(),
  propose_shot_plan: z.object({ summary: z.string().trim().min(1).max(3000), scenes: z.array(z.object({ scene_id: id, base_version: id, shots: z.array(shotDraftValue).min(1).max(30) }).strict()).min(1).max(10) }).strict(),
  propose_shot_patch: z.object({ summary: z.string().trim().min(1).max(3000), shots: z.array(z.object({ shot_id: id, base_version: id,
    changes: shotDraftValue.partial().extend({ start_state: z.string().max(3000).optional(), end_state: z.string().max(3000).optional(), cut_note: z.string().max(3000).optional() }).strict().refine(value => Object.keys(value).length > 0, '请提供修改字段'),
  }).strict()).min(1).max(20) }).strict(),
}
export const modelResourceSchemas = {
  ...resourceSchemas,
  propose_visual_profile_draft: resourceSchemas.propose_visual_profile_draft.extend({
    profiles: z.array(resourceSchemas.propose_visual_profile_draft.shape.profiles.element.extend({ profile: modelProfileInput })).min(1).max(20),
  }),
}
export const resourceDescriptions: Record<keyof typeof resourceSchemas, string> = {
  read_visual_profiles: '分页读取本项目视觉档案原文、版本、候选图ID、已确认独立参考图的角度/用途/版本/画风元数据、信息图与实际绑定。整页JSON最多48000字符；未complete时使用返回的continuation原样续读，将fragments按section/index/offset拼接serialized_fragment后JSON.parse还原对象，同source_version才可拼接。project_visual_style为null表示本页未重复风格或风格正分片；只有完整对象或全部片段实际读齐才可修改。reference_status按当前可用参考判断；仅返回媒体状态及文字，不代表已经看过图片。缺图只能如实说明，不能伪造参考图。',
  get_storyboard_context: '分页读取实际场次、已有镜头及图片/视频提示词、版本和冻结参考绑定；独立图按镜头已选快照读取，未选择时回退信息图，并返回图片存在状态，不代表已检查图片内容。scene_ids/shot_ids可限定范围。scene.version用于拆镜，shot.version用于镜头修改，binding_version用于绑定草稿。整页JSON最多48000字符，目录也分页且不会在continuation中重复；使用返回的continuation原样续读直到complete，将fragments按section/index/offset拼接serialized_fragment后JSON.parse还原对象；仅同source_version可拼接，源变化须重读。project_visual_style为null表示未重复或正在分片；完整对象或全部片段读齐后才可修改；目录发现不等于已read_visual_profiles。',
  propose_visual_profile_draft: '提交视觉设定草稿。新对象不填profile_id/base_version；已有对象必须先read_visual_profiles并传读取的版本。写详细多视角信息图设定，scene_ids限定真实场次。已有绑定通过单独绑定草稿调整。仅准备草稿，确认后才保存，不生成图片。' + visualProfileTextInstructions,
  propose_visual_binding_patch: '为已读取场次或镜头提出当前设计方案的完整绑定列表草稿，base_version使用binding_version；引用档案必须已读取且属于同一设计方案。镜头绑定的usage明确both=图片与视频、image=仅开镜图片、video=仅视频过程、none=本镜头不使用，省略时保留原用途；场次仅作候选资料池。列表之外的当前方案绑定会移除，其他方案的历史绑定保留；普通镜头引用自动跟随已确认的新设定，无需填refresh_profile_ids；锁定版本及手选参考图保持原样，需要用户在引用面板恢复自动匹配后才能重新匹配。确认后才执行绑定草稿，不修改历史生成记录。',
  propose_shot_plan: '为已读取场次提交新增分镜草稿，base_version使用scene.version。每场新增镜头时长之和须等于场次秒数；同时提供独立图片首帧提示词和视频动作运镜提示词。已有镜头保留，新镜头确认后追加；修改已有镜头用propose_shot_patch。',
  propose_shot_patch: '对已读取的现存分镜提出局部字段修改，使用shot.version。保留镜头ID、素材与场次关联；图片和视频提示词各自明确，叙事变化时检查两者及开收镜状态。只准备草稿，确认后才保存。',
}
export function resourceVersion(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
const profiles = (projectId: string) => all<VisualProfile>('SELECT * FROM visual_profiles WHERE project_id=? ORDER BY kind, name, variant, id', projectId)
function profileValue(profile: VisualProfile) { return profileInput.parse({ kind: profile.kind, name: profile.name, variant: profile.variant, definition: profile.definition, view_requirements: profile.view_requirements, scene_ids: [], design_id: profile.design_id || null,
  base_profile_id: profile.base_profile_id || null, state_delta: profile.state_delta || '' }) }
function scopedProfileValue(projectId: string, value: unknown, original: VisualProfile | null) {
  const input = profileInput.parse(value)
  if (original) {
    if (input.design_id !== undefined && input.design_id !== (original.design_id || null)) fail('已有视觉设定不能迁移到其他设计方案')
    if (input.base_draft_key) fail('已有视觉设定的基础关系请使用已保存档案的 ID')
    return { ...input, design_id: original.design_id || null }
  }
  const scoped = scopeVisualProfileDrafts(projectId, [input])[0]!
  return { ...scoped, design_id: scoped.design_id || null }
}
export function shotValue(shot: Shot): ShotDraftValue { return { title: shot.title, prompt: shot.prompt, image_prompt: shot.image_prompt || shot.prompt, video_prompt: shot.video_prompt || shot.prompt, duration: shot.duration, start_state: shot.start_state, end_state: shot.end_state, cut_note: shot.cut_note } }
function target(projectId: string, type: 'scene' | 'shot', id: string) {
  const item = type === 'scene' ? required<ScriptScene>('script_scenes', id) : required<Shot>('shots', id)
  if (item.project_id !== projectId) throw new Error('对象不属于当前项目')
  return item
}
function targetDesignId(projectId: string, type: 'scene' | 'shot', id: string) {
  const item = target(projectId, type, id)
  return type === 'scene' ? sceneVisualDesignIds(projectId, [id]).get(id) || null : (item as Shot).design_id || null
}
function checkedTargetBindings(projectId: string, type: 'scene' | 'shot', id: string, value: z.infer<typeof bindings>) {
  const current = target(projectId, type, id)
  if (type === 'shot' && (current as Shot).superseded_by) fail('不能修改历史方案镜头的参考绑定')
  const selected = checkBindings(projectId, value), designId = targetDesignId(projectId, type, id)
  if (selected.some(binding => (binding.profile.design_id || null) !== designId)) fail('参考设定必须属于目标的同一设计方案')
  return selected
}
type SceneResourceBinding = { profile_id: string; required: number }
type StoredShotBinding = Omit<VisualBinding, 'reference_assets'> & { reference_assets?: string | null }
type DecodedShotBinding = Omit<VisualBinding, 'reference_assets'> & { reference_assets: VisualReferenceSnapshot[] }
function storedTargetBindings(type: 'scene', id: string): SceneResourceBinding[]
function storedTargetBindings(type: 'shot', id: string): StoredShotBinding[]
function storedTargetBindings(type: 'scene' | 'shot', id: string): Array<SceneResourceBinding | StoredShotBinding>
function storedTargetBindings(type: 'scene' | 'shot', id: string): Array<SceneResourceBinding | StoredShotBinding> {
  if (type === 'shot') return all<StoredShotBinding>('SELECT * FROM shot_visual_bindings WHERE shot_id=? ORDER BY profile_id', id)
  const scene = required<ScriptScene>('script_scenes', id)
  return all<SceneResourceBinding>(`SELECT b.* FROM scene_visual_bindings b JOIN visual_profiles p ON p.id=b.profile_id
    WHERE b.scene_id=? AND p.design_id IS ? ORDER BY b.profile_id`, id, targetDesignId(scene.project_id, 'scene', id))
}
function targetBindings(type: 'scene' | 'shot', id: string): Array<SceneResourceBinding | DecodedShotBinding> {
  return type === 'scene' ? storedTargetBindings('scene', id) : storedTargetBindings('shot', id).map(normalizeVisualBinding)
}
// Keep the persisted bytes in draft hashes; read-only decoding and availability must not change versions.
function bindingVersion(projectId: string, type: 'scene' | 'shot', id: string) {
  const value: unknown[] = [target(projectId, type, id), storedTargetBindings(type, id), profiles(projectId)]
  const designId = type === 'scene' ? targetDesignId(projectId, type, id) : null
  if (designId) value.push({ design_id: designId })
  return resourceVersion(value)
}
function sceneVersion(projectId: string, scene: ScriptScene) { return resourceVersion([scene, all<Shot>('SELECT * FROM shots WHERE source_scene_id=? AND deleted_at IS NULL AND superseded_by IS NULL ORDER BY position, id', scene.id), targetBindings('scene', scene.id), profiles(projectId)]) }
function fail(message: string, statusCode = 422): never { throw Object.assign(new Error(message), { statusCode }) }

function referenceReadContext(projectId: string) {
  return { style: projectVisualStyle(projectId), imageIds: new Set(all<{ id: string }>("SELECT id FROM assets WHERE project_id=? AND deleted_at IS NULL AND kind='image'", projectId).map(asset => asset.id)) }
}
function profileReferenceMetadata(profile: VisualProfile, context: ReturnType<typeof referenceReadContext>) {
  const reference_assets = visualReferenceAssets(profile.id).filter(reference => reference.status === 'confirmed').map(reference => ({
    ...referenceSnapshot(reference), status: reference.status, is_default: reference.is_default,
    current: reference.revision === profile.revision && reference.style_version === context.style.version,
    asset_exists: context.imageIds.has(reference.asset_id), actual_image_inspected: false,
  }))
  const board_asset_exists = !!profile.board_asset_id && context.imageIds.has(profile.board_asset_id)
  const board_style_status = !profile.board_asset_id ? 'missing' : !profile.board_style_version ? 'unrecorded'
    : profile.board_style_version === context.style.version ? 'current' : 'needs_review'
  const reference_status = reference_assets.some(reference => reference.current && reference.asset_exists)
    || board_asset_exists && board_style_status !== 'needs_review' ? 'confirmed'
    : reference_assets.some(reference => reference.asset_exists && !reference.current) || board_asset_exists ? 'needs_review' : 'missing'
  return { reference_assets, board_asset_exists, board_style_status, reference_status, actual_image_inspected: false }
}
function readableBinding(binding: ReturnType<typeof targetBindings>[number], context: ReturnType<typeof referenceReadContext>) {
  if (!('reference_assets' in binding)) return binding
  const selected_reference_asset_ids = visualBindingReferenceAssetIds(binding)
  const missing_reference_asset_ids = selected_reference_asset_ids.filter(id => !context.imageIds.has(id))
  const stale = binding.reference_assets.length ? binding.reference_assets.some(reference => reference.revision !== binding.revision
    || !!reference.style_version && reference.style_version !== context.style.version)
    : !!binding.board_style_version && binding.board_style_version !== context.style.version
  return { ...binding, selected_reference_asset_ids, missing_reference_asset_ids,
    reference_status: !selected_reference_asset_ids.length || missing_reference_asset_ids.length ? 'missing' : stale ? 'needs_review' : 'confirmed',
    actual_image_inspected: false }
}

export function resourceTools(projectId: string) {
  const reads = new Map<string, string>()
  const deliveredRead = resourceReadTracker()
  const requireRead = (key: string, version: string) => { if (reads.get(key) !== version) fail('操作前请读取目标当前版本和相关参考资料') }
  return {
    execute(name: string, args: unknown): unknown {
      switch (name) {
        case 'read_visual_profiles': {
          const data = resourceSchemas.read_visual_profiles.parse(args), allProfiles = profiles(projectId)
          const referenceContext = referenceReadContext(projectId)
          if (data.profile_ids?.some(id => !allProfiles.some(profile => profile.id === id))) fail('档案不存在或不属于当前项目')
          const selected = allProfiles.filter(profile => (!data.profile_ids || data.profile_ids.includes(profile.id)) && (!data.kind || profile.kind === data.kind) && (!data.query || [profile.name, profile.variant, profile.definition].some(value => value.includes(data.query!))))
          if (data.offset > selected.length) fail('读取位置超过档案数量')
          const found = selected.map(profile => {
            const version = resourceVersion(profile)
            return { ...profile, version, candidates: all('SELECT asset_id, archived FROM visual_profile_candidates WHERE profile_id=?', profile.id),
              scene_ids: all<{ scene_id: string }>('SELECT scene_id FROM scene_visual_bindings WHERE profile_id=?', profile.id).map(item => item.scene_id),
              shot_ids: all<{ shot_id: string }>('SELECT shot_id FROM shot_visual_bindings WHERE profile_id=?', profile.id).map(item => item.shot_id),
              ...profileReferenceMetadata(profile, referenceContext) }
          })
          const { cursor, ...query } = data
          const page = resourceReadPage({ projectId, tool: name, query, cursor,
            sections: [{ key: 'project_visual_style', values: [referenceContext.style], limit: 1, singleton: true }, { key: 'profiles', values: found, start: data.offset, limit: data.limit }],
            metadata: positions => ({ next_offset: positions[1]!.index, total: selected.length }) })
          for (const delivery of page.deliveries) if (delivery.section === 'profiles' && deliveredRead(page.source, delivery)) reads.set(`profile:${delivery.value.id}`, delivery.value.version as string)
          return page.result
        }
        case 'get_storyboard_context': {
          const data = resourceSchemas.get_storyboard_context.parse(args), scenes = all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position, id', projectId), shots = all<Shot>('SELECT * FROM shots WHERE project_id=? AND deleted_at IS NULL AND superseded_by IS NULL ORDER BY position, id', projectId)
          const referenceContext = referenceReadContext(projectId)
          if (data.scene_ids?.some(id => !scenes.some(scene => scene.id === id)) || data.shot_ids?.some(id => !shots.some(shot => shot.id === id))) fail('场次或镜头不存在或不属于当前项目')
          const objects: Array<{ type: 'scene'; value: ScriptScene } | { type: 'shot'; value: Shot }> = [
            ...scenes.filter(scene => (!data.scene_ids || data.scene_ids.includes(scene.id)) && (!data.shot_ids || shots.some(shot => data.shot_ids!.includes(shot.id) && shot.source_scene_id === scene.id))).map(value => ({ type: 'scene' as const, value })),
            ...shots.filter(shot => (!data.shot_ids || data.shot_ids.includes(shot.id)) && (!data.scene_ids || !!shot.source_scene_id && data.scene_ids.includes(shot.source_scene_id))).map(value => ({ type: 'shot' as const, value })),
          ]
          const sceneDesigns = sceneVisualDesignIds(projectId, objects.filter(item => item.type === 'scene').map(item => item.value.id))
          const designFor = (type: 'scene' | 'shot', value: ScriptScene | Shot) => type === 'scene' ? sceneDesigns.get(value.id) || null : (value as Shot).design_id || null
          const selectedDesigns = new Set(objects.map(({ type, value }) => designFor(type, value)))
          if (!objects.length && !data.scene_ids && !data.shot_ids) selectedDesigns.add(null)
          if (data.offset > objects.length) fail('读取位置超过场次/镜头数量')
          const found = objects.map(({ type, value }) => {
            const version = type === 'scene' ? sceneVersion(projectId, value as ScriptScene) : resourceVersion(value)
            const binding_version = bindingVersion(projectId, type, value.id)
            return { type, ...value, design_id: designFor(type, value), version, binding_version, bindings: targetBindings(type, value.id).map(binding => readableBinding(binding, referenceContext)) }
          })
          const catalog = profiles(projectId).filter(profile => selectedDesigns.has(profile.design_id || null)).map(profile => ({ id: profile.id, kind: profile.kind, name: profile.name,
            design_id: profile.design_id || null, variant: profile.variant, revision: profile.revision, board_asset_id: profile.board_asset_id, ...profileReferenceMetadata(profile, referenceContext) }))
          if (data.catalog_offset > catalog.length) fail('读取位置超过视觉目录数量')
          const { cursor, ...query } = data
          const page = resourceReadPage({ projectId, tool: name, query, cursor,
            sections: [{ key: 'project_visual_style', values: [referenceContext.style], limit: 1, singleton: true },
              { key: 'objects', values: found, start: data.offset, limit: data.limit }, { key: 'visual_profile_catalog', values: catalog, start: data.catalog_offset, limit: 20 }],
            metadata: positions => ({ next_offset: positions[1]!.index, total: objects.length, catalog_next_offset: positions[2]!.index, catalog_total: catalog.length, catalog_complete: positions[2]!.index === catalog.length }) })
          for (const delivery of page.deliveries) if (delivery.section === 'objects' && deliveredRead(page.source, delivery)) {
            reads.set(`${delivery.value.type}:${delivery.value.id}`, delivery.value.version as string)
            reads.set(`bindings:${delivery.value.type}:${delivery.value.id}`, delivery.value.binding_version as string)
          }
          return page.result
        }
        case 'propose_visual_profile_draft': {
          const data = resourceSchemas.propose_visual_profile_draft.parse(args)
          const changes: ResourceChange[] = data.profiles.map(item => {
            const original = item.profile_id ? required<VisualProfile>('visual_profiles', item.profile_id) : null
            if (original && original.project_id !== projectId) fail('档案不属于当前项目')
            if (original) { if (item.base_version !== resourceVersion(original)) fail('档案版本已变化，请重新读取'); requireRead(`profile:${original.id}`, item.base_version) }
            else if (item.base_version) fail('新档案不能提供已有版本')
            if (item.profile.scene_ids.some(id => target(projectId, 'scene', id).project_id !== projectId)) fail('来源场次不属于项目')
            if (original && item.profile.scene_ids.length) fail('已有档案的场次引用请使用绑定修改草稿，避免隐式同步')
            const value = scopedProfileValue(projectId, item.profile, original)
            const duplicate = profiles(projectId).find(profile => profile.id !== original?.id && profile.kind === value.kind && profile.name === value.name && profile.variant === value.variant)
            if (duplicate) fail('同名同版本档案已存在，请读取后修订')
            return { type: 'visual_profile', id: original?.id || newId(), title: `${value.name} · ${value.variant}`, base_version: original ? resourceVersion(original) : '', original: original ? profileValue(original) : null, value }
          })
          if (new Set(changes.map(change => change.id)).size !== changes.length || new Set(changes.map(change => change.type === 'visual_profile' ? JSON.stringify([change.value.kind, change.value.name, change.value.variant]) : '')).size !== changes.length) fail('同一档案不能重复提交')
          return { summary: data.summary, changes }
        }
        case 'propose_visual_binding_patch': {
          const data = resourceSchemas.propose_visual_binding_patch.parse(args)
          const changes: ResourceChange[] = data.targets.map(item => {
            const current = target(projectId, item.target_type, item.target_id)
            if (item.base_version !== bindingVersion(projectId, item.target_type, item.target_id)) fail('绑定或设定版本已变化，请重新读取')
            requireRead(`bindings:${item.target_type}:${item.target_id}`, item.base_version)
            for (const binding of checkedTargetBindings(projectId, item.target_type, item.target_id, item.bindings)) requireRead(`profile:${binding.profile.id}`, resourceVersion(binding.profile))
            if (item.refresh_profile_ids.some(id => !item.bindings.some(binding => binding.profile_id === id))) fail('只能刷新本次保留的绑定')
            if (item.target_type === 'scene' && item.refresh_profile_ids.length) fail('场次绑定无需刷新镜头版本')
            return { type: 'visual_binding', id: current.id, title: 'heading' in current ? current.heading : current.title, target_type: item.target_type, base_version: item.base_version,
              original: targetBindings(item.target_type, item.target_id).map(binding => ({ profile_id: binding.profile_id, required: !!binding.required,
                ...('usage' in binding ? { usage: binding.usage } : {}) })), value: item.bindings, refresh_profile_ids: item.refresh_profile_ids }
          })
          if (new Set(changes.map(change => `${change.type}:${'target_type' in change ? change.target_type : ''}:${change.id}`)).size !== changes.length) fail('绑定目标不可重复')
          return { summary: data.summary, changes }
        }
        case 'propose_shot_plan': {
          const data = resourceSchemas.propose_shot_plan.parse(args), changes: ResourceChange[] = []
          if (new Set(data.scenes.map(item => item.scene_id)).size !== data.scenes.length) fail('拆镜场次不可重复')
          for (const item of data.scenes) {
            const scene = target(projectId, 'scene', item.scene_id) as ScriptScene
            if (item.base_version !== sceneVersion(projectId, scene)) fail('场次或分镜上下文已变化，请重新读取')
            requireRead(`scene:${scene.id}`, item.base_version)
            if (item.shots.length > scene.duration || item.shots.reduce((sum, shot) => sum + shot.duration, 0) !== scene.duration) fail('分镜数量与时长必须符合源场次时长')
            for (const shot of item.shots) changes.push({ type: 'new_shot', id: newId(), title: shot.title, source_scene_id: scene.id, base_version: item.base_version, original: null, value: shot })
          }
          return { summary: data.summary, changes }
        }
        case 'propose_shot_patch': {
          const data = resourceSchemas.propose_shot_patch.parse(args)
          if (new Set(data.shots.map(item => item.shot_id)).size !== data.shots.length) fail('镜头修改不可重复')
          const changes: ResourceChange[] = data.shots.map(item => {
            const shot = target(projectId, 'shot', item.shot_id) as Shot
            if (item.base_version !== resourceVersion(shot)) fail('镜头已变化，请重新读取')
            requireRead(`shot:${shot.id}`, item.base_version)
            return { type: 'shot', id: shot.id, title: shot.title, base_version: item.base_version, original: shotValue(shot), value: shotDraftValue.parse({ ...shotValue(shot), ...item.changes }) }
          })
          return { summary: data.summary, changes }
        }
        default: fail('未知视觉或分镜工具')
      }
    },
  }
}

export function resourceDraftImpacts(projectId: string, changes: ResourceChange[]): DraftImpact[] {
  const impacts: DraftImpact[] = []
  for (const change of changes) if (change.type === 'visual_profile' && change.original) {
    for (const binding of all<{ shot_id: string }>('SELECT shot_id FROM shot_visual_bindings WHERE profile_id=?', change.id)) {
      const shot = required<Shot>('shots', binding.shot_id)
      if (shot.project_id === projectId) impacts.push({ kind: 'shot', id: shot.id, title: shot.title, basis: 'visual_binding', explanation: '设定修订后已有镜头保留原绑定快照，可另行核对并明确刷新版本' })
    }
  }
  return [...new Map(impacts.map(item => [`${item.kind}:${item.id}`, item])).values()].slice(0, 100)
}

export function validateResourceChanges(projectId: string, changes: ResourceChange[]) {
  const newShotGroups = new Map<string, number>()
  for (const change of changes) {
    if (change.type === 'visual_profile') {
      const current = one<VisualProfile>('SELECT * FROM visual_profiles WHERE id=?', change.id)
      if (change.original ? !current || current.project_id !== projectId || resourceVersion(current) !== change.base_version : !!current) fail('视觉设定原文已变化，请重新读取后修订', 409)
      change.value = scopedProfileValue(projectId, change.value, current || null)
      const duplicate = profiles(projectId).find(profile => profile.id !== change.id && profile.kind === change.value.kind && profile.name === change.value.name && profile.variant === change.value.variant)
      if (duplicate) fail('同名同版本档案已存在', 409)
      for (const id of change.value.scene_ids) target(projectId, 'scene', id)
      if (new Set(change.value.scene_ids).size !== change.value.scene_ids.length) fail('场次引用不可重复')
      if (current && change.value.scene_ids.length) fail('已有档案的场次引用请使用绑定修改草稿')
      if (current?.asset_task_id && one<AssetTask>('SELECT * FROM asset_tasks WHERE id=?', current.asset_task_id)?.status === 'generating') fail('信息图正在生成，完成后可修改设定')
    } else if (change.type === 'shot') {
      shotDraftValue.parse(change.value)
      if (resourceVersion(target(projectId, 'shot', change.id)) !== change.base_version) fail('镜头原文已变化，请重新读取后修订', 409)
    } else if (change.type === 'new_shot') {
      shotDraftValue.parse(change.value)
      if (one('SELECT 1 FROM shots WHERE id=?', change.id)) fail('分镜已经创建', 409)
      const scene = target(projectId, 'scene', change.source_scene_id) as ScriptScene
      if (sceneVersion(projectId, scene) !== change.base_version) fail('源场次或已有分镜已变化，请重新读取', 409)
      newShotGroups.set(scene.id, (newShotGroups.get(scene.id) || 0) + change.value.duration)
    } else {
      if (bindingVersion(projectId, change.target_type, change.id) !== change.base_version) fail('引用或档案版本已变化，请重新读取', 409)
      checkedTargetBindings(projectId, change.target_type, change.id, bindings.parse(change.value))
      if (change.refresh_profile_ids.some(id => !change.value.some(binding => binding.profile_id === id))) fail('只能刷新本次保留的绑定')
    }
  }
  const names = changes.filter(change => change.type === 'visual_profile').map(change => JSON.stringify([change.value.kind, change.value.name, change.value.variant]))
  if (new Set(names).size !== names.length) fail('同名同版本档案不能重复提交')
  const visualChanges = changes.filter(change => change.type === 'visual_profile')
  resolveVisualProfileDrafts(projectId, visualChanges.map(change => profileInput.parse(change.value)), visualChanges.map(change => change.id))
  for (const [id, duration] of newShotGroups) if ((target(projectId, 'scene', id) as ScriptScene).duration !== duration) fail('新增镜头总时长与源场次不一致')
}

/** Caller wraps validation and all writes in the existing draft transaction. */
export function applyResourceChanges(projectId: string, changes: ResourceChange[]) {
  const timestamp = now()
  const visualChanges = changes.filter(change => change.type === 'visual_profile')
  const resolved = resolveVisualProfileDrafts(projectId, visualChanges.map(change => profileInput.parse(change.value)), visualChanges.map(change => change.id))
  const resolvedProfiles = new Map(resolved.map(value => [value.id, value]))
  // Persist every new base first, so forward draft relations are valid foreign keys.
  for (const change of visualChanges) if (!change.original) {
    const { input } = resolvedProfiles.get(change.id)!
    run(`INSERT INTO visual_profiles (id, project_id, kind, name, variant, definition, view_requirements, design_id, source_draft_key, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      change.id, projectId, input.kind, input.name, input.variant, input.definition, input.view_requirements, input.design_id || null, input.draft_key || null, timestamp, timestamp)
  }
  for (const change of changes) {
    if (change.type === 'visual_profile') {
      const { input, base_profile_id, state_delta } = resolvedProfiles.get(change.id)!
      const { scene_ids, design_id: _designId, draft_key: _draftKey, base_draft_key: _baseDraftKey, ...value } = input
      if (change.original) updateVisualProfile(change.id, { ...value, base_profile_id, state_delta, expected_revision: required<VisualProfile>('visual_profiles', change.id).revision })
      else {
        run('UPDATE visual_profiles SET base_profile_id=?, state_delta=? WHERE id=?', base_profile_id, state_delta, change.id)
        for (const sceneId of scene_ids) run('INSERT INTO scene_visual_bindings VALUES (?, ?, 1)', sceneId, change.id)
      }
    } else if (change.type === 'shot') {
      const value = change.value
      const previous = required<Shot>('shots', change.id)
      run('UPDATE shots SET title=?, prompt=?, image_prompt=?, video_prompt=?, duration=?, start_state=?, end_state=?, cut_note=? WHERE id=? AND project_id=?', value.title, value.prompt, value.image_prompt, value.video_prompt, value.duration, value.start_state, value.end_state, value.cut_note, change.id, projectId)
      markShotContinuityEdited(previous, Object.entries(value).filter(([key, next]) => previous[key as keyof Shot] !== next).map(([key]) => key))
      // A director's visual rewrite cannot silently cancel confirmed speech.
      // Retained audio is a review baseline, independently revised by the creator.
    } else if (change.type === 'new_shot') {
      const value = change.value
      const position = one<{ position: number }>('SELECT COALESCE(MAX(position), -1)+1 AS position FROM shots WHERE project_id=? AND superseded_by IS NULL', projectId)!.position
      run(`INSERT INTO shots (id, project_id, position, title, prompt, image_prompt, video_prompt, duration, source_scene_id, start_state, end_state, cut_note, created_at, design_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        change.id, projectId, position, value.title, value.prompt, value.image_prompt, value.video_prompt, value.duration, change.source_scene_id, value.start_state, value.end_state, value.cut_note, timestamp, sceneVisualDesignIds(projectId, [change.source_scene_id]).get(change.source_scene_id) || null)
      inheritSceneVisualBindings(change.id, change.source_scene_id)
    } else {
      const selected = checkedTargetBindings(projectId, change.target_type, change.id, change.value)
      if (change.target_type === 'scene') {
        run(`DELETE FROM scene_visual_bindings WHERE scene_id=? AND profile_id IN
          (SELECT id FROM visual_profiles WHERE project_id=? AND design_id IS ?)`, change.id, projectId, targetDesignId(projectId, 'scene', change.id))
        for (const binding of selected) run('INSERT INTO scene_visual_bindings VALUES (?, ?, ?)', change.id, binding.profile.id, Number(binding.required))
      } else {
        const previous = targetBindings('shot', change.id)
        for (const old of previous) {
          const protectedSelection = 'sync_mode' in old && old.sync_mode === 'locked'
            || 'reference_selection' in old && old.reference_selection === 'manual'
          if (!change.value.some(binding => binding.profile_id === old.profile_id)
            || change.refresh_profile_ids.includes(old.profile_id) && !protectedSelection) {
            run('DELETE FROM shot_visual_bindings WHERE shot_id=? AND profile_id=?', change.id, old.profile_id)
          }
        }
        for (const binding of selected) {
          const old = previous.find(item => item.profile_id === binding.profile.id)
          const settings = old && 'revision' in old ? { sync_mode: old.sync_mode, reference_selection: old.reference_selection, reference_view: old.reference_view } : {}
          insertShotBinding(change.id, binding.profile, binding.required, binding.reference_asset_ids,
            binding.usage || (old && 'usage' in old ? old.usage : undefined) || 'both', false, settings)
          run('UPDATE shot_visual_bindings SET required=?, usage=COALESCE(?, usage) WHERE shot_id=? AND profile_id=?', Number(binding.required), binding.usage || null, change.id, binding.profile.id)
        }
      }
    }
  }
}
