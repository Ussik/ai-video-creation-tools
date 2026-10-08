import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { all, db, now, required, run } from './db.js'
import type { Asset, Model, Project, Shot } from './db.js'
import type { VisualProfile } from './visual-profiles.js'
import { parseStructuredOutput } from './structured-output.js'
import { configureSkill, discoverRepository, initSkills, installedSkillDetail, installedSkills, installSkillBundle, loadSkillBundle,
  normalizeSkillRepo, removeInstalledSkill, searchSkillCatalog, skillContext, skillStages, skillStageLabels, skillUpdateStatus } from './skills.js'

const source = z.object({ repo: z.string().min(3).max(220), path: z.string().max(500).default('') }).strict()
const idParams = z.object({ id: z.string().min(1).max(100) })
function fail(message: string): never { throw Object.assign(new Error(message), { statusCode: 422 }) }

export function registerSkillRoutes(app: FastifyInstance, context: {
  generateText: (projectId: string, modelId: string, prompt: string) => Promise<string>
  fetcher?: typeof fetch
}) {
  initSkills()
  const fetcher = context.fetcher || fetch
  app.get('/api/skills', async () => ({ skills: installedSkills(), stages: skillStages.map(value => ({ value, label: skillStageLabels[value] })) }))
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
      ratio: z.string().max(30).optional(), duration: z.number().min(1).max(120).optional(), mode: z.string().max(40).optional(),
    }).strict().parse(request.body)
    const shot = input.shot_id ? required<Shot>('shots', input.shot_id) : null
    if (shot && shot.project_id !== id) fail('镜头不属于当前项目')
    const profile = input.profile_id ? required<VisualProfile>('visual_profiles', input.profile_id) : null
    if (profile && (profile.project_id !== id || input.stage !== 'image_prompt')) fail('视觉设定不属于当前项目或生成环节不匹配')
    const targetModel = input.target_model_id ? required<Model>('models', input.target_model_id) : null
    if (targetModel && (targetModel.modality !== (input.stage === 'image_prompt' ? 'image' : 'video') || !targetModel.enabled || targetModel.archived)) fail('目标生成模型不可用')
    const references = [...new Set(input.reference_asset_ids)].map(assetId => {
      const asset = required<Asset>('assets', assetId)
      if (asset.project_id !== id || asset.kind !== 'image') fail('参考图必须是当前项目的图片')
      return { id: asset.id, name: asset.filename }
    })
    const bindings = shot ? all<{ definition: string; name: string; kind: string; board_asset_id: string | null }>('SELECT definition, name, kind, board_asset_id FROM shot_visual_bindings WHERE shot_id=?', shot.id) : []
    const profiles = all<VisualProfile>('SELECT * FROM visual_profiles WHERE project_id=?', id)
      .filter(profile => profile.board_asset_id && input.reference_asset_ids.includes(profile.board_asset_id))
      .map(({ name, definition, view_requirements }) => ({ name, definition, view_requirements }))
    const target = targetModel ? { name: targetModel.name, remote_id: targetModel.remote_id, settings: JSON.parse(targetModel.settings) } : null
    const task = `为当前${input.stage === 'image_prompt' ? '图片' : '视频'}节点整理一份可直接提交的完整提示词。保留创作者原有意图，不增加其他镜头。` +
      '不要改变比例、时长、生成模式或参考图顺序。不得伪造已提供参考图的可见内容，只根据设定文字和明确的参考用途写要求。' +
      '不生成媒体，不添加工作流说明、文件路径、Markdown 文档结构或第二次确认。输出中文；原有逐字对白保持原文。\n' +
      `项目：${project.name}；创意：${project.brief}；配置：${JSON.stringify({ ratio: input.ratio || project.ratio, duration: input.duration, mode: input.mode })}\n` +
      `目标模型：${JSON.stringify(target)}\n当前镜头：${JSON.stringify(shot)}\n视觉设定：${JSON.stringify({ profile, bindings, profiles })}\n` +
      `实际参考图（按输入顺序）：${JSON.stringify(references)}\n原提示词：\n${input.prompt}\n` +
      '只输出合法 JSON 对象：{"prompt":"完整可编辑的提示词"}。'
    const rules = skillContext(input.stage, task)
    if (!rules.skills.length) fail(`请先在技能中心为${skillStageLabels[input.stage]}启用技能`)
    const raw = await context.generateText(id, input.model_id, rules.text + '\n【本次任务与输出格式】\n' + task)
    const result = parseStructuredOutput(raw, z.object({ prompt: z.string().trim().min(1).max(80_000) }))
    if (!result) fail('模型未返回有效的提示词，请重新整理')
    if (profile && result.prompt.length > 16_000) fail('整理后的信息图提示词过长，请缩短补充要求后重试')
    return { prompt: result.prompt, skills: rules.skills, loaded_files: rules.files }
  })
}
