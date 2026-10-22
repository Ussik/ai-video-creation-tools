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
import { seedance2PromptGuidance } from '../generation/seedance-prompt.js'
import { videoReferenceConfigError } from '@video-studio/shared/media/video-reference-config'
import { MAX_AUXILIARY_SKILLS } from '@video-studio/shared/skills/skill-limits'
import { configureSkill, discoverRepository, initSkills, installedSkillDetail, installedSkills, installSkillBundle, loadSkillBundle,
  normalizeSkillRepo, removeInstalledSkill, searchSkillCatalog, skillContext, skillStages, skillStageLabels, skillUpdateStatus,
  skillPolicy, setSkillDefault, resetProjectSkillDefault, skillIdsInput } from './skills.js'

const source = z.object({ repo: z.string().min(3).max(220), path: z.string().max(500).default('') }).strict()
const idParams = z.object({ id: z.string().min(1).max(100) })
function fail(message: string): never { throw Object.assign(new Error(message), { statusCode: 422 }) }

export function registerSkillRoutes(app: FastifyInstance, context: {
  generateText: (projectId: string, modelId: string, prompt: string, contract?: OutputContract) => Promise<string>
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
  app.post('/api/projects/:id/skills/refine-prompt', async request => {
    const { id } = idParams.parse(request.params), project = required<Project>('projects', id)
    const input = z.object({
      model_id: z.string().min(1), stage: z.enum(['image_prompt', 'video_prompt']), prompt: z.string().trim().min(1).max(80_000),
      prompt_document: z.boolean().optional(),
      prompt_body: z.string().max(80_000).optional(), prompt_template: z.string().max(80_000).optional(),
      adjustment_request: z.string().trim().max(4000).default(''),
      target_model_id: z.string().min(1).nullable().optional(), shot_id: z.string().min(1).nullable().optional(),
      profile_id: z.string().min(1).optional(),
      reference_asset_ids: z.array(z.string().min(1)).max(20).default([]),
      prompt_reference_overrides: z.record(z.string(), z.string().nullable()).optional(),
      storyboard_reference_asset_id: z.string().min(1).nullable().optional(),
      video_reference_usages: z.array(z.object({ asset_id: z.string().min(1), usage: z.enum(videoReferenceUsages) }).strict()).max(10).optional(),
      visual_reference_mode: z.enum(['profiles', 'keyframe', 'text_only']).optional(),
      excluded_visual_profile_ids: z.array(z.string().min(1)).max(50).optional(),
      skill_ids: skillIdsInput.optional(),
      ratio: z.string().max(30).optional(), duration: z.number().min(1).max(120).optional(), mode: z.string().max(40).optional(),
      resolution: z.string().max(100).nullable().optional(), clarity: z.string().max(100).nullable().optional(),
      quality: z.string().max(100).nullable().optional(), background: z.string().max(100).nullable().optional(),
    }).strict().parse(request.body)
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
    const baseProfile = profile?.base_profile_id ? required<VisualProfile>('visual_profiles', profile.base_profile_id) : null
    let resolvedReferences: ReturnType<typeof resolvePromptReferences>
    try {
      resolvedReferences = resolvePromptReferences({ prompt: '', referenceAssetIds: suppliedReferenceIds,
        overrides: input.prompt_reference_overrides, requiredAssetIds: baseProfile?.board_asset_id ? [baseProfile.board_asset_id] : [] })
    } catch (issue) { fail(issue instanceof Error ? issue.message : '图片引用无效') }
    const replaceAsset = (assetId: string | null | undefined) => assetId
      ? Object.hasOwn(resolvedReferences.replacements, assetId) ? resolvedReferences.replacements[assetId] : assetId : null
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
      mappedBindings.map(binding => ({ ...binding, required: !!binding.required })), referenceBindings.map(binding => ({ ...binding, required: !!binding.required })))
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
    if (input.storyboard_reference_asset_id && !input.reference_asset_ids.includes(input.storyboard_reference_asset_id)) fail('分镜构图图必须属于实际参考图')
    // Scope has already selected image or video bindings. The manifest's video
    // filtering must not erase an image-only object's identity and view uses.
    const manifest = videoReferenceManifest(input.reference_asset_ids, referenceBindings.map(binding => ({ ...binding, required: !!binding.required,
      ...(input.stage === 'image_prompt' ? { usage: 'both' as const } : {}) })), {
      mode: input.stage === 'image_prompt' ? 'reference' : input.mode || 'text', visual_reference_mode: input.visual_reference_mode || 'profiles',
      storyboard_reference_asset_id: input.storyboard_reference_asset_id, excluded_visual_profile_ids: input.excluded_visual_profile_ids,
      video_reference_usages: input.video_reference_usages,
      append_profile_assets: false,
    })
    const independentProfiles = new Set(all<{ profile_id: string; asset_id: string }>(`SELECT r.profile_id, r.asset_id FROM visual_profile_reference_assets r
      JOIN visual_profiles p ON p.id=r.profile_id WHERE p.project_id=? AND r.status='confirmed' AND r.revision=p.revision`, id)
      .filter(reference => input.reference_asset_ids.includes(reference.asset_id)).map(reference => reference.profile_id))
    const referenceProfiles = all<VisualProfile>('SELECT * FROM visual_profiles WHERE project_id=?', id)
      .filter(profile => profile.board_asset_id && input.reference_asset_ids.includes(profile.board_asset_id) || independentProfiles.has(profile.id))
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
    const style = projectVisualStyle(id)
    const referenceMode = input.visual_reference_mode || 'profiles'
    const configuration = { ratio: input.ratio || project.ratio, duration: input.duration, mode: input.mode,
      resolution: input.resolution, clarity: input.clarity, quality: input.quality, background: input.background }
    const actualParameters = { ...configuration, modality: input.stage === 'image_prompt' ? 'image' as const : 'video' as const }
    const parameterIssue = promptParameterConflictMessage(isDocument ? originalDocument : body, actualParameters)
    if (parameterIssue) fail(parameterIssue)
    const relevantProfileIds = [...new Set([...(profile ? [profile.id, ...(profile.base_profile_id ? [profile.base_profile_id] : [])] : []),
      ...scopedBindings.map(binding => binding.profile_id), ...referenceProfiles.map(reference => reference.id)])].sort()
    // A model result is a draft of the body. Freeze the structured context used
    // to assemble its preview, and reject it if that context changes in flight.
    const contextVersion = () => JSON.stringify({ style: projectVisualStyle(id).version,
      replacements: resolvedReferences.replacements,
      shot: shot ? all('SELECT title, start_state, end_state, cut_note, storyboard_revision, design_id FROM shots WHERE id=?', shot.id) : [],
      bindings: shot ? visualBindingsForModality(all<{ profile_id: string; usage?: VisualBindingUsage }>(
        'SELECT * FROM shot_visual_bindings WHERE shot_id=? ORDER BY kind, name, profile_id', shot.id), input.stage === 'video_prompt' ? 'video' : 'image') : [],
      profiles: relevantProfileIds.map(profileId => all('SELECT * FROM visual_profiles WHERE id=?', profileId)),
      target: targetModel ? all('SELECT * FROM models WHERE id=?', targetModel.id) : [],
      references: input.reference_asset_ids.map(assetId => all('SELECT id, project_id, kind, filename, path FROM assets WHERE id=?', assetId)),
    })
    const version = contextVersion()
    const shotContext = shot ? { title: shot.title, start_state: shot.start_state, end_state: shot.end_state, cut_note: shot.cut_note } : null
    const bindingContext = scopedBindings.map(({ kind, name, variant, revision, definition, view_requirements }) => ({ kind, name, variant, revision, definition, view_requirements }))
    const profileContext = profile ? { kind: profile.kind, name: profile.name, variant: profile.variant,
      definition: profile.definition, view_requirements: profile.view_requirements, state_delta: profile.state_delta } : null
    const documentContext = isDocument ? { source: 'current_prompt_document', read_only: true,
      sections: getManagedPromptBlocks(originalDocument).map(block => {
        const name = /^【([^】]+)】/.exec(block)![1]!
        return { name, content: block.slice(name.length + 2, -(name.length + 4)).trim() }
      }) } : null
    const task = `为当前${profile ? '视觉设定图' : input.stage === 'image_prompt' ? '图片' : '视频'}节点整理提示词正文。保留创作者原有意图，不增加其他镜头。` +
      (isDocument ? '\n画风、视觉设定和参考用途以当前文档的只读结构上下文为准，未提供的区块表示创作者已移除，不得从旧项目设定补回。\n' : `\n${projectStyleInstructions(style)}\n`) +
      '不要改变比例、时长、生成模式或参考图顺序。不得伪造已提供参考图的可见内容，只根据设定文字和明确的参考用途写要求。' +
      '不生成媒体，不添加工作流说明、文件路径、Markdown 文档结构或第二次确认。输出中文；原有逐字对白保持原文。\n' +
      '当前提示词是本次修改基稿；镜头和设定资料用于理解与一致性校验，不得用其中的旧提示词替换本次基稿。' +
      '优先落实明确的本次调整要求，其优先于通用整理建议和 Skill 写作偏好；仅修改要求涉及的方面，保留其余剧情、人物身份、人物关系和逐字对白，不增加无依据的剧情。' +
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
      (input.stage === 'video_prompt' ? isDocument
        ? '使用“图片N”引用实际图片，N严格对应上述顺序；参考用途以当前文档只读区块为准，不根据旧设定推断或补写用途。\n'
        : `使用“图片N”引用实际图片，N严格对应上述顺序；逐图usage_instruction优先于素材的默认用途。${videoReferenceShotGuidance}不复制信息图拼版、标签或其他角色。\n` : '') +
      (input.stage === 'video_prompt' ? seedance2PromptGuidance(target) : '') +
      `原提示词：\n${body}\n` +
      `本次调整要求：\n${input.adjustment_request || '未指定，按现有规则整理当前提示词。'}\n` +
      '只输出合法 JSON 对象：{"prompt":"整理后的可编辑正文，不包含系统固定区块"}。'
    const rules = skillContext(input.stage, task, input.skill_ids, id)
    const result = await generateStructuredOutput('refined_prompt', z.object({ prompt: z.string().trim().min(1).max(80_000) }).strict(),
      (text, contract) => context.generateText(id, input.model_id, text, contract), rules.text + '\n【本次任务与输出格式】\n' + task, {
        validate: value => {
          const prose = stripManagedPromptBlocks(value.prompt)
          if (!prose.trim()) fail('整理结果缺少提示词正文，只能返回正文，不能只返回系统固定区块')
          if (/【(?:镜头视觉设定|图片参考图用途|视频参考图用途|项目画风约束|设定图固定要求|基础身份参考|基础版本与本次状态变化|生成参考图|生成参数约束|图片生成要求|视频生成要求)(?:结束)?】/.test(prose)) {
            fail('整理结果包含未闭合的系统固定区块，请仅返回正文，不要输出系统区块或标题')
          }
          const parameterIssue = promptParameterConflictMessage(prose, actualParameters)
          if (parameterIssue) fail(parameterIssue)
        },
      })
    if (contextVersion() !== version) throw Object.assign(new Error('镜头、视觉设定、参考图或生成配置已更新，请重新整理提示词'), { statusCode: 409 })
    const promptBody = stripManagedPromptBlocks(result.prompt).trim()
    if (!promptBody) fail('整理结果缺少提示词正文，请重新整理')
    if (isDocument) {
      const prompt = restoreManagedPromptBlocks(promptBody, originalDocument)
      if (prompt.length > 80_000) fail('整理后的提示词过长，请缩短补充要求后重试')
      return { prompt, prompt_body: promptBody, prompt_document: true, skills: rules.skills, loaded_files: rules.files }
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
      refined = visualGenerationPrompt(promptBody, scopedBindings, input.reference_asset_ids, referenceMode, {
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
    return { prompt, prompt_body: promptBody, skills: rules.skills, loaded_files: rules.files }
  })
}
