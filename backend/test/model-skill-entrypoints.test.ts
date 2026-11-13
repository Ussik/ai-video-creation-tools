import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify from 'fastify'
import type { ScriptScene } from '../src/infrastructure/database/db.js'
import type { SkillStage } from '../src/modules/skills/skills.js'
import type { OutputContract } from '../src/modules/generation/model-output.js'
import { semanticReviewFixture } from './helpers/prompt-refinement-semantics.js'
import { storyboardBatchFixture, storyboardOutlineFixture, withStoryboardDirecting } from './helpers/storyboard-directing.js'

const directory = await mkdtemp(join(tmpdir(), 'model-skill-entrypoints-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, all } = await import('../src/infrastructure/database/db.js')
const { installSkillBundle, configureSkill, removeInstalledSkill, skillPolicy } = await import('../src/modules/skills/skills.js')
const { registerSkillRoutes } = await import('../src/modules/skills/skill-routes.js')
const { registerStoryboardPlanningRoutes } = await import('../src/modules/storyboard/storyboard-planning.js')
const { registerVisualProfileRoutes } = await import('../src/modules/visuals/visual-profiles.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function create(url: string, payload: object) {
  const response = await app.inject({ method: 'POST', url, payload })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
function install(name: string, stage: SkillStage, marker: string) {
  const skill = installSkillBundle({ repo: 'fixture/model-entrypoints', path: name, name,
    description: `${name}的专业创作方法`, revision: 'a'.repeat(40), license: null, tool_requirements: [],
    suggested_stages: [stage], url: 'https://example.invalid',
    files: [{ path: `${name}/SKILL.md`, content: `---\nname: ${name}\ndescription: 专业创作规则\n---\n${marker}` }] })
  configureSkill(skill.id, true, [stage])
  return skill.id
}

for (const stage of ['image_prompt', 'storyboard', 'visual_assets'] as const) {
  test(`${stage} uses the fixed binding without selection and preserves manual IDs and empty selection`, async t => {
    const defaultId = install(`${stage}-ordinary`, stage, 'DEFAULT_RULE_MARKER')
    const chosenId = install(`${stage}-specialized`, stage, 'MODEL_CHOSEN_RULE_MARKER')
    t.after(() => { removeInstalledSkill(chosenId); removeInstalledSkill(defaultId) })
    const project = await create('/api/projects', { name: '按语义选择技能' })
    const scene = await create(`/api/projects/${project.id}/script/scenes`, { heading: '走廊', duration: 20, action: '阿宁等待门开。' }) as ScriptScene
    const beforeDefaults = skillPolicy(project.id)
    const isolated = Fastify()
    t.after(() => isolated.close())
    let selectionCalls = 0, generationCalls = 0, outlineReviews = 0
    let expected: 'default' | 'manual' | 'base' = 'default'
    const selectSkills = async (): Promise<never> => {
      selectionCalls++
      throw new Error('known creation operations must not call a skill selector')
    }
    const generateText = async (_projectId: string, _modelId: string, prompt: string, contract?: OutputContract) => {
      if (contract?.name === 'prompt_refinement_semantic_review') return JSON.stringify(semanticReviewFixture())
      if (contract?.name === 'storyboard_directing_review') return JSON.stringify({ issues: [] })
      if (expected === 'manual') assert.match(prompt, /MODEL_CHOSEN_RULE_MARKER/)
      else assert.doesNotMatch(prompt, /MODEL_CHOSEN_RULE_MARKER/)
      if (expected === 'default') assert.match(prompt, /DEFAULT_RULE_MARKER/)
      else assert.doesNotMatch(prompt, /DEFAULT_RULE_MARKER/)
      if (contract?.name === 'storyboard_outline_review') {
        outlineReviews++; assert.match(prompt, /规则服从本次创作者要求、项目事实、正式来源和JSON契约/)
        assert.match(prompt, /本次自动提供的最新正式分集正文优先于旧场次和已有镜头/)
        return JSON.stringify({ issues: [] })
      }
      generationCalls++
      const fixture = withStoryboardDirecting(stage === 'image_prompt' ? { prompt: '门外的人影落在走廊地面，阿宁等待门开。' }
        : stage === 'visual_assets' ? { profiles: [] }
        : { scenes: [{ scene_id: scene.id, scene_duration: 20, shots: [{ shot_id: null, title: '等待', duration: 20,
          prompt: '阿宁等待门开', image_prompt: '阿宁站在走廊', video_prompt: '门缓慢打开',
          audio_plan: { version: 1, speech: [], sound_effects: [], music: '', silent: true },
          start_state: '门关闭', end_state: '门打开', cut_note: '连续' }] }] })
      return JSON.stringify(contract?.name === 'storyboard_scene_plan' ? storyboardOutlineFixture(fixture)
        : contract?.name === 'storyboard_shot_batch' ? storyboardBatchFixture(fixture, contract) : fixture)
    }
    const script = () => ({ outline: '走廊等候', characters: '阿宁', scenes: [scene] })
    let endpoint: string, payload: Record<string, unknown>
    if (stage === 'image_prompt') {
      registerSkillRoutes(isolated, { generateText, selectSkills })
      endpoint = `/api/projects/${project.id}/skills/refine-prompt`
      payload = { model_id: 'mock-text', stage, prompt: '阿宁等待门开。', adjustment_request: '让门外的人影先于本人出现' }
    } else if (stage === 'visual_assets') {
      registerVisualProfileRoutes(isolated, { script, generateText, selectSkills })
      endpoint = `/api/projects/${project.id}/visual-profiles/analyze`
      payload = { model_id: 'mock-text', scene_ids: [scene.id] }
    } else {
      registerStoryboardPlanningRoutes(isolated, { script, scenePrompt: value => value.heading, generateText, selectSkills })
      const context = await isolated.inject({ method: 'POST', url: `/api/projects/${project.id}/script/storyboard/context`, payload: { scene_ids: [scene.id] } })
      assert.equal(context.statusCode, 200, context.body)
      endpoint = `/api/projects/${project.id}/script/storyboard/plan`
      payload = { model_id: 'mock-text', scene_ids: [scene.id], signature: context.json().signature }
    }
    const response = await isolated.inject({ method: 'POST', url: endpoint, payload })
    assert.equal(response.statusCode, 200, response.body)
    const result = response.json()
    assert.equal(result.skill_assignment.source, 'fixed')
    assert.deepEqual(result.skill_assignment.ids, [defaultId])
    assert.match(result.skill_assignment.reason, /绑定/)
    assert.deepEqual((result.used_skills || result.skills).map((skill: { id: string }) => skill.id), [defaultId])
    expected = 'manual'
    const selected = await isolated.inject({ method: 'POST', url: endpoint, payload: { ...payload, skill_ids: [chosenId] } })
    assert.equal(selected.statusCode, 200, selected.body)
    assert.deepEqual(selected.json().skill_assignment.ids, [chosenId])
    assert.equal(selected.json().skill_assignment.source, 'manual')
    expected = 'base'
    const manual = await isolated.inject({ method: 'POST', url: endpoint, payload: { ...payload, skill_ids: [] } })
    assert.equal(manual.statusCode, 200, manual.body)
    assert.deepEqual(manual.json().skill_assignment.ids, [])
    assert.equal(manual.json().skill_assignment.source, 'manual')
    assert.equal(selectionCalls, 0); assert.equal(generationCalls, stage === 'storyboard' ? 6 : 3)
    assert.equal(outlineReviews, stage === 'storyboard' ? 3 : 0)
    assert.deepEqual(skillPolicy(project.id), beforeDefaults)
    assert.equal(all('SELECT id FROM shots WHERE project_id=?', project.id).length, 0)
    assert.equal(all('SELECT id FROM visual_profiles WHERE project_id=?', project.id).length, 0)
    assert.equal(all('SELECT id FROM jobs WHERE project_id=?', project.id).length, 0)
  })
}
