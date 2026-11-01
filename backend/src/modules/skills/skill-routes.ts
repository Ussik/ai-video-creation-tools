import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { projectVisualStyle } from '../visuals/project-visual-style.js'
import { projectStyleInstructions, withProjectStyle } from '@video-studio/shared/visuals/visual-style'
import { all, db, now, required, run } from '../../infrastructure/database/db.js'
import type { Asset, Model, Project, Shot } from '../../infrastructure/database/db.js'
import { visualProfileTextContext, type VisualProfile } from '../visuals/visual-profiles.js'
import { generateStructuredOutput, type OutputContract } from '../generation/model-output.js'
import { scopedVisualReferenceAssetIds, videoReferenceManifest } from '@video-studio/shared/media/video-reference-manifest'
import { videoReferenceUsages, videoReferenceUsageIssue, videoReferenceUsageInstructions, videoReferenceShotGuidance } from '@video-studio/shared/media/video-reference-usage'
import { visualBindingsForModality, type VisualBindingUsage } from '@video-studio/shared/visuals/visual-binding-usage'
import { visualGenerationPrompt } from '@video-studio/shared/visuals/visual-prompt'
import { extractPromptBody, getManagedPromptBlocks, restoreManagedPromptBlocks, stripManagedPromptBlocks, validateManagedPromptDocument } from '@video-studio/shared/visuals/prompt-document'
import { promptParameterConflictMessage } from '@video-studio/shared/visuals/prompt-parameter-conflicts'
import { resolveVisualProfileDisplayText } from '@video-studio/shared/visuals/visual-profile-display-text'
import { withVisualProfilePrompt } from '@video-studio/shared/visuals/visual-profile-prompt'
import { resolvePromptReferences, tokenizePromptReferenceNumbers } from '@video-studio/shared/visuals/prompt-references'
import { parseVisualReferenceSnapshots } from '../visuals/visual-reference-assets.js'
import { enrichExplicitReferenceBindings } from '@video-studio/shared/visuals/explicit-reference-context'
import { explicitReferenceProfiles } from '../visuals/explicit-reference-context.js'
import { seedance2PromptGuidance } from '../generation/seedance-prompt.js'
import type { TextImageInput } from '../../infrastructure/providers/text-image-input.js'
import { localImagePixels } from '../canvas/image-prompt-analysis.js'
import { dialoguePreservation } from '@video-studio/shared/media/video-prompt-checks'
import { videoContentReviewSchema, videoContentReviewInstructions, videoPromptDiagnostics } from './video-prompt-checks.js'
import { videoReferenceConfigError } from '@video-studio/shared/media/video-reference-config'
import { normalizeSeedance25Request } from '@video-studio/shared/media/seedance25-request'
import { MAX_AUXILIARY_SKILLS } from '@video-studio/shared/skills/skill-limits'
import { addedReferenceCharacterIssue, compileRefinementReferences, referenceIdentityAssignmentIssue, requestedReferenceCharacters, type RefinementReferenceIdentity } from './prompt-refinement-references.js'
import { configureSkill, discoverRepository, initSkills, installedSkillDetail, installedSkills, installSkillBundle, loadSkillBundle,
  normalizeSkillRepo, removeInstalledSkill, searchSkillCatalog, skillStages, skillStageLabels, skillUpdateStatus,
  skillPolicy, setSkillDefault, resetProjectSkillDefault, skillIdsInput, syncInstalledSkills } from './skills.js'
import { resolveCreationSkillContext, type CreationSkillSelector } from './model-skill-selection.js'

const source = z.object({ repo: z.string().min(3).max(220), path: z.string().max(500).default('') }).strict()
const idParams = z.object({ id: z.string().min(1).max(100) })
function fail(message: string): never { throw Object.assign(new Error(message), { statusCode: 422 }) }

export function registerSkillRoutes(app: FastifyInstance, context: {
  generateText: (projectId: string, modelId: string, prompt: string, contract?: OutputContract, signal?: AbortSignal) => Promise<string>
  generateWithImages?: (projectId: string, modelId: string, prompt: string, images: TextImageInput[], contract?: OutputContract, signal?: AbortSignal) => Promise<string>
  selectSkills?: CreationSkillSelector
  fetcher?: typeof fetch
}) {
  initSkills()
  const fetcher = context.fetcher || fetch
  app.get('/api/skills', async () => ({ skills: installedSkills(), stages: skillStages.map(value => ({ value, label: skillStageLabels[value] })) }))
  const selection = z.object({ primary_id: z.string().min(1).nullable(), auxiliary_ids: z.array(z.string().min(1)).max(MAX_AUXILIARY_SKILLS).default([]) }).strict()
  const stageParams = z.object({ stage: z.enum(skillStages), id: z.string().min(1).optional() })
  app.get('/api/skills/defaults', async () => ({ policies: skillPolicy() }))
  app.put('/api/skills/defaults/:stage', async request => ({ policies: setSkillDefault(stageParams.parse(request.params).stage, selection.parse(request.body)) }))
  app.get('/api/projects/:id/skills/defaults', async request => ({ policies: skillPolicy(idParams.parse(request.params).id) }))
  app.put('/api/projects/:id/skills/defaults/:stage', async request => {
    const { id, stage } = stageParams.parse(request.params)
    return { policies: setSkillDefault(stage, selection.parse(request.body), id!) }
  })
  app.delete('/api/projects/:id/skills/defaults/:stage', async request => {
    const { id, stage } = stageParams.parse(request.params)
    return { policies: resetProjectSkillDefault(id!, stage) }
  })
  app.get('/api/skills/search', async request => {
    const input = z.object({ q: z.string().trim().min(2).max(120), offset: z.coerce.number().int().min(0).max(5000).default(0) }).parse(request.query)
    return searchSkillCatalog(input.q, input.offset, fetcher)
  })
  app.get('/api/skills/repositories', async () => all<{ repo: string; created_at: string }>('SELECT * FROM skill_repositories ORDER BY created_at'))
  app.post('/api/skills/repositories', async request => {
    const { repo } = z.object({ repo: z.string().min(3).max(220) }).strict().parse(request.body)
    const normalized = normalizeSkillRepo(repo)
    const skills = await discoverRepository(normalized, fetcher)
    run('INSERT OR IGNORE INTO skill_repositories (repo, created_at) VALUES (?, ?)', normalized, now())
    return { repo: normalized, skills }
  })
  app.delete('/api/skills/repositories', async request => {
    const { repo } = z.object({ repo: z.string().min(3).max(220) }).parse(request.query)
    run('DELETE FROM skill_repositories WHERE repo=?', normalizeSkillRepo(repo))
    return { ok: true }
  })
  app.get('/api/skills/repository', async request => {
    const { repo } = z.object({ repo: z.string().min(3).max(220) }).parse(request.query)
    return { skills: await discoverRepository(repo, fetcher) }
  })
  app.post('/api/skills/details', async request => {
    const input = source.parse(request.body)
    return loadSkillBundle(input.repo, input.path, fetcher)
  })
  app.post('/api/skills/install', async request => {
    const input = source.parse(request.body)
    return installSkillBundle(await loadSkillBundle(input.repo, input.path, fetcher))
  })
  app.post('/api/skills/sync', async () => syncInstalledSkills(fetcher))
  app.get('/api/skills/:id', async request => installedSkillDetail(idParams.parse(request.params).id))
  app.patch('/api/skills/:id', async request => {
    const { id } = idParams.parse(request.params)
    const input = z.object({ enabled: z.boolean(), stages: z.array(z.enum(skillStages)).max(5) }).strict().parse(request.body)
    return db.transaction(() => configureSkill(id, input.enabled, input.stages))()
  })
  app.delete('/api/skills/:id', async request => { removeInstalledSkill(idParams.parse(request.params).id); return { ok: true } })
  app.get('/api/skills/:id/update', async request => skillUpdateStatus(idParams.parse(request.params).id, fetcher))
  app.post('/api/skills/:id/update', async request => {
    const { id } = idParams.parse(request.params), current = installedSkillDetail(id)
    return installSkillBundle(await loadSkillBundle(current.repo, current.path, fetcher, true), id)
  })
  app.post('/api/projects/:id/skills/refine-prompt', async (request, reply) => {
    const controller = new AbortController()
    const abort = () => { if (!reply.raw.writableEnded) controller.abort(new DOMException('提示词整理已取消', 'AbortError')) }
    request.raw.once('aborted', abort)
    reply.raw.once('close', abort)
    try {
    const { id } = idParams.parse(request.params), project = required<Project>('projects', id)
    const input = z.object({
      model_id: z.string().min(1), stage: z.enum(['image_prompt', 'video_prompt']), prompt: z.string().trim().min(1).max(80_000),
      prompt_document: z.boolean().optional(),
      prompt_body: z.string().max(80_000).optional(), prompt_template: z.string().max(80_000).optional(),
      adjustment_request: z.string().trim().max(4000).default(''),
      check_video_content: z.boolean().default(false), analyze_reference_images: z.boolean().default(false),
      target_model_id: z.string().min(1).nullable().optional(), shot_id: z.string().min(1).nullable().optional(),
      profile_id: z.string().min(1).optional(),
      reference_asset_ids: z.array(z.string().min(1)).max(30).default([]),
      explicit_reference_asset_ids: z.array(z.string().min(1)).max(30).default([]),
      prompt_reference_overrides: z.record(z.string(), z.string().nullable()).optional(),
      storyboard_reference_asset_id: z.string().min(1).nullable().optional(),
      video_reference_usages: z.array(z.object({ asset_id: z.string().min(1), usage: z.enum(videoReferenceUsages) }).strict()).max(30).optional(),
      visual_reference_mode: z.enum(['profiles', 'keyframe', 'text_only']).optional(),
      excluded_visual_profile_ids: z.array(z.string().min(1)).max(50).optional(),
      skill_ids: skillIdsInput.optional(),
      ratio: z.string().max(30).optional(), duration: z.number().min(1).max(120).optional(), mode: z.string().max(40).optional(),
      resolution: z.string().max(100).nullable().optional(), clarity: z.string().max(100).nullable().optional(),
      quality: z.string().max(100).nullable().optional(), background: z.string().max(100).nullable().optional(),
    }).strict().parse(request.body)
    if (input.stage === 'image_prompt' && (input.reference_asset_ids.length > 20 || input.explicit_reference_asset_ids.length > 20)) fail('图片提示词最多使用 20 张参考图片')
    const isDocument = input.prompt_document === true || input.prompt_document === undefined && input.prompt_body === undefined && getManagedPromptBlocks(input.prompt).length > 0
    if (isDocument) {
      try { validateManagedPromptDocument(input.prompt) }
      catch (issue) { fail(issue instanceof Error ? issue.message : '提示词固定区块不完整，请补全后整理') }
    }
    const shot = input.shot_id ? required<Shot>('shots', input.shot_id) : null
    if (shot && shot.project_id !== id) fail('镜头不属于当前项目')
    const profile = input.profile_id ? required<VisualProfile>('visual_profiles', input.profile_id) : null
    if (profile && (profile.project_id !== id || input.stage !== 'image_prompt')) fail('视觉设定不属于当前项目或生成环节不匹配')
    const targetModel = input.target_model_id ? required<Model>('models', input.target_model_id) : null
    if (targetModel && (targetModel.modality !== (input.stage === 'image_prompt' ? 'image' : 'video') || !targetModel.enabled || targetModel.archived)) fail('目标生成模型不可用')
    const savedBindings = shot ? all<{ profile_id: string; definition: string; view_requirements: string; revision: number; variant: string; required: number; usage?: VisualBindingUsage;
      name: string; kind: 'character' | 'location' | 'prop'; board_asset_id: string | null; reference_assets?: string }>('SELECT * FROM shot_visual_bindings WHERE shot_id=? ORDER BY kind, name, profile_id', shot.id)
      .map(binding => ({ ...binding, reference_assets: parseVisualReferenceSnapshots(binding.reference_assets) })) : []
    for (const id of input.excluded_visual_profile_ids || []) {
      const binding = savedBindings.find(binding => binding.profile_id === id)
      if (!binding || binding.required && visualBindingsForModality([binding], input.stage === 'video_prompt' ? 'video' : 'image').length) fail('只能排除当前镜头的可选参考图')
    }
    const suppliedReferenceIds = input.reference_asset_ids
    if (new Set(suppliedReferenceIds).size !== suppliedReferenceIds.length) fail('参考图片不能重复')
    if (new Set(input.explicit_reference_asset_ids).size !== input.explicit_reference_asset_ids.length
      || input.explicit_reference_asset_ids.some(assetId => !suppliedReferenceIds.includes(assetId))) fail('显式参考图必须属于当前参考列表且不能重复')
    const baseProfile = profile?.base_profile_id ? required<VisualProfile>('visual_profiles', profile.base_profile_id) : null
    let resolvedReferences: ReturnType<typeof resolvePromptReferences>
    try {
      resolvedReferences = resolvePromptReferences({ prompt: '', referenceAssetIds: suppliedReferenceIds,
        overrides: input.prompt_reference_overrides, requiredAssetIds: baseProfile?.board_asset_id ? [baseProfile.board_asset_id] : [] })
    } catch (issue) { fail(issue instanceof Error ? issue.message : '图片引用无效') }
    const replaceAsset = (assetId: string | null | undefined) => assetId
      ? Object.hasOwn(resolvedReferences.replacements, assetId) ? resolvedReferences.replacements[assetId] : assetId : null
    const explicitReferenceIds = [...new Set(input.explicit_reference_asset_ids.flatMap(assetId => {
      const replacement = replaceAsset(assetId)
      return replacement ? [replacement] : []
    }))]
    const mappedBindings = savedBindings.map(binding => ({ ...binding, board_asset_id: replaceAsset(binding.board_asset_id) || null,
      reference_assets: binding.reference_assets.flatMap(reference => {
        const asset_id = replaceAsset(reference.asset_id)
        return asset_id ? [{ ...reference, asset_id }] : []
      }) }))
    const scopedBindings = visualBindingsForModality(mappedBindings, input.stage === 'video_prompt' ? 'video' : 'image')
    // Exclusions remove an object's input images, while its frozen definition
    // still constrains the shot, matching the final generation compiler.
    const referenceBindings = scopedBindings.filter(binding => !input.excluded_visual_profile_ids?.includes(binding.profile_id))
    input.reference_asset_ids = scopedVisualReferenceAssetIds(resolvedReferences.referenceAssetIds,
      mappedBindings.map(binding => ({ ...binding, required: !!binding.required })), referenceBindings.map(binding => ({ ...binding, required: !!binding.required })), explicitReferenceIds)
    input.storyboard_reference_asset_id = replaceAsset(input.storyboard_reference_asset_id)
    if (input.video_reference_usages) {
      if (new Set(input.video_reference_usages.map(usage => usage.asset_id)).size !== input.video_reference_usages.length) fail('参考图用途不能重复指定同一图片')
      const usages = new Map<string, NonNullable<typeof input.video_reference_usages>[number]>()
      for (const usage of input.video_reference_usages) {
        const asset_id = replaceAsset(usage.asset_id)
        if (!asset_id) continue
        if (usages.has(asset_id) && usages.get(asset_id)!.usage !== usage.usage) fail('同一张替换参考图存在冲突用途，请重新选择')
        usages.set(asset_id, { ...usage, asset_id })
      }
      input.video_reference_usages = [...usages.values()]
    }
    const usageIssue = videoReferenceUsageIssue(input.video_reference_usages, input.reference_asset_ids, input.mode || 'text', input.stage === 'video_prompt' ? 'video' : 'image')
    if (usageIssue) fail(usageIssue)
    const references = input.reference_asset_ids.map(assetId => {
      const asset = required<Asset>('assets', assetId)
      if (asset.project_id !== id || asset.kind !== 'image') fail('参考图必须是当前项目的图片')
      return { id: asset.id, name: asset.filename }
    })
    const promptBindings = enrichExplicitReferenceBindings(scopedBindings, {
      referenceAssetIds: input.reference_asset_ids, explicitReferenceAssetIds: explicitReferenceIds,
      savedBindings, profiles: explicitReferenceIds.length ? explicitReferenceProfiles(id) : [],
      overrides: resolvedReferences.replacements, excludedVisualProfileIds: input.excluded_visual_profile_ids,
    })
    const enrichedReferenceBindings = promptBindings.filter(binding => !binding.profile_id || !input.excluded_visual_profile_ids?.includes(binding.profile_id))
    if (input.storyboard_reference_asset_id && !input.reference_asset_ids.includes(input.storyboard_reference_asset_id)) fail('分镜构图图必须属于实际参考图')
    // Scope has already selected image or video bindings. The manifest's video
    // filtering must not erase an image-only object's identity and view uses.
    const manifest = videoReferenceManifest(input.reference_asset_ids, enrichedReferenceBindings.map((binding, index) => ({ ...binding,
      profile_id: binding.profile_id || `explicit-${index}`, required: !!binding.required,
      ...(input.stage === 'image_prompt' ? { usage: 'both' as const } : {}) })), {
      mode: input.stage === 'image_prompt' ? 'reference' : input.mode || 'text', visual_reference_mode: input.visual_reference_mode || 'profiles',
      storyboard_reference_asset_id: input.storyboard_reference_asset_id, excluded_visual_profile_ids: input.excluded_visual_profile_ids,
      video_reference_usages: input.video_reference_usages,
      append_profile_assets: false,
    })
    const independentReferences = all<{ profile_id: string; asset_id: string }>(`SELECT r.profile_id, r.asset_id FROM visual_profile_reference_assets r
      JOIN visual_profiles p ON p.id=r.profile_id WHERE p.project_id=? AND r.status='confirmed' AND r.revision=p.revision`, id)
    const independentProfiles = new Set(independentReferences.filter(reference => input.reference_asset_ids.includes(replaceAsset(reference.asset_id) || '')).map(reference => reference.profile_id))
    const referenceProfiles = all<VisualProfile>('SELECT * FROM visual_profiles WHERE project_id=?', id)
      .filter(profile => profile.board_asset_id && input.reference_asset_ids.includes(replaceAsset(profile.board_asset_id) || '') || independentProfiles.has(profile.id))
    const identities: RefinementReferenceIdentity[] = input.reference_asset_ids.map((assetId, index) => {
      const owners = new Map<string, RefinementReferenceIdentity['profiles'][number]>()
      for (const binding of mappedBindings) {
        if (binding.board_asset_id !== assetId && !binding.reference_assets.some(reference => reference.asset_id === assetId)) continue
        owners.set(binding.profile_id, { profile_id: binding.profile_id, kind: binding.kind, name: binding.name, variant: binding.variant })
      }
      for (const owner of referenceProfiles) {
        if (owners.has(owner.id) || replaceAsset(owner.board_asset_id) !== assetId
          && !independentReferences.some(reference => reference.profile_id === owner.id && replaceAsset(reference.asset_id) === assetId)) continue
        owners.set(owner.id, { profile_id: owner.id, kind: owner.kind, name: owner.name, variant: owner.variant })
      }
      return { asset_id: assetId, image_number: index + 1, profiles: [...owners.values()] }
    })
    const profiles = referenceProfiles.map(({ name, variant, definition, view_requirements }) => ({ name, variant, definition, view_requirements }))
    const target = targetModel ? { name: targetModel.name, remote_id: targetModel.remote_id, settings: JSON.parse(targetModel.settings) } : null
    if (input.stage === 'video_prompt' && target) {
      const issue = videoReferenceConfigError(target.settings, references.length, input.mode || 'text')
      if (issue) fail(issue)
    }
    let body: string, originalDocument = ''
    try {
      const source = isDocument ? input.prompt : extractPromptBody(input)
      const positionsChanged = suppliedReferenceIds.length !== input.reference_asset_ids.length || suppliedReferenceIds.some((assetId, index) => input.reference_asset_ids[index] !== assetId)
      const resolvedBody = resolvePromptReferences({ prompt: isDocument && !positionsChanged ? source : tokenizePromptReferenceNumbers(source, suppliedReferenceIds),
        referenceAssetIds: input.reference_asset_ids, overrides: resolvedReferences.replacements })
      if (resolvedBody.referenceAssetIds.some(assetId => !input.reference_asset_ids.includes(assetId))) fail('提示词中的参考已断开或未在当前模式生效，请重新连接、替换或移除')
      originalDocument = isDocument ? resolvedBody.prompt : ''
      body = isDocument ? stripManagedPromptBlocks(originalDocument) : resolvedBody.prompt
    } catch (issue) { fail(issue instanceof Error ? issue.message : '提示词图片引用无效') }
    if (!body.trim()) fail('请输入需要整理的提示词正文')
    let adjustmentRequest: string
    try {
      adjustmentRequest = compileRefinementReferences(input.adjustment_request, input.reference_asset_ids, {
        suppliedReferenceIds, overrides: resolvedReferences.replacements, referenceLabel: input.stage === 'video_prompt' ? '图片' : '参考图',
      })
    } catch (issue) { fail(issue instanceof Error ? issue.message : '调整要求中的图片引用无效') }
    const assignmentIssue = referenceIdentityAssignmentIssue(adjustmentRequest, identities)
    if (assignmentIssue) fail(assignmentIssue)
    const addedCharacters = profile ? [] : requestedReferenceCharacters(adjustmentRequest, body, identities)
    const style = projectVisualStyle(id)
    const referenceMode = input.visual_reference_mode || 'profiles'
    const targetSettings: Record<string, unknown> = targetModel ? JSON.parse(targetModel.settings) : {}
    const followsSourceDuration = input.stage === 'video_prompt' && targetSettings.video_reference_profile === 'seedance_2_5' && input.mode === 'edit'
    const selectedConfiguration = { ratio: input.ratio || project.ratio, duration: input.duration, mode: input.mode,
      resolution: input.resolution, clarity: input.clarity, quality: input.quality, background: input.background }
    const configuration = { ...(input.stage === 'video_prompt' ? normalizeSeedance25Request(targetSettings, selectedConfiguration) : selectedConfiguration),
      ...(followsSourceDuration ? { duration: null, duration_follows_source: true } : {}) }
    const actualParameters = { ...configuration, modality: input.stage === 'image_prompt' ? 'image' as const : 'video' as const }
    const parameterIssue = promptParameterConflictMessage(isDocument ? originalDocument : body, actualParameters)
    if (parameterIssue) fail(parameterIssue)
    const relevantProfileIds = [...new Set([...(profile ? [profile.id, ...(profile.base_profile_id ? [profile.base_profile_id] : [])] : []),
      ...promptBindings.flatMap(binding => binding.profile_id || []), ...referenceProfiles.map(reference => reference.id)])].sort()
    // A model result is a draft of the body. Freeze the structured context used
    // to assemble its preview, and reject it if that context changes in flight.
    const contextVersion = () => JSON.stringify({ style: projectVisualStyle(id).version,
      replacements: resolvedReferences.replacements,
      shot: shot ? all('SELECT title, start_state, end_state, cut_note, storyboard_revision, design_id FROM shots WHERE id=?', shot.id) : [],
      bindings: shot ? visualBindingsForModality(all<{ profile_id: string; usage?: VisualBindingUsage }>(
        'SELECT * FROM shot_visual_bindings WHERE shot_id=? ORDER BY kind, name, profile_id', shot.id), input.stage === 'video_prompt' ? 'video' : 'image') : [],
      profiles: relevantProfileIds.map(profileId => all('SELECT * FROM visual_profiles WHERE id=?', profileId)),
      explicit_context: explicitReferenceIds.length ? enrichExplicitReferenceBindings(scopedBindings, {
        referenceAssetIds: input.reference_asset_ids, explicitReferenceAssetIds: explicitReferenceIds,
        savedBindings: shot ? all<Omit<(typeof savedBindings)[number], 'reference_assets'> & { reference_assets?: string }>(
          'SELECT * FROM shot_visual_bindings WHERE shot_id=? ORDER BY kind, name, profile_id', shot.id)
          .map(binding => ({ ...binding, reference_assets: parseVisualReferenceSnapshots(binding.reference_assets) })) : [],
        profiles: explicitReferenceProfiles(id), overrides: resolvedReferences.replacements,
        excludedVisualProfileIds: input.excluded_visual_profile_ids,
      }) : [],
      target: targetModel ? all('SELECT * FROM models WHERE id=?', targetModel.id) : [],
      references: input.reference_asset_ids.map(assetId => all('SELECT id, project_id, kind, filename, path FROM assets WHERE id=?', assetId)),
    })
    const version = contextVersion()
    const images: TextImageInput[] = [], inspectedIds: string[] = []
    if (input.analyze_reference_images && references.length) {
      const analysisModel = required<Model>('models', input.model_id)
      if (analysisModel.modality !== 'text' || !analysisModel.enabled || analysisModel.archived
        || JSON.parse(analysisModel.settings).supports_vision !== true
        || !['responses', 'chat_completions'].includes(analysisModel.protocol) || !context.generateWithImages) {
        fail('参考图视觉诊断需要启用图片理解的文本模型')
      }
      for (const reference of references.slice(0, 8)) {
        images.push({ data_url: await localImagePixels(required<Asset>('assets', reference.id), controller.signal), detail: 'high' })
        inspectedIds.push(reference.id)
      }
    }
    const generate = (text: string, contract?: OutputContract) => images.length
      ? context.generateWithImages!(id, input.model_id, text, images, contract, controller.signal)
      : context.generateText(id, input.model_id, text, contract, controller.signal)
    const shotContext = shot ? { title: shot.title, start_state: shot.start_state, end_state: shot.end_state, cut_note: shot.cut_note } : null
    const bindingContext = promptBindings.map(({ kind, name, variant, revision, definition, view_requirements }) => ({ kind, name, variant, revision, definition, view_requirements }))
    const profileContext = profile ? { kind: profile.kind, name: profile.name, variant: profile.variant,
      definition: profile.definition, view_requirements: profile.view_requirements, state_delta: profile.state_delta } : null
    const documentContext = isDocument ? { source: 'current_prompt_document', read_only: true,
      sections: getManagedPromptBlocks(originalDocument).map(block => {
        const name = /^【([^】]+)】/.exec(block)![1]!
        return { name, content: block.slice(name.length + 2, -(name.length + 4)).trim() }
      }) } : null
    const task = `为当前${profile ? '视觉设定图' : input.stage === 'image_prompt' ? '图片' : '视频'}节点整理提示词正文。保留创作者原有意图，不增加其他镜头。` +
      (isDocument ? '\n画风、视觉设定和参考用途以当前文档的只读结构上下文为准，未提供的区块表示创作者已移除，不得从旧项目设定补回。\n' : `\n${projectStyleInstructions(style)}\n`) +
      '不要改变比例、时长、生成模式或参考图顺序。不得伪造已提供参考图的可见内容。' +
      (images.length ? `本次已附带前 ${images.length} 张实际参考图像素，按原编号诊断姿势、拼版和空间；其余图片只能依据设定文字，不得声称看过。` : '只根据设定文字和明确的参考用途写要求。') +
      '不生成媒体，不添加工作流说明、文件路径、Markdown 文档结构或第二次确认。输出中文；原有逐字对白保持原文。\n' +
      '当前提示词是本次修改基稿；镜头和设定资料用于理解与一致性校验，不得用其中的旧提示词替换本次基稿。' +
      '优先落实明确的本次调整要求，其优先于通用整理建议和 Skill 写作偏好；仅修改要求涉及的方面，保留其余剧情、人物身份、人物关系和逐字对白，不增加无依据的剧情。' +
      '当调整要求明确加入新角色时，允许相应更新本镜头的人物参与、站位和动作；必须让该角色实际出现在当前画面正文中，并以正确图片编号关联人物参考，不能仅在结尾追加参考用途或以不入镜等否定句代替落实。没有新增人物要求时不强制补写其他人物。' +
      `调整要求不能覆盖${isDocument ? '当前有效画风' : '项目画风'}、比例、时长、生成模式、实际参考图顺序及输出格式；未填写要求时，沿用原有整理规则。\n` +
      '以下配置、视觉设定和参考图对应关系是只读上下文，仅用于理解正文与检查一致性，不属于待改写文本。' +
      (isDocument ? '只读结构上下文来自创作者当前完整文档，仅供理解和一致性检查，不属于待改写的原提示词。系统会在整理完成后原样放回这些区块，不允许改写、复制或重新生成；空区块列表也不得以旧资料兜底。' : '系统会在整理完成后重新拼接这些固定要求；') +
      '返回值仅包含正文，不输出镜头视觉设定、参考图用途表、参数约束、基础身份参考或项目画风区块，不重复抄写固定设定。\n' +
      (profile ? `当前为${{ character: '人物', location: '场景', prop: '道具' }[profile.kind]}设定图，依据该设定的定义与视图要求组织外观和各视图呈现，不套用剧情镜头或视频动作流程。\n` : '') +
      `项目：${project.name}${isDocument ? '' : `；创意：${project.brief}`}；配置：${JSON.stringify(configuration)}\n` +
      `目标模型：${JSON.stringify(target ? { name: target.name, remote_id: target.remote_id } : null)}\n当前镜头：${JSON.stringify(shotContext)}\n` +
      (isDocument ? `当前文档只读结构上下文：${JSON.stringify(documentContext)}\n` : `视觉设定：${JSON.stringify({ profile: profileContext, bindings: bindingContext, profiles: shot ? [] : profiles })}\n`) +
      `实际参考图（按输入顺序）：${JSON.stringify(references.map((reference, index) => {
        if (isDocument) return { ...reference, image_number: index + 1 }
        const entry = manifest.find(item => item.asset_id === reference.id)
        return { ...reference, image_number: index + 1, purpose: entry?.purpose, objects: entry?.name,
          usage: entry?.usage, usage_instruction: entry?.usage ? videoReferenceUsageInstructions[entry.usage] : undefined,
          view: entry?.view, reference_purpose: entry?.reference_purpose, reference_label: entry?.reference_label, reference_details: entry?.reference_details }
      }))}\n` +
      `已选图片身份标签（仅用于识别素材归属，不是恢复已删除设定或默认用途的依据）：${JSON.stringify(isDocument ? identities.filter(identity => explicitReferenceIds.includes(identity.asset_id)) : identities)}\n` +
      (addedCharacters.length ? `本次明确新增的画面人物：${JSON.stringify(addedCharacters)}。每个人物必须在正文写明当前画面中的位置或动作，并在同一句中明确其实际参考图编号。\n` : '') +
      (input.stage === 'video_prompt' ? isDocument
        ? '使用“图片N”引用实际图片，N严格对应上述顺序；参考用途以当前文档只读区块为准，不根据旧设定推断或补写用途。\n'
        : `使用“图片N”引用实际图片，N严格对应上述顺序；逐图usage_instruction优先于素材的默认用途。${videoReferenceShotGuidance}不复制信息图拼版、标签或其他角色。\n` : '') +
      (input.stage === 'video_prompt' ? seedance2PromptGuidance(target) : '') +
      (input.stage === 'video_prompt' ? '\n动作编排要求：先落实一个清楚可读的主动作、起始状态、结束状态和可见完成结果，再安排必要次动作；对白与剧情因果优先，不能为压缩字数擅自删除。对当前时长容纳不了的动作给出诊断，不得擅自改时长或增加镜头。情绪克制不等于关键动作不可见；同时保留原有静止、停顿、拍空或未接触等剧情规则，不强制所有镜头大幅运动。\n' : '') +
      (input.stage === 'video_prompt' && shot ? `生成时长与剪辑目标分别处理：当前生成时长 ${configuration.duration ?? '跟随源视频'} 秒，分镜剪辑目标 ${shot.duration} 秒；可以建议截取有效片段，不修改分镜和时间线。\n` : '') +
      `原提示词：\n${body}\n` +
      `本次调整要求：\n${adjustmentRequest || '未指定，按现有规则整理当前提示词。'}\n` +
      '只输出合法 JSON 对象：{"prompt":"整理后的可编辑正文，不包含系统固定区块"}。'
    const rules = await resolveCreationSkillContext({ stage: input.stage, task, selectedIds: input.skill_ids,
      projectId: id, modelId: input.model_id, select: context.selectSkills, signal: controller.signal, generate,
      assignmentTask: { text: adjustmentRequest, purpose: 'refine', profile_kind: profile?.kind,
        target_model: target ? `${target.name} ${target.remote_id}` : undefined },
    })
    const result = await generateStructuredOutput('refined_prompt', z.object({ prompt: z.string().trim().min(1).max(80_000) }).strict(),
      generate, rules.text + '\n【本次任务与输出格式】\n' + task, {
        signal: controller.signal,
        validate: value => {
          const prose = stripManagedPromptBlocks(value.prompt)
          if (!prose.trim()) fail('整理结果缺少提示词正文，只能返回正文，不能只返回系统固定区块')
          if (/【(?:镜头视觉设定|图片参考图用途|视频参考图用途|项目画风约束|设定图固定要求|基础身份参考|基础版本与本次状态变化|生成参考图|生成参数约束|图片生成要求|视频生成要求)(?:结束)?】/.test(prose)) {
            fail('整理结果包含未闭合的系统固定区块，请仅返回正文，不要输出系统区块或标题')
          }
          const parameterIssue = promptParameterConflictMessage(prose, actualParameters)
          if (parameterIssue) fail(parameterIssue)
          const compiled = compileRefinementReferences(prose, input.reference_asset_ids, { referenceLabel: input.stage === 'video_prompt' ? '图片' : '参考图' })
          const referenceIssue = referenceIdentityAssignmentIssue(compiled, identities) || addedReferenceCharacterIssue(compiled, addedCharacters)
          if (referenceIssue) fail(referenceIssue)
          if (input.stage === 'video_prompt') {
            const dialogue = dialoguePreservation(body, prose, adjustmentRequest)
            if (dialogue.missing.length) fail(`整理结果丢失当前基稿的逐字对白：${dialogue.missing.join('；')}。请恢复原话。`)
          }
        },
      })
    if (contextVersion() !== version) throw Object.assign(new Error('镜头、视觉设定、参考图或生成配置已更新，请重新整理提示词'), { statusCode: 409 })
    const promptBody = compileRefinementReferences(stripManagedPromptBlocks(result.prompt).trim(), input.reference_asset_ids, { referenceLabel: input.stage === 'video_prompt' ? '图片' : '参考图' })
    if (!promptBody) fail('整理结果缺少提示词正文，请重新整理')
    const contentReview = input.stage === 'video_prompt' && input.check_video_content
      ? await generateStructuredOutput('video_prompt_content_review', videoContentReviewSchema, generate,
        videoContentReviewInstructions({ source: body, candidate: promptBody, adjustment: adjustmentRequest, shot: shotContext,
          generation_duration: configuration.duration, edit_duration: shot?.duration, inspected_asset_ids: inspectedIds, reference_asset_ids: input.reference_asset_ids }), {
          signal: controller.signal, validate: value => {
            if (value.reference_findings.some(finding => !inspectedIds.includes(input.reference_asset_ids[finding.image_number - 1] || ''))) {
              fail('参考图诊断引用了没有提供实际像素的图片')
            }
          },
        }) : undefined
    controller.signal.throwIfAborted()
    if (contextVersion() !== version) throw Object.assign(new Error('镜头、视觉设定、参考图或生成配置已更新，请重新整理提示词'), { statusCode: 409 })
    const diagnostics = input.stage === 'video_prompt' ? videoPromptDiagnostics({ source: body, candidate: promptBody,
      adjustment: adjustmentRequest, generationDuration: configuration.duration, editDuration: shot?.duration,
      referenceIds: input.reference_asset_ids, inspectedIds, review: contentReview }) : undefined
    if (isDocument) {
      const prompt = restoreManagedPromptBlocks(promptBody, originalDocument)
      if (prompt.length > 80_000) fail('整理后的提示词过长，请缩短补充要求后重试')
      return { prompt, prompt_body: promptBody, prompt_document: true, reference_asset_ids: input.reference_asset_ids, skills: rules.skills, loaded_files: rules.files, skill_assignment: rules.assignment, ...(diagnostics ? { diagnostics } : {}) }
    }
    let refined: string
    if (profile) {
      const textContext = visualProfileTextContext(profile)
      const base = baseProfile
      refined = withVisualProfilePrompt(promptBody, { ...profile,
        definition: resolveVisualProfileDisplayText(profile.definition, textContext).text,
        view_requirements: resolveVisualProfileDisplayText(profile.view_requirements, textContext).text,
        state_delta: resolveVisualProfileDisplayText(profile.state_delta || '', textContext).text,
      }, references.map(reference => {
        const owner = referenceProfiles.find(owner => owner.board_asset_id === reference.id)
        return { asset_id: reference.id, name: owner?.name || reference.name, variant: owner?.variant,
          definition: owner ? resolveVisualProfileDisplayText(owner.definition, visualProfileTextContext(owner)).text : undefined,
          role: base?.board_asset_id === reference.id ? 'base' as const : 'manual' as const }
      }))
    } else {
      refined = visualGenerationPrompt(promptBody, promptBindings, input.reference_asset_ids, referenceMode, {
        mode: input.stage === 'video_prompt' ? input.mode || 'text' : undefined, storyboard_reference_asset_id: input.storyboard_reference_asset_id,
        excluded_visual_profile_ids: input.excluded_visual_profile_ids, video_reference_usages: input.video_reference_usages,
      })
    }
    const parameters = [configuration.ratio && (configuration.ratio === 'adaptive' ? '画面比例：自适应，依据输入素材与内容确定画幅。' : `画面比例：${configuration.ratio}（宽:高）。`),
      configuration.duration && input.stage === 'video_prompt' && `视频时长：${configuration.duration} 秒，动作与运镜安排在此时长内。`,
      input.stage === 'video_prompt' && ['first_frame', 'first_last_frame'].includes(input.mode || '') &&
        '首帧要求：以提交的第一张参考图作为开镜画面，保持人物、服装、场景与动作起始状态，按所选画幅安排构图，再连续展开动作。',
      configuration.mode && `生成模式：${configuration.mode}。`, configuration.resolution && `输出分辨率：${configuration.resolution}。`,
      configuration.clarity && `清晰度要求：${configuration.clarity}。`, configuration.quality && `画质要求：${configuration.quality}。`,
      configuration.background && `背景要求：${configuration.background}。`].filter(Boolean).join('\n')
    const prompt = withProjectStyle(`${refined}\n\n【生成参数约束】\n${parameters}\n【生成参数约束结束】`, style)
    if (prompt.length > 80_000) fail('整理后的提示词过长，请缩短补充要求后重试')
    return { prompt, prompt_body: promptBody, reference_asset_ids: input.reference_asset_ids, skills: rules.skills, loaded_files: rules.files, skill_assignment: rules.assignment, ...(diagnostics ? { diagnostics } : {}) }
    } catch (error) {
      if (controller.signal.aborted) throw Object.assign(new Error('提示词整理已取消'), { statusCode: 499 })
      throw error
    } finally {
      request.raw.removeListener('aborted', abort)
      reply.raw.removeListener('close', abort)
    }
  })
}
