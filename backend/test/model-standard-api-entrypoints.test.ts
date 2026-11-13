import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { migrateStandardTextSettings, type TextApiProtocol } from '@video-studio/shared/models/text-api-settings'

const directory = await mkdtemp(join(tmpdir(), 'model-standard-api-entrypoints-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { all, db, one } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function post(url: string, payload: object) {
  const result = await app.inject({ method: 'POST', url, payload })
  assert.equal(result.statusCode, 200, result.body)
  return result.json()
}
const cap = 48_000
const discussion = '主角的年龄可以定为二十六岁，以初入职场的经历支撑人物动机。'
const assetPrompt = { prompt_zh: '二十六岁的主角站在安静的街角，神情坚定，日常服装，清晰的人物设定。',
  prompt_en: 'A determined twenty-six-year-old protagonist stands at a quiet street corner in everyday clothes.', notes: '' }
function answer(protocol: TextApiProtocol, text: string) {
  if (protocol === 'responses') return { status: 'completed', output_text: text,
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] }
  if (protocol === 'anthropic_messages') return { type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 80 } }
  return { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }
}

for (const protocol of ['chat_completions', 'responses', 'anthropic_messages'] as const) {
  test(`${protocol}: saved standard forms reach director discussion and the creative helper with exact cap and reasoning`, async t => {
    const settings = { context_window_tokens: 1_000_000, text_api: { mode: 'standard', max_output_tokens: cap, chat_output_field: 'max_tokens',
      reasoning: { enabled: true, default_level: 'high', levels: [{ level: 'off', api_value: '' }, { level: 'high', api_value: 'high' }] } } }
    const configured = await post('/api/providers/configuration', {
      provider: { name: `标准实际入口-${protocol}`, base_url: 'https://entrypoint-fixture.invalid/v1', protocol, api_key: 'fixture-secret' },
      models: [{ name: '标准文本模型', remote_id: `remote-${protocol}`, modality: 'text', settings }],
    })
    const model = configured.models[0]
    assert.equal(model.protocol, protocol)
    const project = await post('/api/projects', { name: `表单到创作请求-${protocol}` })
    const persisted = one('SELECT * FROM models WHERE id=?', model.id)
    const paths: string[] = [], prompts: string[] = []
    let purpose: 'discussion' | 'asset' = 'discussion'
    t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
      const expectedPath = protocol === 'responses' ? 'responses' : protocol === 'anthropic_messages' ? 'messages' : 'chat/completions'
      assert.equal(String(url), `https://entrypoint-fixture.invalid/v1/${expectedPath}`)
      paths.push(String(url))
      const body = JSON.parse(String(init.body))
      assert.equal(body.model, model.remote_id)
      assert.equal(protocol === 'responses' ? body.max_output_tokens : body.max_tokens, cap)
      for (const key of ['text_api', 'context_window_tokens', 'output_reserve_tokens']) assert.equal(body[key], undefined)
      if (protocol === 'responses') assert.equal(body.reasoning.effort, 'high')
      else if (protocol === 'anthropic_messages') {
        assert.equal(body.output_config.effort, 'high')
        assert.deepEqual(body.thinking, { type: 'adaptive' })
        assert.equal(new Headers(init.headers).get('x-api-key'), 'fixture-secret')
      } else assert.equal(body.reasoning_effort, 'high')
      const prompt = String(protocol === 'responses' ? body.input : body.messages[0].content)
      prompts.push(prompt)
      assert.match(prompt, /主角|人物/)
      return Response.json(answer(protocol, purpose === 'discussion' ? discussion : JSON.stringify(assetPrompt)))
    })
    const chatted = await post(`/api/projects/${project.id}/script/director/chat`, {
      model_id: model.id, mode: 'script', focus_artifact: 'character', use_tools: false,
      skill_selections: { visual_assets: [] }, messages: [{ role: 'user', text: '讨论主角年龄与人物动机，先不要生成文档。' }],
    })
    assert.equal(chatted.reply, discussion)
    assert.equal(paths.length, 1, 'the saved standard configuration must pass the director route before making one model request')
    purpose = 'asset'
    const created = await post(`/api/projects/${project.id}/script/director/asset-prompt`, {
      model_id: model.id, focus_artifact: 'character', skill_selections: { visual_assets: [] },
      messages: [{ role: 'user', text: '将二十六岁的主角整理为人物设定提示词。' }],
    })
    assert.equal(created.prompt_zh, assetPrompt.prompt_zh)
    assert.equal(created.prompt_en, assetPrompt.prompt_en)
    assert.equal(paths.length, 2, 'the creativeText helper must also dispatch the saved standard configuration')
    assert.match(prompts[1]!, /prompt_zh/)
    assert.deepEqual(one('SELECT * FROM models WHERE id=?', model.id), persisted)
    assert.equal(all('SELECT id FROM script_artifacts WHERE project_id=?', project.id).length, 0)
    assert.equal(all('SELECT id FROM jobs WHERE project_id=?', project.id).length, 0)
  })
}

test('saving an explicit output cap for a legacy Responses model replaces the upstream default without sending the capacity reserve', async t => {
  const legacy = { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' },
    text_paths: ['output_text', 'output'], context_window_tokens: 1_000_000, output_reserve_tokens: 128_000 }
  const configured = await post('/api/providers/configuration', {
    provider: { name: '旧配置输出额度修复', base_url: 'https://legacy-output-fixture.invalid/v1', protocol: 'responses' },
    models: [{ name: '旧版文本模型', remote_id: 'legacy-text-fixture', modality: 'text', protocol: 'responses', settings: legacy }],
  })
  const model = configured.models[0]
  const project = await post('/api/projects', { name: '旧配置实际额度回归' })
  const caps: unknown[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    caps.push(body.max_output_tokens)
    assert.equal(body.output_reserve_tokens, undefined)
    assert.equal(body.context_window_tokens, undefined)
    return Response.json(answer('responses', discussion))
  })
  const discuss = (text: string) => post(`/api/projects/${project.id}/script/director/chat`, {
    model_id: model.id, mode: 'script', focus_artifact: 'character', use_tools: false,
    skill_selections: { visual_assets: [] }, messages: [{ role: 'user', text }],
  })
  await discuss('先讨论主角的年龄设定，暂时不要生成文档。')
  assert.deepEqual(caps, [undefined], 'the old capacity reserve never set a real output limit')
  const managed = migrateStandardTextSettings(legacy, 'responses')!
  const settings = { ...managed, text_api: { ...managed.text_api as Record<string, unknown>, max_output_tokens: 65_536 } }
  const saved = await app.inject({ method: 'PATCH', url: `/api/models/${model.id}`, payload: { settings } })
  assert.equal(saved.statusCode, 200, saved.body)
  assert.equal(saved.json().settings.output_reserve_tokens, 128_000)
  await discuss('再讨论二十六岁的主角有哪些人物动机，暂时不要生成文档。')
  assert.deepEqual(caps, [undefined, 65_536])
})
