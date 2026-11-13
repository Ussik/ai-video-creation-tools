import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { draftCompletenessFixtureResponse } from './fixtures/script-draft-completeness.js'

const directory = await mkdtemp(join(tmpdir(), 'studio-episode-scene-continuation-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, all } = await import('../src/infrastructure/database/db.js')
assert.equal(db.name, join(directory, 'studio.db'), 'episode continuation regression uses an isolated database')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function api(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<any> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
const artifacts = [{ artifact_type: 'episode_script', title: '第1集：院中归还',
  content: '第一场 院子 日\n出场人物：林舟、故友。\n林舟走进院子，将旧钥匙放在故友掌心。\n林舟：“物归原主。”\n故友握紧钥匙，打开旧门。门后传来久违的钟声。' }]
const scene = { heading: '院中归还', location: '院子', time_of_day: '日', characters: '林舟、故友',
  action: '林舟走进院子，将旧钥匙交还故友；故友握紧钥匙，打开旧门。', dialogue: '林舟：“物归原主。”', narration: '门后传来久违的钟声。', duration: 20 }

async function fixture(auto = false) {
  const project = await api('POST', '/api/projects', { name: '完整分集正文缺场次回归' })
  await api('PUT', `/api/projects/${project.id}/script/artifacts`, { artifacts:
    (['outline', 'characters', 'locations', 'props'] as const).flatMap(stage => scriptStageArtifacts[stage].map(artifact_type => ({
      artifact_type, title: scriptArtifactLabels[artifact_type], content: '林舟依照旧约把旧钥匙交还故友，在院子打开旧门，门后钟声响起。', status: 'ready',
    }))),
  })
  const provider = await api('POST', '/api/providers', { name: '离线分场接续', base_url: 'https://episode-scenes-fixture.invalid/v1' })
  const model = await api('POST', '/api/models', { provider_id: provider.id, name: '文本', remote_id: 'fixture', modality: 'text', protocol: 'responses',
    settings: { text_api: auto ? { mode: 'standard', output_mode: 'auto' } : { mode: 'standard', max_output_tokens: 65536 },
      ...(auto ? { text_capabilities: { version: 1, override: { budget_mode: 'separate', input_tokens: 1000000, output_tokens: 40000 } } } : {}),
      structured_output_mode: 'json_schema', context_window_tokens: 1000000 } })
  const formal = () => ({
    script: all('SELECT * FROM scripts WHERE project_id=?', project.id),
    documents: all('SELECT * FROM script_artifacts WHERE project_id=? ORDER BY position', project.id),
    scenes: all('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position', project.id),
    source: all('SELECT * FROM script_source_documents WHERE project_id=?', project.id),
    revisions: all('SELECT * FROM script_source_revisions WHERE project_id=?', project.id),
  })
  return { project, model, formal }
}

test('successful model responses missing episode scenes continue in the same request and preserve the complete preview', { timeout: 30000 }, async t => {
  for (const auto of [false, true]) for (const explicitContract of [false, true]) for (const useTools of [true, false]) for (const omitted of auto ? [true] : [false, true]) {
    await t.test(`${auto ? 'auto capacity' : 'legacy fixed65536'} / ${explicitContract ? 'stream, explicit' : 'JSON, legacy'} contract / ${useTools ? 'tool' : 'JSON'} draft / scenes ${omitted ? 'omitted' : 'empty'}`, async t => {
      const f = await fixture(auto), before = f.formal(), generationNames: string[] = []
      let reviews = 0
      t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.match(String(url), /episode-scenes-fixture\.invalid/)
        const review = draftCompletenessFixtureResponse(init)
        if (review) {
          if (auto) assert.equal(JSON.parse(String(init?.body)).max_output_tokens, 32768, 'review receives its actual automatic request budget')
          reviews++; return review
        }
        const body = JSON.parse(String(init?.body)), prompt = body.input as string
        assert.equal(body.max_output_tokens, auto ? 40000 : 65536, 'generation uses the actual request budget and preserves fixed65536')
        if (prompt.includes('本次独立调用只理解创作者意图')) return Response.json({ output_text: JSON.stringify({
          action: 'draft', operation: 'create', authorization: 'explicit',
          workflow: { stage: 'episode', scope: 'episode', episode_number: 1, intent: 'stage_design', artifact_types: ['episode_script'] },
          creative_brief: '生成第1集完整剧本正文及对应分场，先提供草稿预览。',
        }) })
        const name = body.text.format.name as string
        generationNames.push(name)
        if (generationNames.length === 1) {
          assert.equal(name, 'workflow_draft')
          assert.ok(body.text.format.schema.required.includes('scenes'), 'episode wire schema requires scenes')
          assert.equal(body.text.format.schema.properties.scenes.minItems, 1)
          return Response.json({ output_text: JSON.stringify({ artifacts, ...(omitted ? {} : { scenes: [] }) }) })
        }
        assert.equal(generationNames.length, 2, 'no whole-document retry or unbounded repair')
        assert.equal(name, 'script_stage_blocks')
        assert.match(prompt, /正文文档已完整，保持正文不变/)
        assert.ok(prompt.includes(artifacts[0]!.content) || prompt.includes(JSON.stringify(artifacts[0]!.content).slice(1, -1)), 'the scene continuation receives the preserved full prose')
        assert.deepEqual(f.formal(), before, 'continuing scenes cannot write accepted data')
        return Response.json({ output_text: JSON.stringify({ blocks: [{ id: 'scene:1', title: '院中归还', content: '', scenes: [scene] }], complete: true }) })
      })
      const workflow = { stage: 'episode', scope: 'episode', episode_number: 1,
        ...(explicitContract ? { intent: 'stage_design', artifact_types: ['episode_script'] } : {}) }
      const response = await app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/director/chat${explicitContract ? '/stream' : ''}`,
        payload: { model_id: f.model.id, mode: 'script', use_tools: useTools, workflow,
          messages: [{ role: 'user', text: '按已确认资料生成第1集完整剧本及对应分场，先给我预览，不保存。' }] } })
      assert.equal(response.statusCode, 200, response.body)
      const generated = explicitContract
        ? response.body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).find(event => event.type === 'done')
        : response.json()
      assert.ok(generated, response.body)
      assert.deepEqual(generationNames, ['workflow_draft', 'script_stage_blocks'])
      assert.equal(reviews, 1, 'the completed candidate still passes the independent review')
      const draft = useTools ? generated.tool_draft?.workflow : generated.draft
      assert.ok(draft, response.body)
      assert.deepEqual(draft.artifacts, artifacts, 'original title and prose remain unchanged')
      assert.deepEqual(draft.scenes, [scene], 'only the missing scenes are appended')
      if (useTools) assert.equal(generated.tool_draft.status, 'pending')
      assert.deepEqual(f.formal(), before, 'preview and independent review cannot write accepted documents, scenes or source')
    })
  }
})

test('a failed scene-only request retains the episode checkpoint and the real route resumes without regenerating prose', async t => {
  for (const useTools of [true, false]) await t.test(useTools ? 'tool draft' : 'JSON draft', async t => {
    const f = await fixture(), before = f.formal(), contracts: string[] = []
    let failSceneRequest = true, reviews = 0
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.match(String(url), /episode-scenes-fixture\.invalid/)
      const review = draftCompletenessFixtureResponse(init)
      if (review) { reviews++; return review }
      const body = JSON.parse(String(init?.body)), name = body.text.format.name as string
      contracts.push(name)
      if (name === 'workflow_draft') {
        assert.equal(contracts.length, 1, 'an explicit resume cannot regenerate the retained episode')
        return Response.json({ output_text: JSON.stringify({ artifacts, scenes: [] }) })
      }
      assert.equal(name, 'script_stage_blocks')
      assert.match(body.input, /模式：scenes/)
      if (failSceneRequest) return Response.json({ error: { type: 'invalid_request_error', message: '离线补场故障' } }, { status: 400 })
      return Response.json({ output_text: JSON.stringify({ blocks: [{ id: 'scene:1', title: '院中归还', content: '', scenes: [scene] }], complete: true }) })
    })
    const payload = { model_id: f.model.id, mode: 'script', use_tools: useTools,
      workflow: { stage: 'episode', scope: 'episode', episode_number: 1, intent: 'stage_design', artifact_types: ['episode_script'] },
      messages: [{ role: 'user', text: '生成第1集完整正文和分场，先给我预览。' }] }
    const url = `/api/projects/${f.project.id}/script/director/chat`
    const failed = await app.inject({ method: 'POST', url, payload })
    assert.ok(failed.statusCode >= 400, failed.body)
    assert.match(failed.body, /离线补场故障/)
    assert.deepEqual(contracts, ['workflow_draft', 'script_stage_blocks'])
    assert.equal(reviews, 0, 'an incomplete scene delivery cannot reach review or publish a candidate')
    const checkpoints = all<{ payload: string }>('SELECT payload FROM script_generation_checkpoints WHERE project_id=?', f.project.id)
    assert.equal(checkpoints.length, 1)
    const retained = JSON.parse(checkpoints[0]!.payload).steps['work:episode:episode/draft:stream:state'].value
    assert.deepEqual(retained.artifacts, artifacts)
    assert.deepEqual(retained.scenes, [])
    assert.equal(retained.mode, 'scenes')
    assert.deepEqual(f.formal(), before)
    failSceneRequest = false
    const resumed = await api('POST', url, payload)
    assert.deepEqual(contracts, ['workflow_draft', 'script_stage_blocks', 'script_stage_blocks'])
    assert.equal(reviews, 1)
    const draft = useTools ? resumed.tool_draft.workflow : resumed.draft
    assert.deepEqual(draft.artifacts, artifacts)
    assert.deepEqual(draft.scenes, [scene])
    assert.deepEqual(f.formal(), before)
  })
})
