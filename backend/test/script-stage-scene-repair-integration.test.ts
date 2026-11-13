import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { workflowRequest } from '../src/modules/script/script-workflow.js'
import { draftCompletenessFixtureResponse } from './fixtures/script-draft-completeness.js'

const directory = await mkdtemp(join(tmpdir(), 'studio-stage-scene-repair-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, all } = await import('../src/infrastructure/database/db.js')
assert.equal(db.name, join(directory, 'studio.db'), 'scene repair integration uses an isolated temporary database')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function api(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<any> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
const artifacts = [{ artifact_type: 'outline', title: '归还钥匙', content: '林舟得到钥匙，调查旧约，查清钥匙的来历后按约归还故友。' }]
const scene = { heading: '院中归还', location: '院子', time_of_day: '日', characters: '林舟、故友', action: '林舟交还钥匙。', dialogue: '物归原主。', narration: '', duration: 10 }
const original = { artifacts, scenes: [scene] }

test('the real outline route corrects extra scenes once and returns an unchanged preview without saving formal data', async t => {
  for (const useTools of [true, false]) await t.test(useTools ? 'tool draft' : 'JSON draft', async t => {
    const project = await api('POST', '/api/projects', { name: '大纲分场自动修正回归' })
    const boundary = 'scene-repair-source'
    const uploaded = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/source`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="original.txt"\r\nContent-Type: text/plain\r\n\r\n${artifacts[0]!.content}\r\n--${boundary}--\r\n`) })
    assert.equal(uploaded.statusCode, 200, uploaded.body)
    await api('PUT', `/api/projects/${project.id}/script/artifacts`, { artifacts: [
      { artifact_type: 'characters', title: '已确认的人物', content: '林舟是一名返乡记者，故友是钥匙的主人。', status: 'ready' },
    ] })
    const provider = await api('POST', '/api/providers', { name: '阶段格式修复', base_url: 'https://scene-repair-fixture.invalid/v1' })
    const model = await api('POST', '/api/models', { provider_id: provider.id, name: '文本', remote_id: 'fixture', modality: 'text', protocol: 'responses',
      settings: { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' }, structured_output_mode: 'json_schema', text_path: 'output_text' } })
    const formal = async () => ({ script: (await api('GET', `/api/projects/${project.id}`)).script,
      source: all('SELECT * FROM script_source_documents WHERE project_id=?', project.id),
      revisions: all('SELECT * FROM script_source_revisions WHERE project_id=?', project.id) })
    const before = await formal(), generationNames: string[] = []
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.match(String(url), /scene-repair-fixture\.invalid/)
      const review = draftCompletenessFixtureResponse(init)
      if (review) return review
      const body = JSON.parse(String(init?.body)), prompt = body.input as string
      if (prompt.includes('本次独立调用只理解创作者意图')) return Response.json({ output_text: JSON.stringify({
        action: 'draft', operation: 'create', authorization: 'explicit', workflow: { stage: 'outline', intent: 'source_outline', artifact_types: ['outline'] },
        creative_brief: '忠实整理上传原稿中的故事，只生成一份完整大纲草稿供预览。',
      }) })
      const name = body.text.format.name as string
      generationNames.push(name)
      if (generationNames.length === 1) {
        assert.equal(name, 'workflow_draft')
        return Response.json({ output_text: JSON.stringify(original) })
      }
      assert.equal(generationNames.length, 2, 'the route must make only one format correction')
      assert.equal(name, 'script_stage_scene_repair')
      assert.ok(prompt.includes(JSON.stringify(original)), 'the correction receives the original candidate intact')
      assert.match(prompt, /逐字保留/)
      return Response.json({ output_text: JSON.stringify({ artifacts, scenes: [] }) })
    })
    const generated = await api('POST', `/api/projects/${project.id}/script/director/chat`, {
      model_id: model.id, mode: 'script', use_tools: useTools,
      workflow: workflowRequest.parse({ stage: 'outline', intent: 'source_outline', artifact_types: ['outline'] }),
      messages: [{ role: 'user', text: '根据上传原稿生成一份完整故事大纲，只交付大纲，先给我预览。' }],
    })
    assert.deepEqual(generationNames, ['workflow_draft', 'script_stage_scene_repair'])
    const draft = useTools ? generated.tool_draft.workflow : generated.draft
    assert.ok(draft, 'a corrected candidate is returned for creator confirmation')
    assert.deepEqual(draft.artifacts, artifacts, 'the correction preserves the complete original title and prose')
    assert.deepEqual(draft.scenes, [])
    if (useTools) {
      assert.equal(generated.tool_draft.status, 'pending')
      assert.deepEqual(generated.tool_draft.documents.map(({ artifact_type, title, content }: any) => ({ artifact_type, title, content })), artifacts)
    }
    assert.deepEqual(await formal(), before, 'the corrected preview cannot write accepted documents, the original manuscript or its revisions')
  })
})
