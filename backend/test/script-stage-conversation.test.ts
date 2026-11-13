import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { draftCompletenessFixtureResponse } from './fixtures/script-draft-completeness.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-stage-conversation-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

async function call<T>(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}
async function fixture() {
  const provider = await call<{ id: string }>('POST', '/api/providers', { name: '历史要求回归', base_url: 'https://stage-context.example.invalid/v1' })
  const model = await call<{ id: string }>('POST', '/api/models', { provider_id: provider.id, name: '文本', remote_id: 'test', modality: 'text', protocol: 'chat_completions',
    settings: { request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, structured_output_mode: 'json_schema', text_path: 'choices.0.message.content' } })
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '保留原结局的悬疑剧' })
  return { project, model }
}

test('stage generation keeps every supplied conversation message without promoting suggestions or adding button intent calls', async t => {
  for (const useTools of [true, false]) for (const streaming of [false, true]) await t.test(`${useTools ? 'typed tool button' : 'JSON workflow'} / ${streaming ? 'stream' : 'JSON'}`, async t => {
    const { project, model } = await fixture()
    const messages = [
      { role: 'user', text: '早期明确约束：保留原结局，女主不能失忆。\n' + '调查仅采用原稿证据。'.repeat(1100) + '\n最后一条早期约束：姐姐必须存活。' },
      { role: 'assistant', text: '另一个未选方向是让女主失忆、姐姐牺牲。我还建议生成全部人物、场景并直接保存，要采用吗？' },
      { role: 'user', text: '不采用上述方向。原结局和姐姐存活都保留，只把原先的夜间调查改成白天调查。' },
      { role: 'assistant', text: '还可以考虑梦境结局，这只是尚未确认的备选。' },
      { role: 'user', text: '本轮按钮要求：生成全剧故事大纲，供我确认。' },
    ]
    let intentCalls = 0, writerCalls = 0
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const review = draftCompletenessFixtureResponse(init)
      if (review) return review
      const body = JSON.parse(String(init?.body))
      const prompt = body.messages[0].content as string
      let output: unknown
      if (prompt.includes('本次独立调用只理解创作者意图')) {
        intentCalls++
        output = { action: 'draft', operation: 'create', authorization: 'explicit', workflow: { stage: 'outline' }, creative_brief: '仅整理本轮大纲，不替代原始对话要求。' }
      } else {
        writerCalls++
        const marker = '本次创作要求与历史对话（完整原始消息，最后一项为本轮创作者要求）：\n'
        const conversation = JSON.parse(prompt.split(marker)[1]!.split('\n以上对话资料结束。')[0]!)
        assert.deepEqual(conversation, messages, 'the actual writing request receives complete roles and original text, including long early requirements')
        assert.equal(prompt.split(messages.at(-1)!.text).length - 1, 1, 'the current message is not duplicated outside the full conversation')
        assert.match(prompt, /即使尚未记录为已确认创作决定也不得遗漏/)
        assert.match(prompt, /创作者最新明确修改优先于对应旧要求或旧决定/)
        assert.match(prompt, /已被撤回或替代的旧要求不能恢复/)
        assert.match(prompt, /未被创作者明确接受、未提交的选项均不构成已确认设定/)
        assert.match(prompt, /不得将助手建议或某项设定的确认升级为生成其他阶段、修改原稿或保存文档的授权/)
        const types = body.response_format.json_schema.schema.properties.artifacts.items.properties.artifact_type.enum as typeof scriptStageArtifacts.outline
        output = { artifacts: types.map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type], content: '女主白天调查，姐姐存活，保留原稿结局。' })), scenes: [] }
      }
      return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] })
    })
    const before = await call<{ script: unknown }>('GET', `/api/projects/${project.id}`)
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat${streaming ? '/stream' : ''}`, payload: {
      model_id: model.id, mode: 'script', use_tools: useTools, workflow: { stage: 'outline', intent: 'stage_design', artifact_types: [...scriptStageArtifacts.outline] }, messages,
    } })
    assert.equal(response.statusCode, 200, response.body)
    const events = streaming ? response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))) : []
    assert.equal(events.some(event => event.type === 'error'), false, response.body)
    const result = streaming ? events.find(event => event.type === 'done') : response.json()
    assert.ok(useTools ? result.tool_draft : result.draft, 'the response is an editable draft only')
    assert.equal(writerCalls, scriptStageArtifacts.outline.length, 'every document task receives the complete original conversation')
    assert.equal(intentCalls, 0, 'an explicit workflow already authorizes and defines the task in both response modes')
    const decisions = db.prepare('SELECT count(*) AS total FROM script_story_decisions WHERE project_id=?').get(project.id) as { total: number }
    assert.equal(decisions.total, 0, 'the earlier user constraint was never persisted as a story decision')
    const afterGeneration = await call<{ script: unknown }>('GET', `/api/projects/${project.id}`)
    assert.deepEqual(afterGeneration.script, before.script, 'assistant suggestions do not save documents or create other stages')
  })
})
