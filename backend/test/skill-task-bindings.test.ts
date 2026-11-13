import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fixedSkillTask, skillTaskDefinitions } from '@video-studio/shared/skills/skill-recommendation'
import type { SkillStage } from '../src/modules/skills/skills.js'

const directory = await mkdtemp(join(tmpdir(), 'fixed-skill-bindings-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, run, all } = await import('../src/infrastructure/database/db.js')
const { configureSkill, installSkillBundle, removeInstalledSkill, fixedSkillContext, skillTaskPolicies, setSkillTaskDefault, skillPolicy, setSkillDefault } = await import('../src/modules/skills/skills.js')
const { resolveCreationSkillContext } = await import('../src/modules/skills/model-skill-selection.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, status = 200) {
  const response = await app.inject({ method, url, ...(payload ? { payload } : {}) })
  assert.equal(response.statusCode, status, response.body)
  return response.json()
}
function install(name: string, stage: SkillStage) {
  const skill = installSkillBundle({ repo: 'fixture/fixed-bindings', path: name, name, description: `方法 ${name}`,
    license: null, revision: 'a'.repeat(40), tool_requirements: [], suggested_stages: [stage], url: '',
    files: [{ path: `${name}/SKILL.md`, content: `---\nname: ${name}\ndescription: 方法 ${name}\n---\nRULE_${name}` },
      ...(name === 'sw-dialogue' ? [{ path: `${name}/reference.md`, content: '对白潜台词与人物口吻参考' }] : [])] })
  configureSkill(skill.id, true, [stage])
  return skill.id
}
const ids = Object.fromEntries(skillTaskDefinitions.map(task => [task.kind, install(task.primary_name, task.stage)]))
for (const stage of ['script', 'visual_assets', 'image_prompt', 'storyboard', 'video_prompt'] as const) {
  setSkillDefault(stage, { primary_id: ids[stage === 'script' ? 'script_write' : stage]!, auxiliary_ids: [] })
}
const policy = (task: string, projectId?: string) => skillTaskPolicies(projectId).find(item => item.task === task)!
const noModel = async (): Promise<never> => { throw new Error('fixed or manual assignments must not ask a model') }

test('explicit operations map to their own primary; free script discussion has no fixed task', async () => {
  const project = await call('POST', '/api/projects', { name: '固定创作任务' })
  assert.equal(skillTaskPolicies().length, 9)
  assert.equal(fixedSkillTask('script'), undefined)
  assert.equal(fixedSkillTask('script', { workflow_stage: 'outline' }), 'story_develop')
  assert.equal(fixedSkillTask('script', { workflow_stage: 'episode' }), 'script_write')
  assert.equal(fixedSkillTask('script', { operation: 'review' }), 'review')
  for (const task of skillTaskDefinitions) {
    const context = await resolveCreationSkillContext({ stage: task.stage, projectId: project.id, modelId: 'mock',
      task: '本次明确操作', assignmentTask: { task_kind: task.kind }, select: noModel, generate: noModel })
    assert.equal(context.assignment.source, 'fixed')
    assert.deepEqual(context.assignment.ids, [ids[task.kind]])
    assert.match(context.text, new RegExp(`RULE_${task.primary_name}`))
    assert.deepEqual(context.skills.map(skill => skill.role), ['primary'])
    assert.deepEqual(policy(task.kind).auxiliary_ids, [])
  }
  const dialogue = fixedSkillContext('script', '改善对白', project.id, { task_kind: 'dialogue_revision' })!
  assert.ok(dialogue.files.includes('sw-dialogue/reference.md'))
  assert.match(dialogue.text, /对白潜台词与人物口吻参考/)
  assert.throws(() => fixedSkillContext('image_prompt', '', project.id, { task_kind: 'dialogue_revision' }), /不匹配/)
})

test('manual IDs and manual base rules win; discussion still asks the selector and may select empty', async () => {
  const project = await call('POST', '/api/projects', { name: '三态覆盖' })
  const base = { stage: 'script' as const, projectId: project.id, modelId: 'mock', task: '讨论人物为什么犹豫', generate: noModel }
  for (const assignmentTask of [undefined, { task_kind: 'dialogue_revision' as const }]) {
    for (const selectedIds of [[], [ids.script_write!, ids.dialogue_revision!]]) {
      const context = await resolveCreationSkillContext({ ...base, assignmentTask, selectedIds, select: noModel })
      assert.equal(context.assignment.source, 'manual')
      assert.deepEqual(context.assignment.ids, selectedIds)
    }
  }
  let calls = 0
  for (const selectedIds of [[ids.dialogue_revision!], []]) {
    const context = await resolveCreationSkillContext({ ...base, select: async () => {
      calls++; return { skill_ids: selectedIds, reason: '按当前讨论选择。' }
    } })
    assert.equal(context.assignment.source, 'automatic')
    assert.deepEqual(context.assignment.ids, selectedIds)
  }
  assert.equal(calls, 2)
  const focused = await resolveCreationSkillContext({ ...base, stage: 'visual_assets', assignmentTask: { selection_mode: 'model', focus: 'character' },
    select: async () => { calls++; return { skill_ids: [], reason: '本轮只讨论人物，不整理设定。' } } })
  assert.equal(focused.assignment.source, 'automatic')
  assert.equal(calls, 3)
})

test('task settings preserve main/auxiliary order, project isolation, reset and explicit base mode', async () => {
  const p = await call('POST', '/api/projects', { name: '台词项目' }), q = await call('POST', '/api/projects', { name: '其他项目' })
  const auxiliary = install('humanizer-zh', 'script')
  const main = ids.dialogue_revision!
  await call('PUT', '/api/skills/task-defaults/dialogue_revision', { primary_id: main, auxiliary_ids: [auxiliary] })
  assert.deepEqual(policy('dialogue_revision', p.id).auxiliary_ids, [auxiliary])
  await call('PUT', `/api/projects/${p.id}/skills/task-defaults/dialogue_revision`, { primary_id: auxiliary, auxiliary_ids: [main] })
  assert.equal(policy('dialogue_revision', p.id).source, 'project')
  assert.equal(policy('dialogue_revision', q.id).source, 'global')
  assert.deepEqual(fixedSkillContext('script', '', p.id, { task_kind: 'dialogue_revision' })!.skills.map(skill => [skill.id, skill.role]), [[auxiliary, 'primary'], [main, 'auxiliary']])
  await call('DELETE', `/api/projects/${p.id}/skills/task-defaults/dialogue_revision`)
  assert.equal(policy('dialogue_revision', p.id).primary_id, main)
  await call('PUT', `/api/projects/${p.id}/skills/task-defaults/dialogue_revision`, { primary_id: null, auxiliary_ids: [] })
  assert.equal(fixedSkillContext('script', '', p.id, { task_kind: 'dialogue_revision' })!.text, '')
  for (const selection of [
    { primary_id: main, auxiliary_ids: [main] },
    { primary_id: null, auxiliary_ids: [auxiliary] },
    { primary_id: ids.image_prompt, auxiliary_ids: [] },
    { primary_id: 'missing', auxiliary_ids: [] },
  ]) await call('PUT', `/api/projects/${p.id}/skills/task-defaults/dialogue_revision`, selection, 422)
  assert.equal(policy('dialogue_revision', p.id).primary_id, null, 'invalid saves leave the last valid binding intact')
  await call('PUT', '/api/skills/task-defaults/no-task', { primary_id: main, auxiliary_ids: [] }, 422)
  await call('PUT', '/api/skills/task-defaults/dialogue_revision', { primary_id: main, auxiliary_ids: [] })
  await call('DELETE', `/api/projects/${p.id}`)
  assert.equal(all('SELECT * FROM project_skill_task_defaults WHERE project_id=?', p.id).length, 0)
})

test('legacy project overrides outrank new global task settings and both settings APIs stay synchronized', async () => {
  const project = await call('POST', '/api/projects', { name: '兼容已有默认' })
  const alternate = install('alternate-writer', 'script')
  // Simulate an existing project saved before task-specific defaults existed.
  run('INSERT INTO project_skill_defaults VALUES (?,?,?,?)', project.id, 'script', alternate, '[]')
  await call('PUT', '/api/skills/task-defaults/script_write', { primary_id: ids.script_write, auxiliary_ids: [ids.dialogue_revision] })
  assert.equal(policy('script_write', project.id).primary_id, alternate)
  assert.deepEqual(policy('script_write', project.id).auxiliary_ids, [])
  await call('PUT', `/api/projects/${project.id}/skills/defaults/script`, { primary_id: ids.script_write, auxiliary_ids: [alternate] })
  assert.deepEqual(policy('script_write', project.id).auxiliary_ids, [alternate])
  await call('PUT', `/api/projects/${project.id}/skills/task-defaults/script_write`, { primary_id: alternate, auxiliary_ids: [] })
  assert.equal(skillPolicy(project.id)[0].primary_id, alternate)
  await call('DELETE', `/api/projects/${project.id}/skills/task-defaults/script_write`)
  assert.equal(policy('script_write', project.id).source, 'global')
  assert.equal(skillPolicy(project.id)[0].source, 'global')
  setSkillDefault('script', { primary_id: ids.script_write!, auxiliary_ids: [] })
  assert.deepEqual(policy('script_write').auxiliary_ids, [])
  const response = await call('GET', `/api/projects/${project.id}/skills/defaults`)
  assert.equal(response.policies.length, 5); assert.equal(response.task_policies.length, 9)
  await call('PUT', '/api/skills/task-defaults/script_write', { primary_id: alternate, auxiliary_ids: [ids.dialogue_revision] })
  await call('DELETE', '/api/skills/task-defaults/script_write')
  assert.equal(policy('script_write').primary_id, ids.script_write)
  assert.deepEqual(policy('script_write').auxiliary_ids, [])
  await call('PUT', '/api/skills/task-defaults/dialogue_revision', { primary_id: alternate, auxiliary_ids: [] })
  const restored = await call('DELETE', '/api/skills/task-defaults/dialogue_revision')
  assert.equal(restored.policies.find((item: { task: string }) => item.task === 'dialogue_revision').source, 'builtin')
  assert.equal(policy('dialogue_revision').primary_id, ids.dialogue_revision)
})

test('disabled main, removed auxiliary and changed stage retain the binding and fail instead of substituting', async () => {
  const project = await call('POST', '/api/projects', { name: '绑定失效' })
  const primary = install('bound-review', 'script'), auxiliary = install('bound-review-aux', 'script')
  setSkillTaskDefault('review', { primary_id: primary, auxiliary_ids: [auxiliary] }, project.id)
  configureSkill(primary, false, ['script'])
  assert.equal(policy('review', project.id).primary_id, primary)
  assert.throws(() => fixedSkillContext('script', '', project.id, { operation: 'review' }), /停用、卸载或不适用/)
  configureSkill(primary, true, ['script'])
  removeInstalledSkill(auxiliary)
  assert.deepEqual(policy('review', project.id).auxiliary_ids, [auxiliary])
  assert.throws(() => fixedSkillContext('script', '', project.id, { operation: 'review' }), /停用、卸载或不适用/)
  setSkillTaskDefault('review', { primary_id: primary, auxiliary_ids: [] }, project.id)
  configureSkill(primary, true, ['image_prompt'])
  assert.throws(() => fixedSkillContext('script', '', project.id, { operation: 'review' }), /停用、卸载或不适用/)
})

test('an existing legacy global main remains identifiable when disabled even before a task row is saved', () => {
  const main = install('legacy-video', 'video_prompt')
  run('DELETE FROM skill_task_defaults WHERE task=?', 'video_prompt')
  run('UPDATE skill_stage_defaults SET primary_id=?,auxiliary_ids=? WHERE stage=?', main, '[]', 'video_prompt')
  configureSkill(main, false, ['video_prompt'])
  assert.equal(policy('video_prompt').primary_id, main)
  assert.match(policy('video_prompt').warning, /停用、卸载或不适用/)
  assert.throws(() => fixedSkillContext('video_prompt', ''), /停用、卸载或不适用/)
  configureSkill(main, true, ['video_prompt'])
})
