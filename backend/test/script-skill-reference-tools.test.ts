import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { GenerationModel } from '../src/infrastructure/providers/providers.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-skill-reference-tools-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db, all } = await import('../src/infrastructure/database/db.js')
const { installSkillBundle, configureSkill } = await import('../src/modules/skills/skills.js')
const { documentTools, runScriptTools } = await import('../src/modules/script/script-document-tools.js')
const { directorStageContext } = await import('../src/modules/script/script-workflow.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

let sequence = 0
function install(references = [{ path: 'references/craft.md', content: '# 叙事选择\n完整规则：结合人物的目标和当前处境判断，不能根据词语删减台词。' }]) {
  const name = `reference-tools-${++sequence}`
  const bundle = { repo: 'test/reference-tools', path: name, name, description: '用于检验模型按需读取资料', license: null,
    revision: 'a'.repeat(40), tool_requirements: [], suggested_stages: ['script' as const], url: '',
    files: [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: 创作规则\n---\n根据创作者要求完成作品。` }, ...references] }
  const skill = installSkillBundle(bundle)
  configureSkill(skill.id, true, ['script'])
  return { skill, bundle, references }
}
async function fixture(skillId?: string) {
  const response = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '技能按需读取' } })
  assert.equal(response.statusCode, 200, response.body)
  const project = response.json()
  const snapshot = () => ({ outline: '', characters: '', generation_options: {}, artifacts: [], scenes: [] })
  const context = (extra: Partial<Parameters<typeof documentTools>[0]> = {}) => ({ project, script: snapshot,
    stage: directorStageContext(snapshot()), skillSelections: skillId ? { script: [skillId] } : {},
    messages: [{ role: 'user' as const, text: '请分析人物处境，再决定怎样完成创作。' }],
    checkApproval: async () => false, onEvent: () => {}, ...extra })
  return { project, context }
}
const readArgs = (reference: any) => ({ stage: 'script', skill_id: reference.skill_id, revision: reference.revision, path: reference.path })

test('optional skill files have an explicit frozen catalog and are read without changing selection', async () => {
  const { skill, references } = install(), { context } = await fixture(skill.id), tools = documentTools(context())
  await assert.rejects(tools.execute('read_creation_skill_reference', { stage: 'script', skill_id: skill.id, revision: skill.revision, path: references[0]!.path }), /先调用load_creation_skills/)
  const loaded = await tools.execute('load_creation_skills', { stage: 'script' }) as any
  assert.equal(loaded.selection_mode, 'manual')
  assert.equal(loaded.available_references.length, 1)
  assert.doesNotMatch(loaded.text, /完整规则/)
  assert.deepEqual(loaded.files, ['SKILL.md'])
  const reference = loaded.available_references[0]
  const result = await tools.execute('read_creation_skill_reference', readArgs(reference)) as any
  assert.equal(result.content, references[0]!.content)
  assert.deepEqual(result.skills.map((item: any) => item.id), [skill.id])
  assert.deepEqual(result.skills[0].files, ['SKILL.md', reference.path])
  const repeat = await tools.execute('read_creation_skill_reference', readArgs(reference)) as any
  assert.equal(repeat.reused, true)
  assert.equal(repeat.context_characters, result.context_characters)
  const state = await tools.execute('get_creation_state', {}) as any
  assert.equal(state.creation_skills[0].available_references[0].loaded, true)
  await assert.rejects(tools.execute('load_creation_skills', { stage: 'script', skill_ids: [], reason: '切换' }), /手动锁定/)
})

test('reference tools reject unselected skills, wrong revisions and uncatalogued paths', async () => {
  const { skill } = install(), foreign = install().skill, { context } = await fixture(skill.id), tools = documentTools(context())
  const loaded = await tools.execute('load_creation_skills', { stage: 'script' }) as any
  const args = readArgs(loaded.available_references[0])
  for (const changes of [{ skill_id: foreign.id }, { revision: 'b'.repeat(40) }, { path: '../SKILL.md' }, { path: '/etc/passwd' }, { path: 'SKILL.md' }, { path: 'references/missing.md' }]) {
    await assert.rejects(tools.execute('read_creation_skill_reference', { ...args, ...changes }), /锁定技能|精确资料路径/)
  }
})

test('reference reads reject installed skill changes after the catalog was frozen', async () => {
  const { skill, bundle } = install(), { context } = await fixture(skill.id), tools = documentTools(context())
  const loaded = await tools.execute('load_creation_skills', { stage: 'script' }) as any
  const args = readArgs(loaded.available_references[0])
  installSkillBundle({ ...bundle, revision: 'b'.repeat(40) }, skill.id)
  await assert.rejects(tools.execute('read_creation_skill_reference', args), /已更新|锁定技能/)
  installSkillBundle({ ...bundle, files: bundle.files.map(file => file.path === args.path ? { ...file, content: '同版本下已变化的参考资料。' } : file) }, skill.id)
  await assert.rejects(tools.execute('read_creation_skill_reference', args), /已更新|锁定技能/)
  const second = install(), secondContext = await fixture(second.skill.id), secondTools = documentTools(secondContext.context())
  const secondLoaded = await secondTools.execute('load_creation_skills', { stage: 'script' }) as any
  configureSkill(second.skill.id, false, ['script'])
  await assert.rejects(secondTools.execute('read_creation_skill_reference', readArgs(secondLoaded.available_references[0])), /未启用|不适用/)
})

test('optional file reading enforces an aggregate limit without partial provenance changes', async () => {
  const { skill } = install([{ path: 'references/one.md', content: '甲'.repeat(55_000) }, { path: 'references/two.md', content: '乙'.repeat(55_000) }])
  const { context } = await fixture(skill.id), tools = documentTools(context())
  const loaded = await tools.execute('load_creation_skills', { stage: 'script' }) as any
  const [one, two] = loaded.available_references
  await tools.execute('read_creation_skill_reference', readArgs(one))
  await assert.rejects(tools.execute('read_creation_skill_reference', readArgs(two)), /合计超过100000/)
  const after = await tools.execute('load_creation_skills', { stage: 'script' }) as any
  assert.deepEqual(after.skills[0].files, ['SKILL.md', one.path])
  assert.doesNotMatch(after.text, /乙/)
})

test('the optional reference budget spans every loaded stage in the same execution', async () => {
  const first = install([{ path: 'references/large.md', content: '甲'.repeat(55_000) }]), second = install([{ path: 'references/large.md', content: '乙'.repeat(55_000) }])
  configureSkill(second.skill.id, true, ['script', 'storyboard'])
  const { context } = await fixture(first.skill.id)
  const tools = documentTools(context({ skillSelections: { script: [first.skill.id], storyboard: [second.skill.id] } }))
  const script = await tools.execute('load_creation_skills', { stage: 'script' }) as any
  await tools.execute('read_creation_skill_reference', readArgs(script.available_references[0]))
  const storyboard = await tools.execute('load_creation_skills', { stage: 'storyboard' }) as any
  await assert.rejects(tools.execute('read_creation_skill_reference', { ...readArgs(storyboard.available_references[0]), stage: 'storyboard' }), /合计超过100000/)
  assert.deepEqual(storyboard.skills[0].files, ['SKILL.md'])
})

test('native stage tools pass optional content to the model and record exact provenance', async t => {
  const { skill, references } = install(), { project, context } = await fixture(skill.id)
  const model: GenerationModel = { id: 'mock', remote_id: 'mock', modality: 'text', protocol: 'chat_completions',
    settings: { request_path: 'chat/completions', stream: false, request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] } } }
  let requests = 0
  const call = (name: string, args: unknown) => Response.json({ choices: [{ message: { tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests++
    assert.ok(body.tools.some((tool: any) => tool.function.name === 'read_creation_skill_reference'))
    if (requests === 1) return call('load_creation_skills', { stage: 'script' })
    const output = JSON.parse(body.messages.at(-1).content)
    if (requests === 2) return call('read_creation_skill_reference', readArgs(output.result.available_references[0]))
    assert.equal(output.result.content, references[0]!.content)
    return Response.json({ choices: [{ message: { content: '已阅读资料并完成分析。' }, finish_reason: 'stop' }] })
  })
  const result = await runScriptTools({ ...context({ workflow: 'outline' }), model,
    provider: { adapter: 'http', base_url: 'https://reference-tools.invalid/v1' }, prompt: '读取适用规则后处理本轮任务。', resolveKey: () => '' })
  assert.equal(requests, 3)
  assert.ok(result.activity.some(item => item.kind === 'skill' && item.skill_id === skill.id && item.revision === skill.revision && item.files?.includes(references[0]!.path)))
  const read = result.activity.find(item => item.name === 'read_creation_skill_reference')!
  assert.ok(read.output)
  assert.doesNotMatch(read.output, /完整规则/)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', project.id).length, 0)
  assert.equal(all('SELECT * FROM script_artifacts WHERE project_id=?', project.id).length, 0)
})
