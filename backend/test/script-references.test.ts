import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { scriptStageArtifacts, scriptArtifactLabels } from '@video-studio/shared/script/script-stage-content'
import { referenceDocuments, decodeReferenceDocuments, referenceContext } from '../src/modules/script/script-references.js'
import { draftCompletenessFixtureResponse } from './fixtures/script-draft-completeness.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-references-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })
const document = { key: 'episode_script:1', title: '第1集测试文档', artifact_type: 'episode_script' as const, episode_number: 1, content: '测试剧情\n'.repeat(2000) + '结尾的关键事实' }

test('reference snapshots survive server round trips and legacy messages remain compatible', async () => {
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '文档引用测试' } })).json()
  const url = `/api/projects/${project.id}/script/conversations`
  const saved = await app.inject({ method: 'PUT', url, payload: { id: 'reference-conversation', messages: [{ id: 'user', role: 'user', text: '调整结尾', reference_documents: [document] }, { id: 'assistant', role: 'assistant', text: '建议缩短尾声' }] } })
  assert.equal(saved.statusCode, 200, saved.body)
  assert.deepEqual(saved.json().messages[0].reference_documents, [document])
  const loaded = (await app.inject({ method: 'GET', url })).json().conversations[0].messages
  assert.equal(loaded[0].text, '调整结尾')
  assert.deepEqual(loaded[0].reference_documents, [document])
  assert.deepEqual(loaded[1].reference_documents, [])
})

test('reference schemas reject duplicates and oversize bodies and tolerate old database rows', () => {
  assert.equal(referenceDocuments.safeParse([document, document]).success, false)
  assert.equal(referenceDocuments.safeParse([{ ...document, content: 'x'.repeat(100001) }]).success, false)
  assert.deepEqual(decodeReferenceDocuments(undefined), [])
  assert.deepEqual(decodeReferenceDocuments('invalid'), [])
  assert.ok(referenceContext([{ role: 'user', text: '分析结尾', reference_documents: [document] }]).includes('结尾的关键事实'))
})

test('all design subdocuments pass reference validation and decoding without losing their type or content', () => {
  for (const type of [...scriptStageArtifacts.locations, ...scriptStageArtifacts.props]) {
    const reference = { ...document, key: `${type}:0`, artifact_type: type, title: scriptArtifactLabels[type], episode_number: 0 }
    assert.deepEqual(referenceDocuments.parse([reference]), [reference])
    assert.deepEqual(decodeReferenceDocuments(JSON.stringify([reference])), [reference])
  }
})

test('intent sees reference metadata while the writer receives the full snapshot as data', async t => {
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '引用模型测试' } })).json()
  const provider = (await app.inject({ method: 'POST', url: '/api/providers', payload: { name: '引用测试', base_url: 'https://references.example/v1' } })).json()
  const model = (await app.inject({ method: 'POST', url: '/api/models', payload: { provider_id: provider.id, name: '文本模型', remote_id: 'test', modality: 'text', protocol: 'chat_completions', settings: { request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } } })).json()
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    calls++
    if (calls === 1) {
      assert.ok(prompt.includes(document.title))
      assert.ok(!prompt.includes('结尾的关键事实'))
    } else {
      assert.ok(prompt.includes('结尾的关键事实'))
      assert.ok(prompt.includes('调整结尾'))
      assert.ok(prompt.includes('仅作为参考资料'))
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: calls === 1 ? JSON.stringify({ action: 'discuss', settings_patch: {} }) : '建议保留关键事实，缩短尾声。' } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: { model_id: model.id, mode: 'script', messages: [{ role: 'user', text: '调整结尾', reference_documents: [document] }] } })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(calls, 2)

  globalThis.fetch = async (_url, init) => {
    const completeness = draftCompletenessFixtureResponse(init); if (completeness) return completeness
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const intent = prompt.includes('本次独立调用只理解创作者意图')
    if (!intent) assert.ok(prompt.includes('结尾的关键事实'), 'workflow writer must receive the full reference too')
    const content = intent ? { action: 'draft', operation: 'create', workflow: { stage: 'outline', episode_number: 1 }, creative_brief: '根据引用资料调整结尾', settings_patch: {} }
      : { artifacts: scriptStageArtifacts.outline.map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type], content: '保留关键事实' })), scenes: [] }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  const draft = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: { model_id: model.id, mode: 'script', workflow: { stage: 'outline', episode_number: 1 }, messages: [{ role: 'user', text: '根据引用资料调整结尾', reference_documents: [document] }] } })
  assert.equal(draft.statusCode, 200, draft.body)
  assert.equal(draft.json().draft.artifacts[0].content, '保留关键事实')

  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    assert.ok(prompt.includes('结尾的关键事实'), 'custom prompts must retain separately attached references')
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ outline: '大纲', characters: '人物', scenes: [{ heading: '测试场次', duration: 5 }] }) } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  const custom = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/generate`, payload: { model_id: model.id, idea: '使用引用资料', prompt_override: '自定义创作要求', reference_documents: [document] } })
  assert.equal(custom.statusCode, 200, custom.body)
})
