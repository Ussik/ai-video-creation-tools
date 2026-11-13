import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { GenerationModel } from '../src/infrastructure/providers/providers.js'

const directory = await mkdtemp(join(tmpdir(), 'studio-model-skills-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { initDb, db, run, all } = await import('../src/infrastructure/database/db.js')
const { initSkills, installSkillBundle, configureSkill, setSkillDefault, applySkillRules, skillContext, withSkillRules } = await import('../src/modules/skills/skills.js')
const { resolveCreationSkillContext, chooseCreationSkills } = await import('../src/modules/skills/model-skill-selection.js')
initDb(); initSkills()
run("INSERT INTO projects (id,name,brief,created_at,updated_at) VALUES ('project','模型选技','','now','now')")
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
function install(name: string, enabled = true, stages: Array<'script'|'image_prompt'> = ['script']) {
  const skill = installSkillBundle({ repo: 'test/model-skills', path: name, name, description: `说明 ${name}`, license: null,
    revision: 'a'.repeat(40), tool_requirements: [], suggested_stages: stages, url: '',
    files: [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: 说明 ${name}\n---\nRULE_${name}` }] })
  configureSkill(skill.id, enabled, stages)
  return skill.id
}
const standard = install('ordinary'), special = install('bespoke-story'), disabled = install('disabled', false), wrongStage = install('image-only', true, ['image_prompt'])
setSkillDefault('script', { primary_id: standard, auxiliary_ids: [] })
const options = { stage: 'script' as const, task: '她的决定太轻了，让观众感觉那次背叛真的有代价。', projectId: 'project', modelId: 'text',
  generate: async () => { throw new Error('unexpected content generation') } }

test('model chooses from descriptions for an ordinary natural request; selection is request-local', async () => {
  const before = all('SELECT * FROM skill_stage_defaults')
  const rules = await resolveCreationSkillContext({ ...options, select: async (_project, _model, input) => {
    assert.equal(input.task, options.task)
    assert.deepEqual(input.default_ids, [standard])
    assert.equal(input.skills.find(skill => skill.id === special)?.description, '说明 bespoke-story')
    assert.ok(input.skills.every(skill => skill.id !== disabled && skill.id !== wrongStage))
    return { skill_ids: [special], reason: '为人物决定补足可见的后果。' }
  } })
  assert.deepEqual(rules.assignment, { ids: [special], source: 'automatic', reason: '为人物决定补足可见的后果。' })
  assert.match(rules.text, /RULE_bespoke-story/)
  assert.doesNotMatch(rules.text, /RULE_ordinary/)
  assert.deepEqual(all('SELECT * FROM skill_stage_defaults'), before)
})

test('manual empty and explicit choices never ask the model; auto may choose no external skills', async () => {
  let calls = 0
  const select = async () => { calls++; return { skill_ids: [], reason: '本次仅需基础规则。' } }
  assert.deepEqual((await resolveCreationSkillContext({ ...options, select, selectedIds: [] })).assignment.ids, [])
  assert.deepEqual((await resolveCreationSkillContext({ ...options, select, selectedIds: [standard] })).assignment.ids, [standard])
  assert.equal(calls, 0)
  assert.deepEqual((await resolveCreationSkillContext({ ...options, select })).assignment.ids, [])
  assert.equal(calls, 1)
})

test('invalid, disabled, wrong-stage, duplicate selections and model failures stop before creative output', async () => {
  for (const skill_ids of [['missing'], [disabled], [wrongStage], [special, special]]) {
    await assert.rejects(resolveCreationSkillContext({ ...options, select: async () => ({ skill_ids, reason: '适用' }) }))
  }
  await assert.rejects(resolveCreationSkillContext({ ...options, select: async () => { throw new Error('model unavailable') } }), /model unavailable/)
})

test('an edited old preview removes stale rules even after a creator prepends their instruction', () => {
  const oldPreview = withSkillRules('script', '正文任务保持原样', undefined, { selections: { script: [standard] } })
  const updated = applySkillRules('我的前置要求：突出代价。\n' + oldPreview, skillContext('script', '', [special], 'project'))
  assert.equal((updated.match(/【主技能/g) || []).length, 1)
  assert.match(updated, /RULE_bespoke-story/); assert.doesNotMatch(updated, /RULE_ordinary/)
  assert.match(updated, /我的前置要求：突出代价/); assert.match(updated, /正文任务保持原样/)
})

test('explicit script prompt preview loads the fixed writer and never calls a selection model', async t => {
  const { buildApp } = await import('../src/app.js')
  const app = buildApp(); t.after(() => app.close())
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('preview must not call a model') })
  const automatic = await app.inject({ method: 'POST', url: '/api/projects/project/script/generate/prompt', payload: { idea: '雨夜车站' } })
  assert.equal(automatic.statusCode, 200, automatic.body)
  assert.match(automatic.json().prompt, /RULE_ordinary/)
  const manual = await app.inject({ method: 'POST', url: '/api/projects/project/script/generate/prompt', payload: { idea: '雨夜车站', skill_selections: { script: [standard] } } })
  assert.equal(manual.statusCode, 200, manual.body)
  assert.match(manual.json().prompt, /RULE_ordinary/)
})

const provider = { adapter: 'http' as const, base_url: 'https://test.invalid/v1', auth_header: 'Authorization', auth_prefix: 'Bearer ' }
const model = (protocol: 'responses'|'chat_completions'): GenerationModel => ({ id: 'text', remote_id: 'configured', modality: 'text', protocol,
  settings: { request_path: protocol === 'responses' ? 'responses' : 'chat/completions', stream: false,
    request_template: protocol === 'responses' ? { model: '{{model}}', input: '{{prompt}}' }
      : { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] } } })
const input = { stage: 'script' as const, task: options.task, skills: [{ id: special, name: 'bespoke-story', description: '人物决定与后果', revision: 'a' }], default_ids: [standard] }

test('native skill selection uses Function Calling on both protocols and validates the returned IDs', async t => {
  for (const protocol of ['responses', 'chat_completions'] as const) {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); calls++
      assert.ok(JSON.stringify(body).includes(options.task))
      assert.ok(JSON.stringify(body).includes('人物决定与后果'))
      const args = JSON.stringify({ skill_ids: [special], reason: '人物决定需要明确后果。' })
      assert.equal(body.tools[0].name || body.tools[0].function.name, 'select_creation_skills')
      return protocol === 'responses'
        ? Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'choice', name: 'select_creation_skills', arguments: args }] })
        : Response.json({ choices: [{ message: { tool_calls: [{ id: 'choice', type: 'function', function: { name: 'select_creation_skills', arguments: args } }] }, finish_reason: 'tool_calls' }] })
    })
    assert.deepEqual(await chooseCreationSkills(model(protocol), provider, input, () => 'test'), { skill_ids: [special], reason: '人物决定需要明确后果。' })
    assert.equal(calls, 1)
    t.mock.restoreAll()
  }
})

test('invalid native choices receive tool errors and are corrected; text-only output never activates defaults', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); calls++
    if (calls > 1) assert.ok(JSON.stringify(body).includes('未启用'))
    return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: `choice-${calls}`, name: 'select_creation_skills',
      arguments: JSON.stringify({ skill_ids: [calls === 1 ? disabled : special], reason: '按当前任务选择。' }) }] })
  })
  assert.deepEqual((await chooseCreationSkills(model('responses'), provider, input, () => '')).skill_ids, [special])
  assert.equal(calls, 2)
  t.mock.restoreAll()
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我建议使用默认技能' }] }] }))
  await assert.rejects(chooseCreationSkills(model('responses'), provider, input, () => ''), /未完成有效的技能选择/)
})

test('an automatic choice is reused only for an identical complete input and invalidates on any change', async () => {
  const { clearCreationSkillSelectionCache } = await import('../src/modules/skills/model-skill-selection.js')
  clearCreationSkillSelectionCache()
  let asked = 0
  const select = async (_p: string, _m: string, input: { skills: Array<{ id: string }> }) => { asked++; return { skill_ids: [input.skills.find(skill => skill.id === special)!.id], reason: '选择专用技能' } }
  const base = { ...options, select, reuseKey: 'config-A' }
  const first = await resolveCreationSkillContext(base)
  const second = await resolveCreationSkillContext(base)
  assert.equal(asked, 1, 'identical input does not ask the model again')
  assert.deepEqual(second.assignment.ids, first.assignment.ids)
  assert.equal((second.assignment as { reused?: boolean }).reused, true)
  assert.equal((first.assignment as { reused?: boolean }).reused, undefined)

  await resolveCreationSkillContext({ ...base, task: options.task + '（换了一个任务）' })
  assert.equal(asked, 2, 'a different task selects again')
  await resolveCreationSkillContext({ ...base, reuseKey: 'config-B' })
  assert.equal(asked, 3, 'a different model configuration selects again')
  await resolveCreationSkillContext(options.task ? { ...base, assignmentTask: { operation: 'revise' } as never } : base)
  assert.equal(asked, 4, 'different task context selects again')

  // A new skill revision changes the catalog the model chooses from.
  const updated = installSkillBundle({ repo: 'test/model-skills', path: 'bespoke-story', name: 'bespoke-story', description: '说明 bespoke-story', license: null,
    revision: 'b'.repeat(40), tool_requirements: [], suggested_stages: ['script'], url: '',
    files: [{ path: 'SKILL.md', content: '---\nname: bespoke-story\ndescription: 说明 bespoke-story\n---\nRULE_NEW_REVISION' }] }, special)
  assert.equal(updated.revision, 'b'.repeat(40))
  configureSkill(updated.id, true, ['script'])
  const afterUpdate = await resolveCreationSkillContext(base)
  assert.equal(asked, 5, 'a changed skill revision invalidates the reused choice')
  assert.match(afterUpdate.text, /RULE_NEW_REVISION/)

  // Manual selections are locked and never consult or populate the cache.
  const manual = await resolveCreationSkillContext({ ...base, selectedIds: [standard] })
  assert.equal(asked, 5); assert.equal(manual.assignment.source, 'manual')
  // Without a reuse key (other entry points) behaviour is unchanged.
  await resolveCreationSkillContext({ ...options, select }); await resolveCreationSkillContext({ ...options, select })
  assert.equal(asked, 7)
})
