import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptSourceDocument } from '@video-studio/shared/script/script-source-document'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'
import { draftCompletenessFixtureResponse } from './fixtures/script-draft-completeness.js'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-character-continuation-flow-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/infrastructure/database/db.js')
const { getToolDraft } = await import('../src/modules/script/script-document-tools.js')
const { scriptDocumentVersion } = await import('../src/modules/script/script-source-versions.js')
assert.ok(db.name.startsWith(testData), 'HTTP continuation regression must use an isolated database')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}

test('HTTP character generation recovers an oversized unfinished relationship unit before independent review and preview', async t => {
  const project = await call('POST', '/api/projects', { name: '人物关系接续隔离回归' })
  const provider = await call('POST', '/api/providers', { name: 'isolated-character-continuation-fixture', base_url: 'https://character-continuation.invalid/v1' })
  const model = await call('POST', '/api/models', { provider_id: provider.id, name: 'fixture', remote_id: 'fixture', modality: 'text', protocol: 'chat_completions', settings: {
    request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] },
    structured_output_mode: 'json_schema', text_path: 'choices.0.message.content',
  } })
  const sourceText = '# 归乡的钥匙\n\n全剧2集。林舟是修锁匠，阿禾是故乡渡口的守夜人，老陈是守门人。\n\n' +
    '## 第1集\n林舟携父亲留下的铜钥匙返乡，要查清旧屋失火的原因。他将钥匙交给阿禾保管，约定查明真相后归还。阿禾曾目睹失火，但起初不敢说明；她不欺骗林舟，只拒绝替他猜测。老陈担心旧案暴露，拦住他们进入旧屋。\n\n' +
    '## 第2集\n阿禾拿出守夜记录，证实失火是旧炉故障，老陈并非纵火者。老陈承认自己为保护孩子隐瞒了故障记录。阿禾归还铜钥匙，林舟打开旧屋，找到父亲留下的修锁账本；三人解除误会，林舟最终留在故乡修复旧屋。铜钥匙没有超自然能力，任何人都不能用它改变记忆。'
  const creatorRequest = '请生成全剧人物小传和人物关系草稿供我预览：采用电影感国风仙侠的画面质感，但保留原稿现实因果；铜钥匙没有超自然能力，不能改变记忆。阿禾必须有独立行动，林舟与阿禾终局是平等盟友；不要新增恋爱线，不要改写已保存大纲，也不要保存本轮草稿。'
  const retainedCharacters = { artifact_type: 'characters', title: '人物小传', content: '## 林舟\n成年修锁匠，穿旧青布外套，说话先问证据。他为查清父亲旧屋失火返乡，习惯独自承担责任；最终接受阿禾的独立判断，留乡修复旧屋。铜钥匙只用于开锁。\n\n' +
    '## 阿禾\n成年守夜人，服装便于夜间巡查，记事准确，遇到不确定的信息会明确拒绝猜测。她保管铜钥匙并主动拿出守夜记录，最终归还钥匙，与林舟成为平等盟友，二人没有恋爱关系。\n\n' +
    '## 老陈\n年长守门人，曾为保护孩子隐瞒故障记录。他的阻拦来自羞愧与保护欲；真相公开后承认隐瞒，与林舟和阿禾解除误会。' }
  const first = { id: 'relationship:林舟:阿禾', title: '人物关系', content: '## 林舟与阿禾\n第1集由钥匙保管约定建立有限信任。阿禾坚持只提供有证据的事实，第2集主动出示守夜记录并归还铜钥匙；林舟接受她的判断，双方成为没有恋爱关系的平等盟友。', scenes: [] }
  const second = { id: 'relationship:林舟:老陈', title: first.title, content: '## 林舟与老陈\n第1集因进入旧屋受阻产生对立。第2集记录证实老陈并非纵火者，老陈承认隐瞒，林舟理解其保护孩子的动机，两人解除误会并修复旧屋。', scenes: [] }
  const incompleteMarker = '未闭合关系正文不得进入草稿'
  let analysisCalls = 0, writerCalls = 0, reviewCalls = 0, responseSettled = false
  let releaseReview!: () => void, enteredReview!: () => void
  const reviewGate = new Promise<void>(resolve => { releaseReview = resolve })
  const reviewEntered = new Promise<void>(resolve => { enteredReview = resolve })
  t.after(releaseReview)
  const modelReply = (content: string, finish_reason = 'stop') => Response.json({ choices: [{ message: { content }, finish_reason }] })
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.match(String(url), /^https:\/\/character-continuation\.invalid\//)
    const body = JSON.parse(String(init?.body))
    const prompt: string = body.messages[0].content
    const analysis = sourceAnalysisFixture(prompt)
    if (analysis) { analysisCalls++; return modelReply(analysis) }
    const review = draftCompletenessFixtureResponse(init)
    if (review) {
      reviewCalls++
      assert.equal(writerCalls, 4, 'independent review waits until the complete relationship document exists')
      assert.ok(prompt.includes(JSON.stringify(sourceText)), 'review receives the complete uploaded manuscript')
      assert.ok(prompt.includes(JSON.stringify(creatorRequest)), 'review receives the exact creator request')
      assert.ok(prompt.includes(JSON.stringify(retainedCharacters.content)), 'review includes the retained character document verbatim')
      assert.ok(prompt.includes(first.content.replaceAll('\n', '\\n')))
      assert.ok(prompt.includes(second.content.replaceAll('\n', '\\n')))
      assert.ok(!prompt.includes(incompleteMarker), 'unfinished strings cannot become reviewable prose')
      enteredReview()
      await reviewGate
      return review
    }
    writerCalls++
    assert.ok(prompt.includes(JSON.stringify(sourceText)), 'each generation round keeps the full original manuscript')
    assert.ok(prompt.includes(JSON.stringify(creatorRequest)), 'each generation round keeps exact creator requirements')
    assert.ok(!prompt.includes(incompleteMarker), 'an unfinished block is never fed back as preserved prose')
    const contract = body.response_format.json_schema
    if (writerCalls === 1) {
      assert.equal(contract.name, 'workflow_draft')
      return modelReply('{"artifacts":[' + JSON.stringify(retainedCharacters) + ',{"artifact_type":"relationships","title":"人物关系","content":"' + incompleteMarker, 'length')
    }
    assert.equal(contract.name, 'script_stage_blocks')
    const blocks = contract.schema.properties.blocks
    assert.ok(prompt.includes(JSON.stringify(retainedCharacters)), 'continuation preserves completed character text')
    assert.equal(blocks.items.properties.scenes.maxItems, 0, 'relationship blocks cannot request episode scenes')
    if (writerCalls === 2) {
      assert.equal(blocks.maxItems, 200)
      return modelReply('{"blocks":[{"id":"relationships:all","title":"人物关系","content":"' + incompleteMarker.repeat(2000), 'length')
    }
    if (writerCalls === 3) {
      assert.equal(blocks.maxItems, 1, 'a truncated first block focuses the next native schema')
      assert.match(prompt, /本轮至多返回一个尚未完成的最小完整语义单元/)
      return modelReply(JSON.stringify({ blocks: [first], complete: false }))
    }
    assert.equal(writerCalls, 4, 'a completed block prevents another identical stalled request')
    assert.equal(blocks.maxItems, 200, 'successful focused progress restores batching')
    assert.ok(prompt.includes(JSON.stringify(first)), 'the next round receives the accepted relationship block verbatim')
    return modelReply(JSON.stringify({ blocks: [second], complete: true }))
  })

  const boundary = 'character-continuation-source'
  const uploaded = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/source?model_id=${model.id}`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="story.md"\r\nContent-Type: text/plain\r\n\r\n${sourceText}\r\n--${boundary}--\r\n`) })
  assert.equal(uploaded.statusCode, 200, uploaded.body)
  let source: ScriptSourceDocument = uploaded.json()
  for (let attempt = 0; attempt < 100 && source.analysis?.status !== 'ready'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5))
    source = await call('GET', `/api/projects/${project.id}/script/source`)
  }
  assert.equal(source.analysis?.status, 'ready', source.analysis?.error || '')
  assert.equal(source.content, sourceText)
  assert.equal(analysisCalls, 3)
  await call('PUT', `/api/projects/${project.id}/script/director/draft`, { stage: 'outline', source_version: scriptDocumentVersion(source),
    generation_options: { episode_count: 2 }, artifacts: scriptStageArtifacts.outline.map(artifact_type => ({ artifact_type,
      title: scriptArtifactLabels[artifact_type], content: artifact_type === 'episode_outline'
        ? '第1集：林舟交阿禾保管铜钥匙，被老陈阻拦进入旧屋。\n第2集：阿禾出示守夜记录并归还钥匙，老陈承认隐瞒，三人解除误会，林舟留乡。'
        : `${scriptArtifactLabels[artifact_type]}：林舟查明旧屋失火的现实原因；阿禾主动提供守夜记录，老陈承认隐瞒，终局修复旧屋。铜钥匙没有超自然能力，人物之间没有恋爱线。`,
    })), scenes: [] })
  const before = (await call('GET', `/api/projects/${project.id}`)).script
  const pending = (async () => {
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: {
      model_id: model.id, mode: 'script', use_tools: true, workflow: { stage: 'characters' }, messages: [{ role: 'user', text: creatorRequest }],
    } })
    responseSettled = true
    return response
  })()
  await Promise.race([reviewEntered, pending.then(response => {
    assert.ok(reviewCalls > 0, `request finished before independent review: ${response.body}`)
  })])
  assert.equal(responseSettled, false, 'the HTTP response cannot expose a preview while review is still running')
  assert.equal(getToolDraft(project.id), null, 'no preview draft is persisted before independent review succeeds')
  assert.deepEqual((await call('GET', `/api/projects/${project.id}`)).script, before, 'generation and review cannot alter saved documents')
  releaseReview()
  const response = await pending
  assert.equal(response.statusCode, 200, response.body)
  const result = response.json()
  assert.equal(writerCalls, 4)
  assert.equal(reviewCalls, 1)
  assert.equal(analysisCalls, 3, 'ready source analysis does not repeat during generation or review')
  assert.equal(result.tool_draft.status, 'pending')
  assert.deepEqual(result.tool_draft.documents.map((document: { artifact_type: string }) => document.artifact_type), ['characters', 'relationships'])
  assert.equal(result.tool_draft.documents[0].content, retainedCharacters.content)
  assert.equal(result.tool_draft.documents[1].content, first.content + '\n\n' + second.content)
  assert.ok(!JSON.stringify(result.tool_draft).includes(incompleteMarker))
  assert.deepEqual((await call('GET', `/api/projects/${project.id}`)).script, before, 'previewing the complete draft cannot write characters or replace the outline')
  const afterSource: ScriptSourceDocument = await call('GET', `/api/projects/${project.id}/script/source`)
  assert.equal(afterSource.content, sourceText)
  assert.equal(scriptDocumentVersion(afterSource), scriptDocumentVersion(source), 'continuation cannot revise the uploaded manuscript')
})
