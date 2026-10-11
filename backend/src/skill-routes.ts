import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { projectVisualStyle } from './project-visual-style.js'
import { projectStyleInstructions, withProjectStyle } from './visual-style.js'
import { all, db, now, required, run } from './db.js'
import type { Asset, Model, Project, Shot } from './db.js'
import type { VisualProfile } from './visual-profiles.js'
import { generateStructuredOutput, type OutputContract } from './model-output.js'
import { scopedVisualReferenceAssetIds, videoReferenceManifest } from './video-reference-manifest.js'
import { videoReferenceUsages, videoReferenceUsageIssue, videoReferenceUsageInstructions, videoReferenceShotGuidance } from './video-reference-usage.js'
import { visualBindingsForModality, type VisualBindingUsage } from './visual-binding-usage.js'
import { synchronizeVideoReferencePrompt } from './visual-prompt.js'
import { parseVisualReferenceSnapshots } from './visual-reference-assets.js'
import { seedance2PromptGuidance } from './seedance-prompt.js'
import { videoReferenceConfigError } from './video-reference-config.js'
import { MAX_AUXILIARY_SKILLS } from './skill-limits.js'
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
      target_model_id: z.string().min(1).nullable().optional(), shot_id: z.string().min(1).nullable().optional(),
      profile_id: z.string().min(1).optional(),
      reference_asset_ids: z.array(z.string().min(1)).max(20).default([]),
      storyboard_reference_asset_id: z.string().min(1).nullable().optional(),
      video_reference_usages: z.array(z.object({ asset_id: z.string().min(1), usage: z.enum(videoReferenceUsages) }).strict()).max(10).optional(),
      visual_reference_mode: z.enum(['profiles', 'keyframe', 'text_only']).optional(),
      excluded_visual_profile_ids: z.array(z.string().min(1)).max(50).optional(),
      skill_ids: skillIdsInput.optional(),
      ratio: z.string().max(30).optional(), duration: z.number().min(1).max(120).optional(), mode: z.string().max(40).optional(),
    }).strict().parse(request.body)
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
    const bindings = visualBindingsForModality(savedBindings, input.stage === 'video_prompt' ? 'video' : 'image')
      .filter(binding => !input.excluded_visual_profile_ids?.includes(binding.profile_id))
    input.reference_asset_ids = scopedVisualReferenceAssetIds(input.reference_asset_ids,
      savedBindings.map(binding => ({ ...binding, required: !!binding.required })), bindings.map(binding => ({ ...binding, required: !!binding.required })))
    if (new Set(input.reference_asset_ids).size !== input.reference_asset_ids.length) fail('参考图片不能重复')
    const usageIssue = videoReferenceUsageIssue(input.video_reference_usages, input.reference_asset_ids, input.mode || 'text', input.stage === 'video_prompt' ? 'video' : 'image')
    if (usageIssue) fail(usageIssue)
    const references = input.reference_asset_ids.map(assetId => {
      const asset = required<Asset>('assets', assetId)
      if (asset.project_id !== id || asset.kind !== 'image') fail('参考图必须是当前项目的图片')
      return { id: asset.id, name: asset.filename }
    })
    if (input.storyboard_reference_asset_id && !input.reference_asset_ids.includes(input.storyboard_reference_asset_id)) fail('分镜构图图必须属于实际参考图')
    const manifest = videoReferenceManifest(input.reference_asset_ids, bindings.map(binding => ({ ...binding, required: !!binding.required })), {
      mode: input.stage === 'image_prompt' ? 'reference' : input.mode || 'text', visual_reference_mode: input.visual_reference_mode || 'profiles',
      storyboard_reference_asset_id: input.storyboard_reference_asset_id, excluded_visual_profile_ids: input.excluded_visual_profile_ids,
      video_reference_usages: input.video_reference_usages,
      append_profile_assets: false,
    })
    const independentProfiles = new Set(all<{ profile_id: string; asset_id: string }>(`SELECT r.profile_id, r.asset_id FROM visual_profile_reference_assets r
      JOIN visual_profiles p ON p.id=r.profile_id WHERE p.project_id=? AND r.status='confirmed' AND r.revision=p.revision`, id)
      .filter(reference => input.reference_asset_ids.includes(reference.asset_id)).map(reference => reference.profile_id))
    const profiles = all<VisualProfile>('SELECT * FROM visual_profiles WHERE project_id=?', id)
      .filter(profile => profile.board_asset_id && input.reference_asset_ids.includes(profile.board_asset_id) || independentProfiles.has(profile.id))
      .map(({ name, definition, view_requirements }) => ({ name, definition, view_requirements }))
    const target = targetModel ? { name: targetModel.name, remote_id: targetModel.remote_id, settings: JSON.parse(targetModel.settings) } : null
    if (input.stage === 'video_prompt' && target) {
      const issue = videoReferenceConfigError(target.settings, references.length, input.mode || 'text')
      if (issue) fail(issue)
    }
    const task = `为当前${input.stage === 'image_prompt' ? '图片' : '视频'}节点整理一份可直接提交的完整提示词。保留创作者原有意图，不增加其他镜头。` +
      `\n${projectStyleInstructions(projectVisualStyle(id))}\n` +
      '不要改变比例、时长、生成模式或参考图顺序。不得伪造已提供参考图的可见内容，只根据设定文字和明确的参考用途写要求。' +
      '不生成媒体，不添加工作流说明、文件路径、Markdown 文档结构或第二次确认。输出中文；原有逐字对白保持原文。\n' +
      `项目：${project.name}；创意：${project.brief}；配置：${JSON.stringify({ ratio: input.ratio || project.ratio, duration: input.duration, mode: input.mode })}\n` +
      `目标模型：${JSON.stringify(target)}\n当前镜头：${JSON.stringify(shot)}\n视觉设定：${JSON.stringify({ profile, bindings, profiles })}\n` +
      `实际参考图（按输入顺序）：${JSON.stringify(references.map((reference, index) => {
        const entry = manifest.find(item => item.asset_id === reference.id)
        return { ...reference, image_number: index + 1, purpose: entry?.purpose, objects: entry?.name,
          usage: entry?.usage, usage_instruction: entry?.usage ? videoReferenceUsageInstructions[entry.usage] : undefined,
          view: entry?.view, reference_purpose: entry?.reference_purpose, reference_label: entry?.reference_label, reference_details: entry?.reference_details }
      }))}\n` +
      (input.stage === 'video_prompt' ? `使用“图片N”引用实际图片，N严格对应上述顺序；逐图usage_instruction优先于素材的默认用途。${videoReferenceShotGuidance}不复制信息图拼版、标签或其他角色。\n` : '') +
      (input.stage === 'video_prompt' ? seedance2PromptGuidance(target) : '') +
      `原提示词：\n${input.prompt}\n` +
      '只输出合法 JSON 对象：{"prompt":"完整可编辑的提示词"}。'
    const rules = skillContext(input.stage, task, input.skill_ids, id)
    const result = await generateStructuredOutput('refined_prompt', z.object({ prompt: z.string().trim().min(1).max(80_000) }).strict(),
      (text, contract) => context.generateText(id, input.model_id, text, contract), rules.text + '\n【本次任务与输出格式】\n' + task)
    const refined = input.stage === 'video_prompt' ? synchronizeVideoReferencePrompt(result.prompt, bindings, input.reference_asset_ids,
      input.visual_reference_mode || 'profiles', { mode: input.mode, storyboard_reference_asset_id: input.storyboard_reference_asset_id,
        excluded_visual_profile_ids: input.excluded_visual_profile_ids, video_reference_usages: input.video_reference_usages }) : result.prompt
    const prompt = withProjectStyle(refined, projectVisualStyle(id))
    if (prompt.length > 80_000) fail('整理后的提示词过长，请缩短补充要求后重试')
    return { prompt, skills: rules.skills, loaded_files: rules.files }
  })
}
