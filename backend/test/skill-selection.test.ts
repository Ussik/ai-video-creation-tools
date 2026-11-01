import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptArtifact, ScriptScene } from '../src/infrastructure/database/db.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-primary-skills-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db, all } = await import('../src/infrastructure/database/db.js')
const { installSkillBundle, configureSkill, removeInstalledSkill, skillPolicy, skillContext, setSkillDefault, withSkillRules, applySkillRules } = await import('../src/modules/skills/skills.js')
const { documentTools } = await import('../src/modules/script/script-document-tools.js')
const { directorStageContext } = await import('../src/modules/script/script-workflow.js')
const { analyzeVisualProfiles } = await import('../src/modules/visuals/visual-profiles.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })
async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, status = 200) {
  const result = await app.inject({ method, url, ...(payload ? { payload } : {}) }); assert.equal(result.statusCode, status, result.body); return result.json()
}
function install(name: string, stages: Parameters<typeof configureSkill>[2]) {
  const skill = installSkillBundle({ repo: 'test/default-skills', path: name, name, description: name, license: null, revision: 'a'.repeat(40),
    tool_requirements: [], suggested_stages: stages, url: '', files: [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: ${name}\n---\nRULE_${name}` }] })
  configureSkill(skill.id, true, stages); return skill.id
}
const policy = (stage: string, projectId?: string) => skillPolicy(projectId).find(item => item.stage === stage)!

test('five defaults adopt available skills, stay stable with alternatives and limit selection rather than installation', async () => {
  assert.equal(skillPolicy().length, 5)
  const main = install('short-drama-write', ['script']), a = install('alternate-a', ['script']), b = install('alternate-b', ['script']), c = install('alternate-c', ['script'])
  assert.equal(policy('script').primary_id, main); assert.equal(policy('script').skills.length, 4)
  assert.deepEqual(skillContext('script', '正文').skills.map(item => [item.id, item.role]), [[main, 'primary']])
  assert.deepEqual(skillContext('script', '正文', [main, a, b, c]).skills.map(item => item.id), [main, a, b, c])
  setSkillDefault('script', { primary_id: a, auxiliary_ids: [main, b] })
  assert.deepEqual(skillContext('script', '正文').skills.map(item => [item.id, item.role]), [[a, 'primary'], [main, 'auxiliary'], [b, 'auxiliary']])
  assert.throws(() => setSkillDefault('script', { primary_id: a, auxiliary_ids: [a] }))
  assert.throws(() => setSkillDefault('script', { primary_id: null, auxiliary_ids: [main] }))
  assert.throws(() => skillContext('image_prompt', '图片', [main]), /不适用/)
  setSkillDefault('script', { primary_id: main, auxiliary_ids: [] })
})

test('five auxiliaries survive global/project defaults and all six rules load; a sixth auxiliary is rejected', async () => {
  const main = policy('script').primary_id!
  const auxiliaries = Array.from({ length: 6 }, (_value, index) => install(`limit-aux-${index + 1}`, ['script']))
  const selected = auxiliaries.slice(0, 5), ids = [main, ...selected]
  await call('PUT', '/api/skills/defaults/script', { primary_id: main, auxiliary_ids: selected })
  const global = await call('GET', '/api/skills/defaults')
  assert.deepEqual(global.policies.find((item: { stage: string }) => item.stage === 'script').auxiliary_ids, selected)
  const p = await call('POST', '/api/projects', { name: '五个辅助技能' })
  await call('PUT', `/api/projects/${p.id}/skills/defaults/script`, { primary_id: main, auxiliary_ids: [...selected].reverse() })
  const local = await call('GET', `/api/projects/${p.id}/skills/defaults`)
  assert.deepEqual(local.policies.find((item: { stage: string }) => item.stage === 'script').auxiliary_ids, [...selected].reverse())
  const context = skillContext('script', '正文', undefined, p.id)
  assert.deepEqual(context.skills.map(item => [item.id, item.role]), [[main, 'primary'], ...[...selected].reverse().map(id => [id, 'auxiliary'])])
  const preview = await call('POST', `/api/projects/${p.id}/script/generate/prompt`, { idea: '夜班列车', skill_selections: { script: ids } })
  for (let index = 1; index <= 5; index++) assert.match(preview.prompt, new RegExp(`RULE_limit-aux-${index}`))
  assert.throws(() => skillContext('script', '正文', [main, ...auxiliaries]))
  await call('PUT', '/api/skills/defaults/script', { primary_id: main, auxiliary_ids: auxiliaries }, 422)
  await call('PUT', `/api/projects/${p.id}/skills/defaults/script`, { primary_id: main, auxiliary_ids: auxiliaries }, 422)
  assert.deepEqual(policy('script', p.id).auxiliary_ids, [...selected].reverse(), 'invalid saves must leave defaults intact')
  setSkillDefault('script', { primary_id: main, auxiliary_ids: [] })
})

test('project overrides are isolated; temporary selections never write defaults and explicit base mode is stable', async () => {
  const p = await call('POST', '/api/projects', { name: '主技能项目' }), q = await call('POST', '/api/projects', { name: '独立项目' })
  const global = policy('script').primary_id!, alternate = policy('script').skills.find(item => item.id !== global)!.id
  await call('PUT', `/api/projects/${p.id}/skills/defaults/script`, { primary_id: alternate, auxiliary_ids: [] })
  assert.equal(policy('script', p.id).source, 'project'); assert.equal(policy('script', p.id).primary_id, alternate)
  assert.equal(policy('script', q.id).primary_id, global)
  const preview = await call('POST', `/api/projects/${p.id}/script/generate/prompt`, { idea: '夜班列车', skill_selections: { script: [global] } })
  assert.match(preview.prompt, /RULE_short-drama-write/); assert.doesNotMatch(preview.prompt, /RULE_alternate/)
  assert.equal(policy('script', p.id).primary_id, alternate)
  const base = await call('POST', `/api/projects/${p.id}/script/generate/prompt`, { idea: '夜班列车', skill_selections: { script: [] } })
  assert.doesNotMatch(base.prompt, /RULE_/)
  await call('DELETE', `/api/projects/${p.id}/skills/defaults/script`)
  assert.equal(policy('script', p.id).source, 'global')
  await call('PUT', `/api/projects/${p.id}/skills/defaults/script`, { primary_id: null, auxiliary_ids: [] })
  install('another-choice', ['script']); assert.equal(policy('script', p.id).primary_id, null)
  await call('PUT', `/api/projects/${q.id}/skills/defaults/script`, { primary_id: 'missing', auxiliary_ids: [] }, 422)
  await call('PUT', '/api/skills/defaults/no-stage', { primary_id: global }, 422)
  await call('DELETE', `/api/projects/${p.id}`)
  assert.equal(all('SELECT * FROM project_skill_defaults WHERE project_id=?', p.id).length, 0)
})

test('unavailable project primaries warn and inherit; automatic fallback can adopt a later replacement', async () => {
  const p = await call('POST', '/api/projects', { name: '回退测试' }), temporary = install('temp-visual', ['visual_assets'])
  setSkillDefault('visual_assets', { primary_id: temporary, auxiliary_ids: [] }, p.id)
  removeInstalledSkill(temporary)
  assert.equal(policy('visual_assets', p.id).primary_id, null); assert.match(policy('visual_assets', p.id).warning, /停用或卸载/)
  const replacement = install('replacement-visual', ['visual_assets'])
  assert.equal(policy('visual_assets').primary_id, replacement)
  assert.throws(() => skillContext('visual_assets', '人物', [temporary], p.id), /重新选择/)
})

test('reapplying a changed selection replaces preview rules once and preserves edited task content', () => {
  const main = policy('script').primary_id!, alternate = policy('script').skills.find(item => item.id !== main)!.id
  const preview = withSkillRules('script', '人物正文：保留我编辑的内容', undefined, { selections: { script: [main] } })
  const updated = withSkillRules('script', preview, undefined, { selections: { script: [alternate] } })
  assert.equal((updated.match(/【主技能/g) || []).length, 1)
  assert.doesNotMatch(updated, /RULE_short-drama-write/); assert.match(updated, /保留我编辑的内容/)
  assert.equal(applySkillRules(updated, skillContext('script', '', [])), '人物正文：保留我编辑的内容')
})

test('actual generation replaces stale preview rules with the selected primary and preserves user edits', async t => {
  const p = await call('POST', '/api/projects', { name: '实际提交' })
  const provider = await call('POST', '/api/providers', { name: '模拟文本', base_url: 'https://skill-selection.invalid/v1' })
  const model = await call('POST', '/api/models', { provider_id: provider.id, name: '模拟模型', remote_id: 'text', modality: 'text', protocol: 'chat_completions',
    settings: { request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
  const main = policy('script').primary_id!, alternate = policy('script').skills.find(item => item.id !== main)!.id
  let captured = ''
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), 'https://skill-selection.invalid/v1/chat/completions')
    captured = JSON.parse(String(init?.body)).messages[0].content
    return Response.json({ choices: [{ message: { content: JSON.stringify({ outline: '林晚调查车站。', characters: '林晚：记者。', scenes: [{ heading: '车站', action: '进入车站', duration: 5 }] }) } }] })
  })
  const preview = await call('POST', `/api/projects/${p.id}/script/generate/prompt`, { idea: '夜班列车', skill_selections: { script: [main] } })
  await call('POST', `/api/projects/${p.id}/script/generate`, { model_id: model.id, idea: '夜班列车', prompt_override: preview.prompt + '\n我的编辑：保留车站主线。', skill_selections: { script: [alternate] } })
  assert.equal((captured.match(/【主技能/g) || []).length, 1)
  assert.doesNotMatch(captured, /RULE_short-drama-write/); assert.match(captured, /我的编辑：保留车站主线/)
  await call('POST', `/api/projects/${p.id}/script/generate`, { model_id: model.id, idea: '夜班列车', prompt_override: preview.prompt, skill_selections: { script: [] } })
  assert.doesNotMatch(captured, /RULE_/)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', p.id).length, 0)
})

test('visual organization accepts a model choice and explicit switching excludes other available rules', async () => {
  const p = await call('POST', '/api/projects', { name: '视觉主技能' }), scene = await call('POST', `/api/projects/${p.id}/script/scenes`, { heading: '车站', characters: '林晚' })
  const primary = policy('visual_assets').primary_id!, alternate = install('alternate-visual', ['visual_assets'])
  setSkillDefault('visual_assets', { primary_id: alternate, auxiliary_ids: [] }, p.id)
  let captured = ''
  const context = { selectSkills: async () => ({ skill_ids: [alternate], reason: '沿用项目默认中的合适视觉整理技能。' }), script: () => ({ outline: '车站救援', characters: '林晚', scenes: [scene] }), generateText: async (_id: string, _model: string, prompt: string) => {
    captured = prompt
    return JSON.stringify({ profiles: [{ kind: 'character', name: '林晚', variant: '默认', definition: '短发，雨衣', view_requirements: '正侧背三视图', scene_ids: [scene.id] }] })
  } }
  const inherited = await analyzeVisualProfiles(p.id, { model_id: 'mock', scene_ids: [scene.id] }, context)
  assert.deepEqual(inherited.skills.map(item => item.id), [alternate]); assert.match(captured, /RULE_alternate-visual/)
  assert.doesNotMatch(captured, /RULE_replacement-visual/)
  const switched = await analyzeVisualProfiles(p.id, { model_id: 'mock', scene_ids: [scene.id], skill_ids: [primary] }, context)
  assert.deepEqual(switched.skills.map(item => item.id), [primary]); assert.doesNotMatch(captured, /RULE_alternate-visual/)
  const base = await analyzeVisualProfiles(p.id, { model_id: 'mock', scene_ids: [scene.id], skill_ids: [] }, context)
  assert.deepEqual(base.skills, []); assert.doesNotMatch(captured, /RULE_/)
  assert.equal(all('SELECT * FROM visual_profiles WHERE project_id=?', p.id).length, 0)
})

test('function calls read without creative rules and explicitly load the frozen selection before resource drafting', async () => {
  const p = await call('POST', '/api/projects', { name: '函数技能' }), scene = await call('POST', `/api/projects/${p.id}/script/scenes`, { heading: '车站' })
  const selected = install('selected-board', ['storyboard']), alternative = install('alternative-board', ['storyboard'])
  const snapshot = () => ({ outline: '', characters: '', generation_options: {}, artifacts: all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=?', p.id), scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=?', p.id) })
  const frozen = skillContext('storyboard', '车站', [selected], p.id), video = install('selected-video', ['video_prompt'])
  const tools = documentTools({ project: p, script: snapshot, stage: directorStageContext(snapshot()), skillRules: { storyboard: frozen, video_prompt: skillContext('video_prompt', '修改运镜', [video], p.id) },
    messages: [{ role: 'user', text: '生成车站分镜' }], checkApproval: async () => false, authorizeResource: async () => true, onEvent: () => {} })
  const read = await tools.execute('get_storyboard_context', { scene_ids: [scene.id] }) as any
  assert.equal(read.creative_rules, undefined); assert.doesNotMatch(JSON.stringify(read), /RULE_/)
  const proposal = { summary: '车站镜头', scenes: [{ scene_id: scene.id, base_version: read.objects[0].version, shots: [{ title: '入站', prompt: '人物走入', image_prompt: '首帧站在入口', video_prompt: '走入车站', duration: 5 }] }] }
  await assert.rejects(tools.execute('propose_shot_plan', proposal), /load_creation_skills/)
  setSkillDefault('storyboard', { primary_id: alternative, auxiliary_ids: [] })
  const rules = await tools.execute('load_creation_skills', { stage: 'storyboard' }) as any
  assert.deepEqual(rules.skills.map((item: any) => item.id), [selected]); assert.match(rules.text, /RULE_selected-board/)
  assert.doesNotMatch(rules.text, /RULE_alternative-board/)
  const result = await tools.execute('propose_shot_plan', proposal) as any
  assert.ok(result.draft_id); assert.equal(result.saved, false)
  const draft = await tools.execute('manage_document_draft', { operation: 'read', draft_id: result.draft_id }) as any
  const edit = { operation: 'update', draft_id: draft.id, version: draft.version, resource_values: [{ index: 0, value: { ...draft.resource_changes[0].value, video_prompt: '走入车站，跟拍' } }] }
  await assert.rejects(tools.execute('manage_document_draft', edit), /video_prompt/)
  await tools.execute('load_creation_skills', { stage: 'video_prompt' })
  await tools.execute('manage_document_draft', edit)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', p.id).length, 0)
})
