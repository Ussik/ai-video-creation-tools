import { createHash } from 'node:crypto'
import { realpath, stat, unlink } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { z } from 'zod'
import { all, dataDir, db, mediaDir, newId, now, one, required, run } from '../../infrastructure/database/db.js'
import type { Asset, Job, Model, Shot } from '../../infrastructure/database/db.js'
import type { VisualProfile } from './visual-profiles.js'
import { assertStyleVersion, projectVisualStyle, referenceStyleWarnings } from './project-visual-style.js'
import { withProjectStyle, projectStyleTemplateError } from '@video-studio/shared/visuals/visual-style'
import { imageReferenceConfigError } from '@video-studio/shared/media/image-reference-config'
import { visualReferenceViews, visualReferencePurposes, visualReferenceViewLabels, visualReferencePurposeLabels } from '@video-studio/shared/visuals/visual-reference-types'
import type { VisualReferenceAsset, VisualReferenceSnapshot } from '@video-studio/shared/visuals/visual-reference-types'
import { recommendVisualReferences } from '@video-studio/shared/visuals/visual-reference-selection'

type ReferenceRow = Omit<VisualReferenceAsset, 'is_default'> & { is_default: number }
const revisionInput = z.object({ expected_revision: z.number().int().min(1), expected_style_version: z.string().regex(/^[a-f0-9]{64}$/) })
const descriptionInput = z.object({ view: z.enum(visualReferenceViews), purpose: z.enum(visualReferencePurposes), label: z.string().trim().max(120).default('') })
const referenceInput = revisionInput.extend(descriptionInput.shape).extend({
  asset_id: z.string().min(1), status: z.enum(['candidate', 'confirmed']).default('candidate'), is_default: z.boolean().default(false),
}).strict()
const patchInput = revisionInput.extend({ status: z.enum(['candidate', 'confirmed', 'archived']).optional(), is_default: z.boolean().optional(), label: z.string().trim().max(120).optional() }).strict()
const cropInput = revisionInput.extend(descriptionInput.shape).extend({ asset_id: z.string().min(1), crop: z.object({
  x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1),
  width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1),
}).strict().refine(rect => rect.x + rect.width <= 1 && rect.y + rect.height <= 1, '裁剪区域必须位于原图内') }).strict()
const previewInput = revisionInput.extend(descriptionInput.shape).extend({ model_id: z.string().min(1),
  reference_asset_ids: z.array(z.string().min(1)).max(10).default([]), prompt_append: z.string().trim().max(10000).optional(),
}).strict()
const generateInput = previewInput.extend({ reference_signature: z.string().regex(/^[a-f0-9]{64}$/),
  prompt: z.string().trim().min(1).max(80000), ratio: z.string().trim().min(1).max(20),
  resolution: z.string().max(80).nullable().optional(), quality: z.string().max(80).nullable().optional(),
  clarity: z.string().max(80).nullable().optional(), background: z.string().max(80).nullable().optional(),
  candidate_count: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(1),
}).strict()
const snapshotSchema = z.object({ id: z.string().min(1), asset_id: z.string().min(1), view: z.enum(visualReferenceViews),
  purpose: z.enum(visualReferencePurposes), label: z.string(), revision: z.number().int().min(1), style_version: z.string().nullable() })
function invalid(message: string, statusCode = 422): never { throw Object.assign(new Error(message), { statusCode }) }
function touch(profile: VisualProfile) {
  const timestamp = now()
  run('UPDATE visual_profiles SET updated_at=? WHERE id=?', timestamp, profile.id)
  run('UPDATE projects SET updated_at=? WHERE id=?', timestamp, profile.project_id)
}
function checkedProfile(id: string, input: z.infer<typeof revisionInput>) {
  const profile = required<VisualProfile>('visual_profiles', id)
  if (input.expected_revision !== profile.revision) invalid('设定档案已更新，请刷新后重新检查参考资产', 409)
  const style = projectVisualStyle(profile.project_id)
  assertStyleVersion(style, input.expected_style_version)
  return { profile, style }
}
function checkedImage(profile: VisualProfile, id: string) {
  const asset = required<Asset>('assets', id)
  if (asset.project_id !== profile.project_id || asset.kind !== 'image') invalid('参考资产必须是当前项目的图片')
  return asset
}

export function visualReferenceAssets(profileId: string): VisualReferenceAsset[] {
  return all<ReferenceRow>('SELECT * FROM visual_profile_reference_assets WHERE profile_id=? ORDER BY created_at, id', profileId)
    .map(row => ({ ...row, is_default: !!row.is_default }))
}
export function referenceSnapshot(reference: VisualReferenceAsset): VisualReferenceSnapshot {
  const { id, asset_id, view, purpose, label, revision, style_version } = reference
  return { id, asset_id, view, purpose, label, revision, style_version }
}
export function parseVisualReferenceSnapshots(value: unknown): VisualReferenceSnapshot[] {
  if (value === undefined || value === null) return []
  try { return z.array(snapshotSchema).max(10).parse(typeof value === 'string' ? JSON.parse(value) : value) }
  catch { return invalid('镜头参考资产记录损坏，请刷新镜头引用') }
}
export function normalizeVisualBinding<T extends { reference_assets?: unknown }>(binding: T): Omit<T, 'reference_assets'> & { reference_assets: VisualReferenceSnapshot[] } {
  return { ...binding, reference_assets: parseVisualReferenceSnapshots(binding.reference_assets) }
}
/** Explicit selection preserves the creator's order and must match the bound definition. */
export function selectedVisualReferenceSnapshots(profile: VisualProfile, ids: string[], revision = profile.revision, retained: VisualReferenceSnapshot[] = []): VisualReferenceSnapshot[] {
  if (ids.length > 10 || new Set(ids).size !== ids.length) invalid('参考资产不能重复且最多选择 10 张')
  const style = projectVisualStyle(profile.project_id)
  return ids.map(id => {
    const frozen = retained.find(reference => reference.id === id)
    if (frozen) {
      if (frozen.revision !== revision) invalid('镜头参考资产与设定快照版本不一致，请刷新引用', 409)
      checkedImage(profile, frozen.asset_id)
      return { ...frozen }
    }
    const reference = one<ReferenceRow>('SELECT * FROM visual_profile_reference_assets WHERE id=?', id)
    if (!reference || reference.profile_id !== profile.id) invalid('参考资产不属于此设定')
    if (reference.revision !== revision || revision !== profile.revision) invalid('参考资产与镜头设定版本不一致，请先刷新绑定', 409)
    if (reference.status !== 'confirmed') invalid('只能选择已确认的独立参考资产')
    if (reference.style_version !== style.version) invalid('项目画风已更新，请核对并重新生成独立参考资产', 409)
    checkedImage(profile, reference.asset_id)
    return referenceSnapshot({ ...reference, is_default: !!reference.is_default })
  })
}
function registerReference(profile: VisualProfile, input: {
  asset_id: string; view: VisualReferenceAsset['view']; purpose: VisualReferenceAsset['purpose']; label: string;
  revision: number; style_version: string | null; status: VisualReferenceAsset['status']; is_default?: boolean;
  source_asset_id?: string | null; source_job_id?: string | null;
}) {
  checkedImage(profile, input.asset_id)
  const previous = one<ReferenceRow>('SELECT * FROM visual_profile_reference_assets WHERE profile_id=? AND revision=? AND asset_id=?', profile.id, input.revision, input.asset_id)
  if (previous) {
    if (previous.view !== input.view || previous.purpose !== input.purpose) invalid('同一图片已登记其他角度或用途，请使用对应条目')
    if (previous.style_version !== input.style_version) invalid('此图片已登记于旧画风，请按当前画风重新制作参考图', 409)
    if (previous.status === 'archived') invalid('此参考图已归档，请先在已归档列表中恢复为候选', 409)
    return previous.id
  }
  if (input.is_default && input.status !== 'confirmed') invalid('只有已确认的参考资产可设为默认')
  const id = newId(), timestamp = now()
  if (input.is_default) run('UPDATE visual_profile_reference_assets SET is_default=0, updated_at=? WHERE profile_id=? AND revision=? AND view=? AND purpose=?', timestamp, profile.id, input.revision, input.view, input.purpose)
  run(`INSERT INTO visual_profile_reference_assets
    (id,profile_id,asset_id,revision,style_version,view,purpose,label,status,is_default,source_asset_id,source_job_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, profile.id, input.asset_id, input.revision, input.style_version, input.view, input.purpose, input.label,
    input.status, Number(!!input.is_default), input.source_asset_id || null, input.source_job_id || null, timestamp, timestamp)
  if (input.status === 'confirmed') {
    run("UPDATE visual_profiles SET definition_status='ready' WHERE id=?", profile.id)
    fillUnresolvedReferenceBindings(profile)
  }
  touch(profile)
  return id
}
function fillUnresolvedReferenceBindings(profile: VisualProfile) {
  const style = projectVisualStyle(profile.project_id), references = visualReferenceAssets(profile.id)
  const shots = all<Shot>(`SELECT s.* FROM shots s JOIN shot_visual_bindings b ON b.shot_id=s.id
    WHERE b.profile_id=? AND b.revision=? AND b.board_asset_id IS NULL AND b.reference_assets='[]'`, profile.id, profile.revision)
  for (const shot of shots) {
    const selected = recommendVisualReferences(profile, references, [shot.image_prompt, shot.prompt, shot.start_state].filter(Boolean).join('\n'), style.version).map(referenceSnapshot)
    if (selected.length) run("UPDATE shot_visual_bindings SET reference_assets=? WHERE shot_id=? AND profile_id=? AND revision=? AND board_asset_id IS NULL AND reference_assets='[]'", JSON.stringify(selected), shot.id, profile.id, profile.revision)
  }
}

/** The worker registers the request's immutable version, including late results from old revisions. */
export function registerGeneratedVisualReference(job: Job, assetId: string) {
  let request: Record<string, unknown>
  try { request = JSON.parse(job.request) } catch { return }
  if (request.visual_reference_generation !== true || typeof request.visual_profile_id !== 'string') return
  const profile = one<VisualProfile>('SELECT * FROM visual_profiles WHERE id=?', request.visual_profile_id)
  if (!profile || profile.project_id !== job.project_id) return
  const metadata = z.object({ visual_profile_revision: z.number().int().min(1), visual_reference_view: z.enum(visualReferenceViews),
    visual_reference_purpose: z.enum(visualReferencePurposes), visual_reference_label: z.string().max(120), project_style_version: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(request)
  if (!metadata.success) return
  registerReference(profile, { asset_id: assetId, revision: metadata.data.visual_profile_revision, style_version: metadata.data.project_style_version,
    view: metadata.data.visual_reference_view, purpose: metadata.data.visual_reference_purpose, label: metadata.data.visual_reference_label,
    status: 'candidate', source_job_id: job.id })
}

const singleImageRules = '只输出一张单视角参考图片：同一对象、同一版本、单一主体。人物图只出现一个人物；场景图只表现一个连贯空间；道具图只出现一个主要道具。禁止多视角拼版、三视图、分栏、信息图、文字、标签、色板、水印、无关人物和装饰。'
function singleReferencePrompt(profile: VisualProfile, input: z.infer<typeof previewInput>) {
  return `生成影视${{ character: '人物', location: '场景', prop: '道具' }[profile.kind]}独立参考资产。对象：${profile.name}；版本：${profile.variant}；设定修订：${profile.revision}。\n` +
    `本张视角：${visualReferenceViewLabels[input.view]}；用途：${visualReferencePurposeLabels[input.purpose]}${input.label ? `；说明：${input.label}` : ''}。\n固定设定：\n${profile.definition}\n` +
    `清楚展示本张视角与用途需要的外形、比例、配色和材质，不生成其他视角，不增加冲突设定。${singleImageRules}` +
    (input.prompt_append ? `\n本次补充要求：\n${input.prompt_append}` : '')
}
function prepareReference(profile: VisualProfile, input: z.infer<typeof previewInput>) {
  const { style } = checkedProfile(profile.id, input)
  const model = required<Model>('models', input.model_id)
  if (!model.enabled || model.archived || model.modality !== 'image') invalid('请选择已启用的图片模型')
  if (new Set(input.reference_asset_ids).size !== input.reference_asset_ids.length) invalid('参考图片不能重复选择')
  const references = input.reference_asset_ids.map(id => checkedImage(profile, id))
  const mode = references.length ? 'reference' as const : 'text' as const
  const settings = JSON.parse(model.settings) as Record<string, unknown>
  const issue = imageReferenceConfigError(settings, references.length, mode) || projectStyleTemplateError(style, settings, mode)
  if (issue) invalid(issue)
  const signature = createHash('sha256').update(JSON.stringify({ profile: [profile.id, profile.revision, profile.definition],
    view: input.view, purpose: input.purpose, label: input.label, prompt_append: input.prompt_append || '',
    references: references.map(asset => [asset.id, asset.path, asset.created_at]), model: [model.id, model.settings], style: style.version })).digest('hex')
  const context = references.length ? `\n参考图片按提交顺序编号：${references.map((asset, index) => `图片${index + 1}：${asset.filename}`).join('；')}。\n参考仅用于保持对应对象的一致性，不复制原图拼版、文字、标签和其他视角。` : ''
  return { prompt: withProjectStyle(singleReferencePrompt(profile, input) + context, style), mode,
    reference_asset_ids: input.reference_asset_ids, reference_signature: signature, project_style_version: style.version,
    project_visual_style: style, style_warnings: referenceStyleWarnings(profile.project_id, input.reference_asset_ids, style) }
}
type ReferenceContext = {
  profileResponse: (profile: VisualProfile) => unknown
  generateReference?: (profile: VisualProfile, input: Record<string, unknown>, metadata: Record<string, unknown>, candidateCount: number) => Promise<unknown> | unknown
}
export function registerVisualReferenceRoutes(app: FastifyInstance, context: ReferenceContext) {
  const response = (id: string) => context.profileResponse(required<VisualProfile>('visual_profiles', id))
  app.post('/api/visual-profiles/:id/reference-assets', async request => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params), input = referenceInput.parse(request.body)
    return db.transaction(() => {
      const { profile, style } = checkedProfile(id, input)
      registerReference(profile, { ...input, revision: profile.revision, style_version: style.version })
      return response(id)
    })()
  })
  app.patch('/api/visual-profiles/:id/reference-assets/:referenceId', async request => {
    const { id, referenceId } = z.object({ id: z.string().min(1), referenceId: z.string().min(1) }).parse(request.params), input = patchInput.parse(request.body)
    return db.transaction(() => {
      const { profile, style } = checkedProfile(id, input)
      const reference = one<ReferenceRow>('SELECT * FROM visual_profile_reference_assets WHERE id=?', referenceId)
      if (!reference || reference.profile_id !== profile.id) invalid('参考资产不属于此设定')
      const status = input.status || reference.status, isDefault = input.is_default ?? !!reference.is_default
      if (status !== 'archived' && (reference.revision !== profile.revision || reference.style_version !== style.version)) invalid('此参考资产属于旧设定或旧画风，请生成当前版本参考', 409)
      if (input.is_default && status !== 'confirmed') invalid('只有已确认的参考资产可设为默认')
      if (isDefault && status === 'confirmed') run('UPDATE visual_profile_reference_assets SET is_default=0, updated_at=? WHERE profile_id=? AND revision=? AND view=? AND purpose=? AND id<>?', now(), id, reference.revision, reference.view, reference.purpose, reference.id)
      run('UPDATE visual_profile_reference_assets SET status=?, is_default=?, label=?, updated_at=? WHERE id=?', status, Number(status === 'confirmed' && isDefault), input.label ?? reference.label, now(), reference.id)
      if (status === 'confirmed') {
        run("UPDATE visual_profiles SET definition_status='ready' WHERE id=?", id)
        fillUnresolvedReferenceBindings(profile)
      }
      touch(profile)
      return response(id)
    })()
  })
  app.post('/api/visual-profiles/:id/reference-crop', async request => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params), input = cropInput.parse(request.body)
    const { profile, style } = checkedProfile(id, input), source = checkedImage(profile, input.asset_id)
    let file: string
    try {
      file = await realpath(source.path)
      const directory = await realpath(dataDir), local = relative(directory, file)
      if (local.startsWith(`..${sep}`) || local === '..' || local.startsWith(sep)) invalid('原图文件不在当前项目媒体目录')
      if (!(await stat(file)).isFile()) invalid('原图文件不可读取')
    } catch (error) { if ((error as { statusCode?: number }).statusCode) throw error; return invalid('原图文件不存在或无法读取') }
    let image: Buffer, width: number, height: number
    try {
      const decoder = sharp(file, { limitInputPixels: 80_000_000 }), metadata = await decoder.metadata()
      if (!['png', 'jpeg', 'webp', 'avif', 'heif', 'tiff'].includes(metadata.format || '') || (metadata.pages || 1) > 1) invalid('原图必须是可读取的静态图片')
      const decoded = await decoder.rotate().png().toBuffer({ resolveWithObject: true })
      image = decoded.data; width = decoded.info.width; height = decoded.info.height
    } catch (error) { if ((error as { statusCode?: number }).statusCode) throw error; return invalid('原图无法解码为图片') }
    const left = Math.floor(input.crop.x * width), top = Math.floor(input.crop.y * height)
    const cropWidth = Math.floor(input.crop.width * width), cropHeight = Math.floor(input.crop.height * height)
    if (cropWidth < 1 || cropHeight < 1 || left + cropWidth > width || top + cropHeight > height) invalid('裁剪区域至少需要一个像素且必须位于原图内')
    const assetId = newId(), filename = `reference-${assetId}.png`, path = join(mediaDir, filename)
    try {
      await sharp(image).extract({ left, top, width: cropWidth, height: cropHeight }).png().toFile(path)
      return db.transaction(() => {
        checkedProfile(id, input)
        run(`INSERT INTO assets (id,project_id,shot_id,kind,filename,path,source,model_id,prompt,remote_url,created_at)
          VALUES (?,?,NULL,'image',?,?,'generated',NULL,NULL,NULL,?)`, assetId, profile.project_id, filename, path, now())
        registerReference(profile, { asset_id: assetId, revision: profile.revision, style_version: style.version, view: input.view, purpose: input.purpose,
          label: input.label, status: 'candidate', source_asset_id: source.id })
        return response(id)
      })()
    } catch (error) { await unlink(path).catch(() => undefined); throw error }
  })
  app.post('/api/visual-profiles/:id/reference-preview', async request => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params), input = previewInput.parse(request.body)
    return prepareReference(required<VisualProfile>('visual_profiles', id), input)
  })
  app.post('/api/visual-profiles/:id/reference-generate', async request => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params), input = generateInput.parse(request.body)
    const profile = required<VisualProfile>('visual_profiles', id), preview = prepareReference(profile, input)
    if (preview.reference_signature !== input.reference_signature) invalid('参考设定、图片或模型配置已更新，请重新预览', 409)
    if (!context.generateReference) invalid('参考资产生成服务不可用')
    const identity = `固定对象：${profile.name}（${profile.variant}）；固定设定：${profile.definition}。本张只能展示${visualReferenceViewLabels[input.view]}，用于${visualReferencePurposeLabels[input.purpose]}。`
    const prompt = input.prompt + (!input.prompt.includes(profile.definition) || !input.prompt.includes(visualReferenceViewLabels[input.view]) ? `\n\n${identity}` : '') +
      (input.prompt.includes(singleImageRules) ? '' : `\n\n${singleImageRules}`)
    return context.generateReference(profile, { model_id: input.model_id, prompt, source_artifact_type: profile.kind,
      mode: preview.mode, reference_asset_ids: preview.reference_asset_ids, project_style_version: preview.project_style_version,
      ratio: input.ratio, resolution: input.resolution ?? null, quality: input.quality ?? null, clarity: input.clarity ?? null, background: input.background ?? null }, {
      visual_reference_generation: true, visual_profile_id: profile.id, visual_profile_revision: profile.revision,
      visual_reference_view: input.view, visual_reference_purpose: input.purpose, visual_reference_label: input.label,
    }, input.candidate_count)
  })
}
