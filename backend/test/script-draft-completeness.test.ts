import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'
import { scriptStageArtifacts, scriptArtifactLabels, type ScriptStage } from '@video-studio/shared/script/script-stage-content'
import { reviewScriptDraftCompleteness, ScriptDraftNeedsResolution, ScriptDraftReviewError } from '../src/modules/script/script-draft-completeness.js'
import { workflowGenerationDraftSchema, type WorkflowDraft } from '../src/modules/script/script-workflow.js'
import { ScriptToolProblem } from '../src/modules/script/script-revision.js'
import type { Project } from '../src/infrastructure/database/db.js'
import type { ScriptSnapshot } from '../src/modules/script/script-document-tools.js'
import { createGenerationSteps, type GenerationCheckpoint } from '../src/modules/script/script-generation-steps.js'

const dataDir = await mkdtemp(join(tmpdir(), 'studio-setting-completeness-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/infrastructure/database/db.js')
assert.equal(db.name, join(dataDir, 'studio.db'), 'regression fixtures must never use the workspace database')
const { documentTools, getToolDraft } = await import('../src/modules/script/script-document-tools.js')
const { directorStageContext } = await import('../src/modules/script/script-workflow.js')
const { scriptDocumentVersion } = await import('../src/modules/script/script-source-versions.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(dataDir, { recursive: true, force: true }) })

function candidate(stage: ScriptStage, content = '能力使用后的具体损失以后再说。'): WorkflowDraft {
  return workflowGenerationDraftSchema.parse({ stage, episode_number: stage === 'episode' ? 1 : 0,
    artifacts: scriptStageArtifacts[stage].map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type], content })),
    scenes: stage === 'episode' ? [{ heading: '夜间车站', location: '车站', characters: '林晚', action: content, dialogue: '我会去查清楚。', duration: 12 }] : [] })
}
function sources(prompt: string): Array<{ key: string; artifact_type: string; title: string; content: string }> {
  return JSON.parse(prompt.slice(prompt.lastIndexOf('待核对草稿原文（资料）：') + '待核对草稿原文（资料）：'.length))
}

test('review provides Chinese document names while retaining machine references and verbatim source evidence', async () => {
  const quote = '角色口令为 “world”，触发条件尚未说明。', draft = candidate('outline', quote)
  const finding = { source_key: 'world', kind: 'missing_core_setting' as const, quote,
    topic: '口令的触发条件', explanation: '背景设定尚未说明口令如何触发。', suggestion: '明确触发条件并同步分集大纲。' }
  await assert.rejects(reviewScriptDraftCompleteness(draft, async prompt => {
    const submitted = sources(prompt)
    assert.deepEqual(submitted, draft.artifacts.map(artifact => ({ key: artifact.artifact_type,
      artifact_type: artifact.artifact_type, title: scriptArtifactLabels[artifact.artifact_type], content: artifact.content })))
    assert.equal(submitted.find(source => source.key === 'world')!.title, '背景设定')
    assert.equal(submitted.find(source => source.key === 'episode_outline')!.title, '分集大纲')
    assert.match(prompt, /explanation、suggestion 和新建 topic 使用简体中文/)
    assert.match(prompt, /source_key、checked_artifacts 等定位字段仍使用真实机器标识，不翻译/)
    assert.match(prompt, /既有事项的 topic 原样沿用/)
    return JSON.stringify({ checked_artifacts: scriptStageArtifacts.outline, findings: [finding] })
  }), error => {
    assert.ok(error instanceof ScriptDraftNeedsResolution)
    const { id: _id, ...reviewedFinding } = error.findings[0]!
    assert.deepEqual(reviewedFinding, finding, 'Chinese display guidance must not translate evidence or change issue references')
    return true
  })
})

test('all stages reject semantic gaps with precise repair evidence even without pending keywords', async () => {
  for (const stage of Object.keys(scriptStageArtifacts) as ScriptStage[]) {
    const draft = candidate(stage)
    await assert.rejects(reviewScriptDraftCompleteness(draft, async prompt => {
      const submitted = sources(prompt)
      assert.match(prompt, /已授权你在该范围内设计尚缺的虚构细节/)
      assert.match(prompt, /不要凭“未定”等关键词直接下结论/)
      return JSON.stringify({ checked_artifacts: scriptStageArtifacts[stage], findings: [{ source_key: submitted[0].key,
        kind: 'missing_core_setting', quote: submitted[0].content, explanation: '核心代价仍未设计，后续人物选择缺乏依据。', suggestion: '确定损失、触发条件和恢复条件。' }] })
    }), issue => issue instanceof ScriptToolProblem && issue.diagnostic.code === 'incomplete_creative_settings' &&
      issue.diagnostic.retryable && issue.diagnostic.repair.includes(draft.artifacts[0].content))
  }
})

test('viewer uncertainty and justified absence pass the semantic review without a keyword ban', async () => {
  const draft = candidate('outline', '观众眼中幕后人身份未定；作者设定：幕后人为陈默，第8集揭示。无超自然能力，因此能力代价不适用。')
  let calls = 0
  await reviewScriptDraftCompleteness(draft, async prompt => {
    calls++
    assert.match(prompt, /作者已有答案\/回收安排，均不算未完成/)
    assert.match(prompt, /待确认草稿的具体创作方案可以通过/)
    return JSON.stringify({ checked_artifacts: scriptStageArtifacts.outline, findings: [] })
  })
  assert.equal(calls, 1)
})

test('fabricated evidence and incomplete review coverage are rejected after one format repair', async () => {
  for (const invalid of ['quote', 'source', 'coverage'] as const) {
    let calls = 0
    await assert.rejects(reviewScriptDraftCompleteness(candidate('characters'), async prompt => {
      calls++
      const submitted = sources(prompt)
      return JSON.stringify({ checked_artifacts: invalid === 'coverage' ? ['characters'] : scriptStageArtifacts.characters,
        findings: [{ source_key: invalid === 'source' ? 'foreign-document' : submitted[0].key, kind: 'unresolved_setting',
          quote: invalid === 'quote' ? '原文不存在的证据' : submitted[0].content, explanation: '未完成', suggestion: '补齐' }] })
    }), /证据必须逐字|核对必须覆盖/)
    assert.equal(calls, 2)
  }
})

test('historical supplementation excludes unchanged text while reviewing every new document', async () => {
  const draft = candidate('locations', '车站位于桥东，南门进入，北窗可观察河岸。')
  draft.artifacts[0].content = '\n旧地点原文：空间细节待定。\n'
  const historical = [{ ...draft.artifacts[0], episode_number: 0 }]
  await reviewScriptDraftCompleteness(draft, async prompt => {
    assert.ok(!sources(prompt).some(source => source.key === 'locations'))
    assert.equal(sources(prompt).length, 3)
    return JSON.stringify({ checked_artifacts: scriptStageArtifacts.locations.slice(1), findings: [] })
  }, { preserved: historical })
  assert.equal(draft.artifacts[0].content, historical[0].content)
  let calls = 0
  await reviewScriptDraftCompleteness(draft, async () => { calls++; throw new Error('unchanged text must not be reviewed') }, { preserved: draft.artifacts })
  assert.equal(calls, 0)
})

test('episode review includes structured scene gaps and does not mistake a complete prose draft for complete scenes', async () => {
  const draft = candidate('episode', '林晚用铜钥匙开门，失去当天记忆，留下刻字防止忘记线索。')
  draft.scenes[0].action = '具体行动待补充。'
  await assert.rejects(reviewScriptDraftCompleteness(draft, async prompt => {
    const scene = sources(prompt).find(source => source.key === 'scene:0:action')!
    assert.deepEqual(scene, { key: 'scene:0:action', artifact_type: 'episode_script', title: '第 1 场 · 动作', content: draft.scenes[0].action })
    return JSON.stringify({ checked_artifacts: ['episode_script'], findings: [{ source_key: scene.key, kind: 'missing_core_setting',
      quote: scene.content, explanation: '结构化场次尚无具体动作，与正文不一致。', suggestion: '同步正文中的开门、失忆和刻字动作。' }] })
  }, { preserved: [{ ...draft.artifacts[0], episode_number: 1 }] }), /结构化场次尚无具体动作/)
})

test('network failures and cancellation do not become a passed audit or retry upstream requests', async () => {
  let calls = 0
  await assert.rejects(reviewScriptDraftCompleteness(candidate('props'), async () => { calls++; throw new Error('上游502') }), /上游502/)
  assert.equal(calls, 1)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(reviewScriptDraftCompleteness(candidate('props'), async () => { calls++; return '' }, { signal: controller.signal }), /abort/i)
  assert.equal(calls, 1)
})

test('source analysis review errors retain the original cause, status and stop-the-tool-loop type', () => {
  const cause = Object.assign(new Error('人物整合契约不通过'), { statusCode: 422 })
  for (const phase of ['source_analysis', 'revision_analysis', 'review'] as const) {
    const issue = new ScriptDraftReviewError(cause, phase)
    assert.ok(issue instanceof ScriptDraftReviewError)
    assert.equal(issue.statusCode, 422)
    assert.equal(issue.cause, cause)
    assert.equal(issue.phase, phase)
    assert.match(issue.message, phase === 'revision_analysis' ? /修订稿分析未完成/ : phase === 'source_analysis' ? /剧本来源分析未完成/ : /^阶段设定核对未完成/)
  }
  assert.match(new ScriptDraftReviewError(cause).message, /^阶段设定核对未完成/)
})

test('whole-work audit retries failed transport, reuses exact validated work and invalidates changed evidence', async () => {
  const draft = candidate('characters')
  draft.artifacts.forEach((artifact, index) => { artifact.content = `${index}角色的具体因果。`.repeat(1800) + `结尾${index}归还钥匙。` })
  let checkpoint: GenerationCheckpoint = { steps: {} }, fail = true, calls = 0
  const context = { confirmed: '身份不能改', source_version: 'v1', uploaded_script: { content: '开场原文' + '完整原文。'.repeat(8000) + '结局原文' } }
  const generator = async (prompt: string) => {
    calls++
    assert.ok(prompt.includes(context.uploaded_script.content), 'full effective source is available in the same request')
    const submitted = sources(prompt)
    assert.deepEqual(submitted.map(item => item.content), draft.artifacts.map(item => item.content), 'every candidate document is complete')
    if (fail) throw new Error('audit connection interrupted')
    return JSON.stringify({ checked_artifacts: scriptStageArtifacts.characters, findings: [],
      facts: [{ source_key: submitted[0].key, quote: submitted[0].content.slice(0, 24), meaning: '确切人物设定' }] })
  }
  const steps = () => createGenerationSteps({ checkpoint, save: state => { checkpoint = structuredClone(state) } })
  await assert.rejects(reviewScriptDraftCompleteness(draft, generator, { context, steps: steps() }), /audit connection interrupted/)
  assert.deepEqual(checkpoint.steps, {}, 'failed whole-work review is never checkpointed as passed')
  fail = false
  await reviewScriptDraftCompleteness(draft, generator, { context, steps: steps() })
  assert.deepEqual(Object.keys(checkpoint.steps), ['review:whole'])
  assert.equal(calls, 2)
  await reviewScriptDraftCompleteness(draft, async () => { throw new Error('the unchanged whole-work audit must reuse') }, { context, steps: steps() })
  const first = checkpoint.steps['review:whole']!
  ;(first.value as { facts: Array<{ quote: string }> }).facts[0]!.quote = '伪造且不存在的原文'
  await reviewScriptDraftCompleteness(draft, generator, { context, steps: steps() })
  assert.equal(calls, 3, 'restored evidence is validated against complete candidate text')
  await reviewScriptDraftCompleteness(draft, generator, { context: { ...context, source_version: 'v2' }, steps: steps() })
  assert.equal(calls, 4, 'changed effective source invalidates the old audit')
})

test('cached audit findings still block completion and changed candidate text cannot reuse a passed batch', async () => {
  const draft = candidate('characters', '角色动机待补充。')
  const steps = createGenerationSteps()
  let calls = 0
  const generate = async (prompt: string) => {
    calls++
    const submitted = sources(prompt)
    return JSON.stringify({ checked_artifacts: scriptStageArtifacts.characters, findings: [{ source_key: submitted[0].key, kind: 'missing_core_setting', quote: submitted[0].content, explanation: '尚无动机', suggestion: '补齐动机' }] })
  }
  await assert.rejects(reviewScriptDraftCompleteness(draft, generate, { steps }), /尚无动机/)
  await assert.rejects(reviewScriptDraftCompleteness(draft, generate, { steps }), /尚无动机/)
  assert.equal(calls, 1, 'cached findings are retained rather than mistaken for a passed audit')
  draft.artifacts[0].content = '角色为守护伙伴归还钥匙。'
  await reviewScriptDraftCompleteness(draft, async () => { calls++; return JSON.stringify({ checked_artifacts: scriptStageArtifacts.characters, findings: [] }) }, { steps })
  assert.equal(calls, 2)
})

async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload ? { payload } : {}) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}
async function fixture() {
  const project = await api<Project>('POST', '/api/projects', { name: '核心设定自动完善' })
  const provider = await api<{ id: string }>('POST', '/api/providers', { name: '核对测试', base_url: 'https://fixture.invalid/v1' })
  const model = await api<{ id: string }>('POST', '/api/models', { provider_id: provider.id, name: '创作模型', remote_id: 'text', modality: 'text', protocol: 'chat_completions', settings: {
    request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
  return { project, model }
}
const response = (content: unknown) => Response.json({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }] })
const toolCall = (id: string, name: string, args: unknown) => Response.json({ choices: [{ message: { tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })

function doneEvent(result: { body: string; json(): any }, streaming = false) {
  return streaming ? result.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(event => event.type === 'done') : result.json()
}
const finding = (key = 'outline', quote = '能力代价：待定。') => ({ source_key: key, kind: 'unresolved_setting', quote,
  explanation: '关键能力代价仍未设计。', suggestion: '确定每次使用损失一天记忆且无法恢复。' })
const originalText = '全剧60集，主角林晚。能力代价：待定。结局主角放弃能力，保留与家人的记忆。'
const concreteDecision = '每次使用铜钥匙仅损失一天记忆，无法恢复。'
const repair = { decisions: [concreteDecision], summary: '补齐能力代价，保留原故事。', source_edits: [], edits: [{ source_key: 'outline', find: '能力代价：待定。', replace: '能力代价：每次使用损失一天记忆，无法恢复。', reason: '补齐创作者确定的代价' }] }
const chatBody = (modelId: string, extra = {}) => ({ model_id: modelId, mode: 'script', messages: [{ role: 'user', text: '生成完整全剧大纲，沿用原稿60集。' }], ...extra })
async function uploadSource(projectId: string, content = originalText) {
  const boundary = 'source-resolution-test'
  const result = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/script/source`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="original.txt"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`) })
  assert.equal(result.statusCode, 200, result.body)
  const source = result.json()
  // These tests exercise draft repair after upload analysis has completed.
  const { scriptSourceVersion } = await import('../src/modules/script/script-source-analysis.js')
  const { sourceAnalysisPipelineVersion } = await import('../src/modules/script/script-source-map.js')
  const analysis = { pipeline_version: sourceAnalysisPipelineVersion, id: crypto.randomUUID(), source_version: scriptSourceVersion(source), model_id: 'fixture-analysis', status: 'ready', phase: 'ready',
    completed_chunks: 1, total_chunks: 1, error: null, updated_at: source.updated_at,
    sections: [{ offset: 0, length: source.content.length, title: '原稿', episode_number: null, summary: source.content, characters: [], events: [] }],
    story: { summary: source.content, characters: [], timeline: [], threads: [], ending: { summary: '主角放弃能力，保留与家人的记忆。', section_ids: [0] }, uncertainties: [] } }
  db.prepare('INSERT OR REPLACE INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)')
    .run(projectId, analysis.id, analysis.source_version, 'ready', JSON.stringify(analysis), source.updated_at)
  return source
}

test('native and JSON creation pause once, resume the retained candidate over both transports, and only present a preview', async t => {
  for (const useTools of [true, false]) for (const streaming of [false, true]) await t.test(`${useTools ? 'native' : 'JSON'} ${streaming ? 'SSE' : 'chat'}`, async t => {
    const { project, model } = await fixture(), before = await api<any>('GET', `/api/projects/${project.id}`)
    const uploaded = await uploadSource(project.id)
    let generations = 0, audits = 0, repairs = 0
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).messages[0].content as string
      const analyzedSource = sourceAnalysisFixture(prompt)
      if (analyzedSource) return response(analyzedSource)
      if (prompt.includes('本次独立调用只理解创作者意图')) return response({ action: 'draft', operation: 'create', workflow: { stage: 'outline' }, creative_brief: '忠实整理60集原稿' })
      if (prompt.includes('待核对草稿原文（资料）：')) {
        audits++
        assert.equal(getToolDraft(project.id), null)
        if (audits > 1) assert.match(prompt, /当前有效|每次使用损失一天记忆/)
        return response({ checked_artifacts: scriptStageArtifacts.outline, findings: audits === 1 ? [finding(), { ...finding(), kind: 'contradiction', explanation: '能力代价与主角选择依据不一致。' }] : [] })
      }
      if (prompt.includes('继续已授权阶段的候选草稿')) {
        repairs++
        assert.match(prompt, /原剧本已明确的故事事实、集数、主线和结局作为依据/)
        assert.match(prompt, streaming ? /本项委托 AI/ : /损失一天记忆，不改60集/)
        assert.match(prompt, /全剧60集，主角林晚/)
        assert.match(prompt, /同时返回 source_edits/)
        return response({ ...repair, decisions: [concreteDecision, concreteDecision], source_edits: repair.edits.map(({ source_key: _key, ...edit }) => edit) })
      }
      generations++
      const draft = candidate('outline', originalText)
      return response({ artifacts: draft.artifacts, scenes: [] })
    })
    const url = `/api/projects/${project.id}/script/director/chat${streaming ? '/stream' : ''}`
    const first = await app.inject({ method: 'POST', url, payload: chatBody(model.id, { use_tools: useTools, workflow: { stage: 'outline' }, generation_options: { episode_count: 20 } }) })
    assert.equal(first.statusCode, 200, first.body)
    const paused = doneEvent(first, streaming)
    assert.equal(generations, 1); assert.equal(audits, 1); assert.equal(repairs, 0)
    assert.equal(paused.execution_outcome.kind, 'question'); assert.equal(paused.draft_resolution.findings.length, 2)
    assert.equal(paused.draft, undefined); assert.equal(paused.tool_draft, undefined)
    assert.ok(paused.activity.every((step: any) => step.status === 'succeeded'))
    const state = await api<any>('GET', `/api/projects/${project.id}/script/director/tools-state`)
    assert.deepEqual(state.draft_resolution, paused.draft_resolution); assert.equal(state.draft, null)
    const repeated = await app.inject({ method: 'POST', url, payload: chatBody(model.id, { use_tools: useTools, workflow: { stage: 'outline' } }) })
    assert.deepEqual(doneEvent(repeated, streaming).draft_resolution, paused.draft_resolution)
    assert.equal(generations, 1, 'another generate request cannot discard or regenerate a paused candidate')
    const { id, version } = paused.draft_resolution
    const resumed = await app.inject({ method: 'POST', url, payload: chatBody(model.id, { draft_resolution: { id, version,
      strategy: streaming ? 'ai' : 'manual', ...(streaming ? {} : { answers: ['损失一天记忆，不改60集', '同步相关规则'] }) } }) })
    assert.equal(resumed.statusCode, 200, resumed.body)
    const done = doneEvent(resumed, streaming)
    assert.ok(done, resumed.body)
    assert.equal(generations, 1); assert.equal(repairs, 1); assert.equal(audits, 2)
    assert.equal(done.draft_resolution, null)
    const docs = useTools ? done.tool_draft.documents : done.draft.artifacts
    assert.equal(docs[0].content, originalText.replace('能力代价：待定。', repair.edits[0].replace))
    assert.ok(docs.slice(1).every((doc: any) => doc.content === originalText), 'all unaffected documents retain exact text')
    assert.equal(done.workflow.stage, 'outline'); assert.equal(done.workflow.episode_number, 0)
    assert.equal((await api<any>('GET', `/api/projects/${project.id}/script/director/tools-state`)).draft_resolution, null)
    assert.deepEqual((await api<any>('GET', `/api/projects/${project.id}`)).script, before.script)
    assert.equal((await api<any>('GET', `/api/projects/${project.id}/script/source`)).content, originalText, 'source readers keep committed content until confirmation')
    assert.equal(done.source_update.original_content, uploaded.content)
    assert.equal(done.source_update.content, docs[0].content)
    if (useTools) {
      assert.deepEqual(done.tool_draft.source_update, done.source_update)
      assert.equal(getToolDraft(project.id)!.version, done.tool_draft.version, 'returned native draft uses its attached source version')
      await api('POST', `/api/projects/${project.id}/script/director/tool-drafts/${done.tool_draft.id}/commit`, { version: done.tool_draft.version, approved: true })
    } else await api('PUT', `/api/projects/${project.id}/script/director/draft`, { ...done.draft, source_update: done.source_update })
    const source = await api<any>('GET', `/api/projects/${project.id}/script/source`)
    assert.equal(source.revision, 1); assert.equal(source.content, docs[0].content); assert.match(source.content, /全剧60集/)
    assert.equal((await api<any>('GET', `/api/projects/${project.id}/script/source/original`)).content, originalText)
    const { scriptSourceContext, readScriptSource, searchScriptSource, scriptSourceIndex } = await import('../src/modules/script/script-source-documents.js')
    assert.match(scriptSourceContext(project.id), /当前有效稿/)
    assert.equal(scriptSourceIndex(project.id)!.revision, 1)
    assert.equal(readScriptSource(project.id, 0, 10000).content, source.content)
    assert.equal(searchScriptSource(project.id, '损失一天记忆', 8).matches.length, 1)
    assert.match(scriptSourceIndex(project.id)!.sections[0]!.preview, /损失一天记忆/)
    const tools = documentTools({ project, script: () => before.script, stage: directorStageContext(before.script), messages: [], checkApproval: async () => false })
    assert.equal((await tools.execute('read_source_document', { offset: 0, length: 10000 }) as any).content, source.content)
    assert.equal((await tools.execute('search_source_document', { query: '损失一天记忆' }) as any).matches.length, 1)
  })
})

async function pauseCandidate(t: any, useTools = false) {
  const f = await fixture()
  await uploadSource(f.project.id)
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const analyzedSource = sourceAnalysisFixture(prompt)
    if (analyzedSource) return response(analyzedSource)
    if (prompt.includes('本次独立调用只理解创作者意图')) return response({ action: 'draft', operation: 'create', workflow: { stage: 'outline' }, creative_brief: '完整大纲' })
    if (prompt.includes('待核对草稿原文（资料）：')) return response({ checked_artifacts: scriptStageArtifacts.outline, findings: [finding()] })
    const draft = candidate('outline', originalText)
    return response({ artifacts: draft.artifacts, scenes: [] })
  })
  const paused = await api<any>('POST', `/api/projects/${f.project.id}/script/director/chat`, chatBody(f.model.id, { use_tools: useTools, workflow: { stage: 'outline' } }))
  return { ...f, resolution: paused.draft_resolution, calls: () => calls }
}

test('repair requires one concrete decision per issue and never substitutes the activity summary', async t => {
  for (const invalid of ['missing', 'empty', 'count'] as const) await t.test(invalid, async t => {
    const f = await pauseCandidate(t)
    const { pendingScriptDraft } = await import('../src/modules/script/script-draft-resolution.js')
    const before = structuredClone(pendingScriptDraft(f.project.id)!)
    const { decisions: _decisions, ...withoutDecisions } = repair
    let attempts = 0, audits = 0
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).messages[0].content as string
      assert.match(prompt, /继续已授权阶段的候选草稿/)
      assert.ok(prompt.includes('decisions'))
      attempts++
      return response(invalid === 'missing' ? withoutDecisions : { ...repair, decisions: invalid === 'empty' ? [] : [concreteDecision, '无对应问题的额外决定'] })
    })
    const url = `/api/projects/${f.project.id}/script/director/chat`
    const result = await app.inject({ method: 'POST', url, payload: chatBody(f.model.id, {
      draft_resolution: { id: before.id, version: before.version, strategy: 'ai' },
    }) })
    assert.equal(result.statusCode, 422, result.body)
    assert.match(result.body, /script_draft_repair 契约/)
    assert.equal(attempts, 2, 'invalid decision output receives only one bounded contract correction')
    const retained = pendingScriptDraft(f.project.id)!
    assert.deepEqual(retained.draft, before.draft)
    assert.deepEqual(retained.source_update, before.source_update)
    assert.deepEqual(retained.resolutions, before.resolutions, 'summary cannot create an adopted story decision')
    assert.equal(retained.run?.status, 'interrupted')
    // A corrected continuation must run repair again; an invalid patch is not
    // checkpointed or accepted merely because it contained valid text edits.
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).messages[0].content as string
      const analyzedSource = sourceAnalysisFixture(prompt)
      if (analyzedSource) return response(analyzedSource)
      if (prompt.includes('待核对草稿原文（资料）：')) { audits++; return response({ checked_artifacts: scriptStageArtifacts.outline, findings: [] }) }
      attempts++
      return response(repair)
    })
    const completed = await api<any>('POST', url, chatBody(f.model.id, {
      draft_resolution: { id: retained.id, version: retained.version, strategy: 'continue' },
    }))
    assert.equal(attempts, 3)
    assert.equal(audits, 1)
    assert.equal(completed.draft_resolution, null)
  })
})

test('forty-one manual plans and actual repair decisions remain complete and strictly aligned', async t => {
  const f = await pauseCandidate(t)
  const { pendingScriptDraft, retainScriptDraft } = await import('../src/modules/script/script-draft-resolution.js')
  const before = pendingScriptDraft(f.project.id)!
  const findings = Array.from({ length: 41 }, (_, index) => ({ source_key: 'outline', topic: `道具${index + 1}的独立代价`,
    kind: 'unresolved_setting' as const, quote: `道具${index + 1}代价：尚未确定。`, explanation: `道具${index + 1}的使用后果不明。`, suggestion: '给出具体损失和恢复条件。' }))
  const draft = structuredClone(before.draft)
  draft.artifacts[0].content = findings.map(finding => finding.quote).join('\n')
  const pending = retainScriptDraft(f.project.id, { ...before, draft, findings }, before)
  const answers = findings.map((_, index) => `道具${index + 1}使用后失去当天记忆，无法恢复。`)
  let repairs = 0, audits = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    if (prompt.includes('待核对草稿原文（资料）：')) {
      audits++
      const marker = '既有事实与创作要求（资料）：'
      const reviewContext = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length, prompt.lastIndexOf('\n待核对草稿原文（资料）：')))
      assert.equal(reviewContext.resolved_findings.decisions.length, 41)
      assert.deepEqual(reviewContext.resolved_findings.decisions.map((item: any) => item.decision), answers)
      assert.ok(reviewContext.resolved_findings.decisions.every((item: any) => item.decision !== '一次补齐全部四十一项具体代价。'))
      assert.deepEqual(sources(prompt)[0].content, answers.join('\n'))
      return response({ checked_artifacts: scriptStageArtifacts.outline, findings: [] })
    }
    repairs++
    assert.match(prompt, /继续已授权阶段的候选草稿/)
    return response({ decisions: answers, summary: '一次补齐全部四十一项具体代价。', source_edits: [],
      edits: findings.map((finding, index) => ({ source_key: finding.source_key, find: finding.quote, replace: answers[index], reason: '落实对应人工方案。' })) })
  })
  const url = `/api/projects/${f.project.id}/script/director/chat`
  const incomplete = await app.inject({ method: 'POST', url, payload: chatBody(f.model.id, {
    draft_resolution: { id: pending.id, version: pending.version, strategy: 'manual', answers: answers.slice(0, 40) },
  }) })
  assert.equal(incomplete.statusCode, 422)
  assert.match(incomplete.body, /请填写每项处理方案/)
  assert.equal(repairs, 0, 'missing a creator plan is rejected before any model request')
  assert.equal(pendingScriptDraft(f.project.id)!.findings.length, 41)
  const completed = await api<any>('POST', url, chatBody(f.model.id, {
    draft_resolution: { id: pending.id, version: pending.version, strategy: 'manual', answers },
  }))
  assert.equal(repairs, 1)
  assert.equal(audits, 1)
  assert.equal(completed.draft_resolution, null)
  assert.equal(completed.draft.artifacts[0].content, answers.join('\n'))
})

test('a recurring specific issue reuses the manual decision for one bounded correction without another question', async t => {
  const f = await pauseCandidate(t)
  const { pendingScriptDraft, retainScriptDraft } = await import('../src/modules/script/script-draft-resolution.js')
  const before = pendingScriptDraft(f.project.id)!
  const pending = retainScriptDraft(f.project.id, { ...before, findings: before.findings.map(item => ({ ...item, topic: '钥匙使用后的记忆代价' })) }, before)
  let repairs = 0, audits = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const analyzedSource = sourceAnalysisFixture(prompt)
    if (analyzedSource) return response(analyzedSource)
    if (prompt.includes('待核对草稿原文（资料）：')) {
      audits++
      const material = sources(prompt)
      assert.match(prompt, /只失去一天记忆，保留60集/)
      assert.match(prompt, /resolved_findings/)
      return response({ checked_artifacts: scriptStageArtifacts.outline, findings: audits === 1 ? [{ ...finding(),
        topic: '钥匙使用后的记忆代价', quote: material.find(item => item.key === 'outline')!.content, explanation: '具体损失已设计，但触发后的因果尚未落实。' }] : [] })
    }
    repairs++
    assert.match(prompt, /只失去一天记忆，保留60集/)
    if (repairs === 1) return response({ ...repair, source_edits: repair.edits.map(({ source_key: _key, ...edit }) => edit) })
    assert.match(prompt, /具体损失已设计，但触发后的因果尚未落实/)
    return response({ decisions: [concreteDecision], summary: '已在结局落实同一记忆损失决定。', source_edits: [], edits: [{ source_key: 'outline',
      find: repair.edits[0].replace, replace: repair.edits[0].replace + '结局凭刻字复原当天线索。', reason: '沿用用户答案补齐因果。' }] })
  })
  const result = await api<any>('POST', `/api/projects/${f.project.id}/script/director/chat`, chatBody(f.model.id, {
    draft_resolution: { id: pending.id, version: pending.version, strategy: 'manual', answers: pending.findings.map(() => '只失去一天记忆，保留60集') },
  }))
  assert.equal(result.draft_resolution, null)
  assert.equal(repairs, 2); assert.equal(audits, 2)
  assert.ok(result.activity.some((item: any) => item.label === '继续落实已有处理方案'))
  assert.equal(pendingScriptDraft(f.project.id), null)
  assert.equal((await api<any>('GET', `/api/projects/${f.project.id}/script/source`)).content, originalText)
})

test('automatic correction is bounded and never extends the delegated scope to a new issue', async t => {
  for (const scenario of ['still_open', 'new_issue', 'past_issue']) await t.test(scenario, async t => {
    const f = await pauseCandidate(t)
    const { pendingScriptDraft, retainScriptDraft } = await import('../src/modules/script/script-draft-resolution.js')
    const { rememberFindingResolutions } = await import('../src/modules/script/script-finding-state.js')
    const previous = pendingScriptDraft(f.project.id)!
    const pending = retainScriptDraft(f.project.id, { ...previous, findings: previous.findings.map(item => ({ ...item, topic: '记忆代价' })),
      resolutions: scenario === 'past_issue' ? rememberFindingResolutions([], previous.findings.map(item => ({ ...item, topic: '幕后人的真实身份' })), 'ai', [], '此前已补齐身份。') : [],
    }, previous)
    let repairs = 0
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).messages[0].content as string
      const analyzedSource = sourceAnalysisFixture(prompt)
      if (analyzedSource) return response(analyzedSource)
      if (prompt.includes('归并本阶段独立复核发现的共同事项')) {
        assert.equal(scenario, 'new_issue')
        return response({ groups: [{ topic: '幕后人的真实身份', members: [0] }] })
      }
      if (prompt.includes('待核对草稿原文（资料）：')) {
        const content = sources(prompt).find(item => item.key === 'outline')!.content
        return response({ checked_artifacts: scriptStageArtifacts.outline, findings: [{ ...finding('outline', content),
          topic: scenario === 'still_open' ? '记忆代价' : '幕后人的真实身份', explanation: '当前正文仍有实质缺口。' }] })
      }
      repairs++
      assert.ok(repairs <= 4)
      return response(repairs === 1 ? { ...repair, source_edits: [] } : { decisions: [concreteDecision], summary: '继续补齐记忆代价的触发后果。', source_edits: [],
        edits: [{ ...repair.edits[0], find: repair.edits[0].replace + '钥匙失效。'.repeat(repairs - 2), replace: repair.edits[0].replace + '钥匙失效。'.repeat(repairs - 1) }] })
    })
    const result = await api<any>('POST', `/api/projects/${f.project.id}/script/director/chat`, chatBody(f.model.id, {
      draft_resolution: { id: pending.id, version: pending.version, strategy: 'ai' },
    }))
    assert.equal(repairs, scenario === 'still_open' ? 4 : 1)
    assert.equal(result.draft_resolution.id, pending.id)
    assert.equal(result.execution_outcome.kind, scenario === 'still_open' ? 'partial' : 'question')
    if (scenario === 'still_open') {
      assert.equal(result.draft_resolution.findings[0].delegated, true)
      assert.equal(result.draft_resolution.findings[0].repair_attempts, 4)
      assert.equal(result.draft_resolution.run.status, 'interrupted')
      assert.equal(result.draft_resolution.completed_rounds, 4)
      assert.equal(result.draft_resolution.run.completed_rounds, 4)
      assert.equal(pendingScriptDraft(f.project.id)!.resolutions?.[0].decision, concreteDecision)
      assert.notEqual(pendingScriptDraft(f.project.id)!.resolutions?.[0].decision, pendingScriptDraft(f.project.id)!.resolutions?.[0].summary)
      const stopped = pendingScriptDraft(f.project.id)!
      t.mock.method(globalThis, 'fetch', async () => assert.fail('continuing a spent allowance must not dispatch any model request'))
      const continued = await app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/director/chat`,
        payload: chatBody(f.model.id, { draft_resolution: { id: stopped.id, version: stopped.version, strategy: 'continue' } }) })
      assert.equal(continued.statusCode, 409)
      assert.match(continued.body, /4 轮/)
      assert.deepEqual(pendingScriptDraft(f.project.id), stopped, 'rejection preserves the repaired candidate and its allowance')
    } else assert.equal(result.draft_resolution.findings[0].delegated, scenario === 'past_issue' ? true : undefined)
    assert.match(pendingScriptDraft(f.project.id)!.draft.artifacts.find(item => item.artifact_type === 'outline')!.content, /损失一天记忆/)
    assert.equal((await api<any>('GET', `/api/projects/${f.project.id}/script/source`)).content, originalText)
  })
})

test('remaining findings retain patch progress under the same id and a new version; invalid requests never call the model', async t => {
  const f = await pauseCandidate(t)
  const url = `/api/projects/${f.project.id}/script/director/chat`, { id, version } = f.resolution
  const unauthorizedContinuation = await app.inject({ method: 'POST', url, payload: chatBody(f.model.id, { draft_resolution: { id, version, strategy: 'continue' } }) })
  assert.equal(unauthorizedContinuation.statusCode, 409)
  assert.match(unauthorizedContinuation.body, /尚无可继续的处理方案/)
  let repairs = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const analyzedSource = sourceAnalysisFixture(prompt)
    if (analyzedSource) return response(analyzedSource)
    if (prompt.includes('待核对草稿原文（资料）：')) return response({ checked_artifacts: scriptStageArtifacts.outline, findings: [finding('world')] })
    repairs++; return response({ ...repair, source_edits: repair.edits.map(({ source_key: _key, ...edit }) => edit) })
  })
  const resumed = await api<any>('POST', url, chatBody(f.model.id, { draft_resolution: { id, version, strategy: 'ai' } }))
  assert.equal(resumed.draft_resolution.id, id); assert.notEqual(resumed.draft_resolution.version, version)
  const { pendingScriptDraft } = await import('../src/modules/script/script-draft-resolution.js')
  assert.match(pendingScriptDraft(f.project.id)!.draft.artifacts[0].content, /损失一天记忆/)
  assert.match(pendingScriptDraft(f.project.id)!.source_update!.content, /损失一天记忆/)
  assert.equal((await api<any>('GET', `/api/projects/${f.project.id}/script/source`)).content, originalText)
  for (const [input, status] of [
    [{ id, version, strategy: 'ai' }, 409],
    [{ id, version: resumed.draft_resolution.version, strategy: 'manual', answers: [] }, 422],
    [{ id, version: resumed.draft_resolution.version, strategy: 'manual', answers: [' '] }, 422],
  ] as const) {
    const result = await app.inject({ method: 'POST', url, payload: chatBody(f.model.id, { draft_resolution: input }) })
    assert.equal(result.statusCode, status, result.body)
  }
  const other = await fixture()
  assert.equal((await app.inject({ method: 'POST', url: `/api/projects/${other.project.id}/script/director/chat`, payload: chatBody(f.model.id, { draft_resolution: { id, version, strategy: 'ai' } }) })).statusCode, 409)
  assert.equal(repairs, 1)
  await api('PATCH', `/api/projects/${f.project.id}`, { brief: '修改后的新来源' })
  const changed = await app.inject({ method: 'POST', url, payload: chatBody(f.model.id, { draft_resolution: { id, version: resumed.draft_resolution.version, strategy: 'ai' } }) })
  assert.equal(changed.statusCode, 409); assert.match(changed.body, /项目资料或原剧本已变化/); assert.equal(repairs, 1)
  await api('POST', `/api/projects/${f.project.id}/script/director/resolutions/${id}/discard`, { version: resumed.draft_resolution.version })
  assert.equal(pendingScriptDraft(f.project.id), null)
})

test('provider failures keep the candidate recoverable and concurrent resolution cannot start a second model call', async t => {
  const f = await pauseCandidate(t, true), url = `/api/projects/${f.project.id}/script/director/chat`
  const body = chatBody(f.model.id, { draft_resolution: { id: f.resolution.id, version: f.resolution.version, strategy: 'ai' } })
  const { pendingScriptDraft } = await import('../src/modules/script/script-draft-resolution.js')
  const before = pendingScriptDraft(f.project.id)
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: '上游不可用' } }, { status: 502 }))
  assert.equal((await app.inject({ method: 'POST', url, payload: body })).statusCode, 502)
  const { run, ...retained } = pendingScriptDraft(f.project.id)!
  assert.deepEqual(retained, before)
  assert.equal(run!.status, 'interrupted'); assert.equal(run!.strategy, 'ai')
  assert.equal(run!.completed, 0); assert.equal(run!.answers.length, before!.findings.length)
  const state = await api<any>('GET', `/api/projects/${f.project.id}/script/director/tools-state`)
  assert.equal(state.draft_resolution.run.answers, undefined, 'internal authorization answers are not exposed in progress')
  let entered!: () => void, release!: () => void, calls = 0
  const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const analyzedSource = sourceAnalysisFixture(prompt)
    if (analyzedSource) return response(analyzedSource)
    if (prompt.includes('待核对草稿原文（资料）：')) return response({ checked_artifacts: scriptStageArtifacts.outline, findings: [] })
    calls++; entered(); await held; return response(repair)
  })
  const continuation = chatBody(f.model.id, { draft_resolution: { id: f.resolution.id, version: f.resolution.version, strategy: 'continue' } })
  const first = app.inject({ method: 'POST', url, payload: continuation })
  await started
  const duplicate = await app.inject({ method: 'POST', url, payload: body })
  assert.equal(duplicate.statusCode, 409); assert.equal(calls, 1)
  const discard = await app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/script/director/resolutions/${f.resolution.id}/discard`, payload: { version: f.resolution.version } })
  assert.equal(discard.statusCode, 409)
  release(); assert.equal((await first).statusCode, 200)
  assert.equal(pendingScriptDraft(f.project.id), null); assert.ok(getToolDraft(f.project.id))
})

test('a failed final review resumes the saved manual authorization and repaired checkpoint without another repair', async t => {
  const f = await pauseCandidate(t)
  const url = `/api/projects/${f.project.id}/script/director/chat`
  let repairs = 0, failReview = true
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const analyzedSource = sourceAnalysisFixture(prompt)
    if (analyzedSource) return response(analyzedSource)
    if (prompt.includes('待核对草稿原文（资料）：')) {
      assert.match(prompt, /只失去一天记忆，保留60集/)
      return failReview ? Response.json({ error: { message: '复核暂时断开' } }, { status: 502 })
        : response({ checked_artifacts: scriptStageArtifacts.outline, findings: [] })
    }
    repairs++
    return response(repair)
  })
  const first = await app.inject({ method: 'POST', url: url + '/stream', payload: chatBody(f.model.id, {
    draft_resolution: { id: f.resolution.id, version: f.resolution.version, strategy: 'manual', answers: ['只失去一天记忆，保留60集'] },
  }) })
  const events = first.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
  assert.ok(events.some(event => event.type === 'error'))
  assert.ok(events.some(event => event.type === 'draft_resolution_progress' && event.draft_resolution.run.completed === 1))
  const state = await api<any>('GET', `/api/projects/${f.project.id}/script/director/tools-state`)
  assert.equal(state.draft_resolution.version, f.resolution.version)
  assert.deepEqual(state.draft_resolution.run, { strategy: 'manual', status: 'interrupted', completed: 1, total: 1,
    message: state.draft_resolution.run.message })
  assert.match(state.draft_resolution.findings[0].previous_answer, /只失去一天记忆/)
  failReview = false
  const result = await api<any>('POST', url, chatBody(f.model.id, {
    draft_resolution: { id: f.resolution.id, version: f.resolution.version, strategy: 'continue' },
  }))
  assert.equal(result.draft_resolution, null)
  assert.equal(repairs, 1, 'progress metadata and continue text never invalidate validated edits')
  assert.match(result.draft.artifacts[0].content, /损失一天记忆/)
  assert.equal((await api<any>('GET', `/api/projects/${f.project.id}/script/source`)).content, originalText)
})

test('a failed revised-source analysis is identified before independent review and keeps repairs recoverable', async t => {
  const f = await pauseCandidate(t)
  const url = `/api/projects/${f.project.id}/script/director/chat`
  let repairs = 0, audits = 0, failAnalysis = true
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const analyzedSource = sourceAnalysisFixture(prompt)
    if (analyzedSource) return failAnalysis ? Response.json({ error: { message: '修订稿人物整合暂时中断' } }, { status: 502 }) : response(analyzedSource)
    if (prompt.includes('待核对草稿原文（资料）：')) {
      audits++
      return response({ checked_artifacts: scriptStageArtifacts.outline, findings: [] })
    }
    repairs++
    return response({ ...repair, source_edits: repair.edits.map(({ source_key: _key, ...edit }) => edit) })
  })
  const first = await app.inject({ method: 'POST', url: url + '/stream', payload: chatBody(f.model.id, {
    draft_resolution: { id: f.resolution.id, version: f.resolution.version, strategy: 'ai' },
  }) })
  const events = first.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
  assert.ok(events.some(event => event.type === 'error' && event.message.startsWith('修订稿分析未完成，尚未开始阶段设定核对：')), first.body)
  assert.ok(events.some(event => event.type === 'activity' && event.activity.label === '分析修订稿' && event.activity.status === 'failed'))
  assert.equal(events.some(event => event.type === 'activity' && event.activity.label === '核对阶段设定'), false)
  assert.equal(audits, 0, 'independent review cannot start with an incomplete source analysis')
  const state = await api<any>('GET', `/api/projects/${f.project.id}/script/director/tools-state`)
  assert.equal(state.draft_resolution.run.completed, 1)
  assert.equal(state.draft_resolution.run.status, 'interrupted')
  assert.match(state.draft_resolution.run.message, /修订稿分析未完成/)
  assert.equal(getToolDraft(f.project.id), null)
  assert.equal((await api<any>('GET', `/api/projects/${f.project.id}/script/source`)).content, originalText)
  failAnalysis = false
  const resumed = await api<any>('POST', url, chatBody(f.model.id, {
    draft_resolution: { id: f.resolution.id, version: f.resolution.version, strategy: 'continue' },
  }))
  assert.equal(repairs, 1, 'the validated repair checkpoint is reused after source analysis recovery')
  assert.equal(audits, 1)
  assert.equal(resumed.draft_resolution, null)
  const sourceStep = resumed.activity.findIndex((item: any) => item.label === '分析修订稿' && item.status === 'succeeded')
  const reviewStep = resumed.activity.findIndex((item: any) => item.label === '核对阶段设定' && item.status === 'succeeded')
  assert.ok(sourceStep >= 0 && reviewStep > sourceStep)
  assert.match(resumed.source_update.content, /损失一天记忆/)
  assert.equal((await api<any>('GET', `/api/projects/${f.project.id}/script/source`)).content, originalText, 'successful review still requires the creator to confirm saving')
})

test('durable revision budget stops before dispatch and continue cannot reset consumed requests', async t => {
  const f = await pauseCandidate(t)
  const url = `/api/projects/${f.project.id}/script/director/chat`
  const previous = process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS
  process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS = '2'
  let repairs = 0, analysis = 0, audits = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const analyzedSource = sourceAnalysisFixture(prompt)
    if (analyzedSource) { analysis++; return response(analyzedSource) }
    if (prompt.includes('待核对草稿原文（资料）：')) { audits++; return response({ checked_artifacts: scriptStageArtifacts.outline, findings: [] }) }
    repairs++
    return response({ ...repair, source_edits: repair.edits.map(({ source_key: _key, ...edit }) => edit) })
  })
  try {
    const payload = (strategy: 'ai' | 'continue') => chatBody(f.model.id, { draft_resolution: { id: f.resolution.id, version: f.resolution.version, strategy } })
    const first = await app.inject({ method: 'POST', url, payload: payload('ai') })
    assert.equal(first.statusCode, 422, first.body)
    assert.match(first.body, /模型请求预算/)
    assert.equal(repairs, 1)
    assert.equal(analysis, 0, 'the repair reads the full manuscript directly; no pre-repair map is generated')
    assert.equal(audits, 0)
    const continued = await app.inject({ method: 'POST', url, payload: payload('continue') })
    assert.equal(continued.statusCode, 422, continued.body)
    assert.equal(repairs, 1)
    assert.equal(analysis, 0)
    process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS = '120'
    const resumed = await api<any>('POST', url, payload('continue'))
    assert.equal(resumed.draft_resolution, null)
    assert.equal(repairs, 1, 'the saved patch is reused after a budget increase')
    assert.ok(analysis > 0)
    assert.equal(audits, 1)
    assert.ok(resumed.activity.some((event: any) => /累计.*tokens（保守估算/.test(event.summary)))
    assert.equal((await api<any>('GET', `/api/projects/${f.project.id}/script/source`)).content, originalText)
  } finally {
    if (previous === undefined) delete process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS
    else process.env.VIDEO_STUDIO_SCRIPT_ANALYSIS_MAX_REQUESTS = previous
  }
})

test('review transport errors stop native and JSON requests before persistence without repeating generation', async t => {
  for (const useTools of [true, false]) for (const suffix of ['', '/stream']) await t.test(`${useTools ? 'native' : 'JSON'} ${suffix || '/chat'}`, async t => {
    const { project, model } = await fixture()
    const before = await api<{ script: ScriptSnapshot }>('GET', `/api/projects/${project.id}`)
    let generations = 0, audits = 0
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(String(init?.body)), prompt = body.messages[0].content as string
      if (prompt.includes('本次独立调用只理解创作者意图')) return response({ action: 'draft', operation: 'create', workflow: { stage: 'outline' }, creative_brief: '完整大纲' })
      if (prompt.includes('待核对草稿原文（资料）：')) {
        audits++
        return Response.json({ error: { message: '核对模型暂不可用' } }, { status: 502 })
      }
      generations++
      const draft = candidate('outline', '主角以公开证据结束追查，保留家人记忆。')
      return response({ artifacts: draft.artifacts, scenes: [] })
    })
    const result = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat${suffix}`, payload: {
      model_id: model.id, mode: 'script', use_tools: useTools, workflow: { stage: 'outline' }, messages: [{ role: 'user', text: '生成完整大纲' }] } })
    if (suffix) {
      const events = result.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
      assert.equal(events.some(event => event.type === 'done'), false)
      assert.ok(events.some(event => event.type === 'error' && event.message.includes('阶段设定核对未完成')), result.body)
    } else {
      assert.equal(result.statusCode, 502)
      assert.match(result.body, /阶段设定核对未完成/)
    }
    assert.equal(generations, 1); assert.equal(audits, 2, 'one read-only audit retry cannot regenerate the candidate')
    assert.equal(getToolDraft(project.id), null)
    assert.deepEqual((await api<{ script: ScriptSnapshot }>('GET', `/api/projects/${project.id}`)).script, before.script)
  })
})

test('semantic repair reuses creation authorization and a failed workflow edit keeps the last valid draft', async () => {
  const { project } = await fixture()
  const { script } = await api<{ script: ScriptSnapshot }>('GET', `/api/projects/${project.id}`)
  let authorizations = 0, audits = 0
  const tools = documentTools({ project, script: () => script, stage: directorStageContext(script),
    messages: [{ role: 'user', text: '生成完整全剧大纲' }], checkApproval: async () => false, onEvent: () => {},
    authorizeCreation: async () => { authorizations++; return true },
    validateCreation: (draft, preserved) => reviewScriptDraftCompleteness(draft, async prompt => {
      audits++
      const pending = sources(prompt).find(source => source.content.includes('待定'))
      return JSON.stringify({ checked_artifacts: scriptStageArtifacts.outline, findings: pending ? [{ source_key: pending.key,
        kind: 'unresolved_setting', quote: pending.content, explanation: '主线结局尚未确定。', suggestion: '确定主角最后的选择与后果。' }] : [] })
    }, { preserved }),
  })
  await assert.rejects(tools.execute('create_document_draft', candidate('outline', '结局待定。')), /主线结局尚未确定/)
  assert.equal(getToolDraft(project.id), null)
  await tools.execute('create_document_draft', candidate('outline', '主角公开证据，追查结束。'))
  assert.equal(authorizations, 1)
  const original = getToolDraft(project.id)!
  await tools.execute('manage_document_draft', { operation: 'read', draft_id: original.id })
  await assert.rejects(tools.execute('manage_document_draft', { operation: 'update', draft_id: original.id, version: original.version,
    changes: [{ document_id: original.documents[0].id, base_version: original.version,
      replacements: [{ find: '主角公开证据，追查结束。', replace: '结局待定。', reason: '核对失败回滚测试' }] }] }), /主线结局尚未确定/)
  assert.equal(audits, 3)
  assert.deepEqual(getToolDraft(project.id), original, 'failed review cannot change content or draft version')
  assert.deepEqual((await api<{ script: ScriptSnapshot }>('GET', `/api/projects/${project.id}`)).script, script)
})


test('exact repairs preserve metadata and untouched scene fields and reject invented, ambiguous or overlapping replacements', async () => {
  const { repairScriptDraft } = await import('../src/modules/script/script-draft-resolution.js')
  const draft = candidate('episode', '主角林晚，60集结局既定。能力代价：待定。')
  draft.scenes[0].action = '能力代价：待定。随后林晚开门。'
  const pending = { id: 'candidate', version: 'v1', draft, findings: [], request: {}, source_version: 'source' }
  const edit = { find: '能力代价：待定。', replace: '能力代价：失去一天记忆。', reason: '同步具体代价' }
  const result = repairScriptDraft(pending, [{ ...edit, source_key: 'episode_script' }, { ...edit, source_key: 'scene:0:action' }])
  assert.equal(result.stage, draft.stage); assert.equal(result.episode_number, 1)
  assert.deepEqual({ ...result.scenes[0], action: draft.scenes[0].action }, draft.scenes[0])
  assert.equal(result.scenes[0].action, '能力代价：失去一天记忆。随后林晚开门。')
  assert.equal(draft.artifacts[0].content, pending.draft.artifacts[0].content, 'input is never mutated')
  assert.throws(() => repairScriptDraft(pending, [{ ...edit, source_key: 'foreign' }]), /不属于/)
  assert.throws(() => repairScriptDraft(pending, [{ ...edit, source_key: 'episode_script', find: '不存在的原文' }]))
  assert.throws(() => repairScriptDraft(pending, [{ ...edit, source_key: 'episode_script' }, { ...edit, source_key: 'episode_script', find: '代价：待定。' }]))
  const ambiguous = structuredClone(pending); ambiguous.draft.scenes[0].action += '能力代价：待定。'
  assert.throws(() => repairScriptDraft(ambiguous, [{ ...edit, source_key: 'scene:0:action' }]))
})

test('durable tasks complete as a question when paused and cancellation of a repair keeps the original candidate', async t => {
  const { project, model } = await fixture()
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const analyzedSource = sourceAnalysisFixture(prompt)
    if (analyzedSource) return response(analyzedSource)
    if (prompt.includes('待核对草稿原文（资料）：')) return response({ checked_artifacts: scriptStageArtifacts.outline, findings: [finding()] })
    const draft = candidate('outline', originalText); return response({ artifacts: draft.artifacts, scenes: [] })
  })
  const task = (id: string) => ({ id, conversation: { id: `conversation-${id}`, messages: [{ id: 'user', role: 'user', text: '生成大纲' }] },
    execution: { title: '生成大纲', request: '生成大纲', started_at: Date.now(), mode: 'script', focus_artifact: 'all' } })
  const taskId = crypto.randomUUID()
  const url = `/api/projects/${project.id}/script/director/chat/stream`
  const first = await app.inject({ method: 'POST', url, payload: chatBody(model.id, { use_tools: true, workflow: { stage: 'outline' }, task: task(taskId) }) })
  const paused = doneEvent(first, true)
  assert.ok(paused, first.body)
  const finished = await api<any>('GET', `/api/projects/${project.id}/script/director/tasks/${taskId}`)
  assert.equal(finished.status, 'succeeded'); assert.equal(finished.execution.outcome.kind, 'question')
  const history = await api<any>('GET', `/api/projects/${project.id}/script/conversations`)
  assert.equal(history.conversations[0].messages.at(-1).execution.outcome.kind, 'question')
  assert.ok(!history.conversations[0].messages.at(-1).failed)
  let entered!: () => void, calls = 0
  const started = new Promise<void>(resolve => { entered = resolve })
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++; entered()
    return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
  })
  const repairTaskId = crypto.randomUUID(), resolution = paused.draft_resolution
  const repairing = app.inject({ method: 'POST', url, payload: chatBody(model.id, {
    draft_resolution: { id: resolution.id, version: resolution.version, strategy: 'ai' }, task: task(repairTaskId) }) })
  await started
  await api('POST', `/api/projects/${project.id}/script/director/tasks/${repairTaskId}/cancel`, {})
  assert.match((await repairing).body, /cancelled/)
  const restored = await api<any>('GET', `/api/projects/${project.id}/script/director/tools-state`)
  const { run: progress, ...restoredCandidate } = restored.draft_resolution
  assert.deepEqual(restoredCandidate, resolution); assert.equal(progress.status, 'interrupted')
  assert.equal(calls, 1); assert.equal(restored.draft, null)
})

test('native supplementation pauses the tool loop immediately and resumes without rewriting preserved historical documents', async t => {
  const { project, model } = await fixture()
  await api('PUT', `/api/projects/${project.id}/script`, { outline: '历史大纲：全剧60集，林晚保留家人记忆。', characters: '' })
  const before = await api<any>('GET', `/api/projects/${project.id}`)
  const { projectDocuments } = await import('../src/modules/script/script-document-tools.js')
  const historical = projectDocuments(project.id, before.script).find(doc => doc.artifact_type === 'outline')!
  const draft = candidate('outline', originalText); draft.operation = 'supplement'; draft.artifacts[0].content = historical.content; draft.artifacts[0].title = historical.title
  let rounds = 0, audits = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const analyzedSource = sourceAnalysisFixture(prompt)
    if (analyzedSource) return response(analyzedSource)
    if (prompt.includes('待核对草稿原文（资料）：')) {
      audits++
      const submitted = sources(prompt)
      assert.ok(submitted.every(doc => doc.key !== 'outline'), 'unchanged historical text is background only')
      return response({ checked_artifacts: scriptStageArtifacts.outline.slice(1), findings: audits === 1 ? [finding('synopsis')] : [] })
    }
    if (prompt.includes('继续已授权阶段的候选草稿')) return response({ ...repair, edits: repair.edits.map(edit => ({ ...edit, source_key: 'synopsis' })) })
    rounds++
    return rounds === 1 ? toolCall('read-history', 'read_documents', { document_ids: [historical.id] }) : toolCall('submit-stage', 'create_document_draft', draft)
  })
  const paused = await api<any>('POST', `/api/projects/${project.id}/script/director/chat`, chatBody(model.id, { use_tools: true, workflow: { stage: 'outline', operation: 'supplement' } }))
  assert.equal(rounds, 2); assert.equal(audits, 1); assert.equal(paused.execution_outcome.kind, 'question')
  assert.ok(paused.activity.every((step: any) => step.status === 'succeeded'))
  const { id, version } = paused.draft_resolution
  const ready = await api<any>('POST', `/api/projects/${project.id}/script/director/chat`, chatBody(model.id, { draft_resolution: { id, version, strategy: 'ai' } }))
  assert.equal(ready.tool_draft.documents.find((doc: any) => doc.artifact_type === 'outline').content, historical.content)
  assert.equal(ready.workflow.operation, 'supplement'); assert.equal(ready.draft_resolution, null)
  assert.equal(rounds, 2); assert.equal(audits, 2)
  assert.deepEqual((await api<any>('GET', `/api/projects/${project.id}`)).script, before.script)
})

test('source synchronization findings can be repaired without rewriting the already completed stage draft', async t => {
  const { project, model } = await fixture(); await uploadSource(project.id)
  let audits = 0, repairs = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const analyzedSource = sourceAnalysisFixture(prompt)
    if (analyzedSource) return response(analyzedSource)
    if (prompt.includes('本次独立调用只理解创作者意图')) return response({ action: 'draft', operation: 'create', workflow: { stage: 'outline' }, creative_brief: '忠实整理60集' })
    if (prompt.includes('待核对草稿原文（资料）：')) {
      audits++
      if (audits > 1) assert.match(prompt, /不能只在阶段文档补齐/)
      return response({ checked_artifacts: scriptStageArtifacts.outline, findings: audits === 1 ? [finding()] : audits === 2
        ? [{ ...finding('outline', repair.edits[0].replace), explanation: '候选稿已补齐，但文稿来源仍保留旧缺口，需要同步。' }] : [] })
    }
    if (prompt.includes('继续已授权阶段的候选草稿')) {
      repairs++
      return response(repairs === 1 ? repair : { decisions: [concreteDecision], summary: '将已补齐的能力代价同步到文稿，阶段稿不再改写。', edits: [], source_edits: repair.edits.map(({ source_key: _key, ...edit }) => edit) })
    }
    return response({ artifacts: candidate('outline', originalText).artifacts, scenes: [] })
  })
  const url = `/api/projects/${project.id}/script/director/chat`
  const first = await api<any>('POST', url, chatBody(model.id, { workflow: { stage: 'outline' }, use_tools: false }))
  const second = await api<any>('POST', url, chatBody(model.id, { draft_resolution: { id: first.draft_resolution.id, version: first.draft_resolution.version, strategy: 'ai' } }))
  assert.ok(second.draft_resolution)
  const { pendingScriptDraft } = await import('../src/modules/script/script-draft-resolution.js')
  const completedArtifacts = pendingScriptDraft(project.id)!.draft.artifacts
  const third = await api<any>('POST', url, chatBody(model.id, { draft_resolution: { id: second.draft_resolution.id, version: second.draft_resolution.version, strategy: 'ai' } }))
  assert.equal(third.draft_resolution, null)
  assert.deepEqual(third.draft.artifacts, completedArtifacts)
  assert.equal(third.source_update.content, originalText.replace(repair.edits[0].find, repair.edits[0].replace))
  assert.equal((await api<any>('GET', `/api/projects/${project.id}/script/source`)).content, originalText)
  assert.equal(repairs, 2); assert.equal(audits, 3)
})

test('AI resolution of long-source duplicate findings reaches an independently reviewed preview over both draft transports', async t => {
  const { retainScriptDraft, pendingScriptDraft } = await import('../src/modules/script/script-draft-resolution.js')
  const { creationState } = await import('../src/modules/script/script-document-tools.js')
  for (const useTools of [false, true]) await t.test(useTools ? 'native draft' : 'JSON draft', async t => {
    const { project, model } = await fixture()
    const content = '林舟动机：履行对伙伴的承诺归还钥匙。\n' + '已明确的剧情保持。'.repeat(1500) + '\n终场林舟归还钥匙。'
    const uploaded = await uploadSource(project.id, content)
    await api('PUT', `/api/projects/${project.id}/script/director/draft`, { ...candidate('outline', '已保存完整全剧大纲，林舟得到并归还钥匙。'), source_version: scriptDocumentVersion(uploaded) })
    const before = await api<any>('GET', `/api/projects/${project.id}`)
    const draft = candidate('characters', '伙伴之间原本互相信任。')
    draft.artifacts[0].content = '林舟动机：待补齐。\n其他人物保持。'
    const issue = { source_key: 'characters', kind: 'unresolved_setting' as const, quote: '林舟动机：待补齐。', explanation: '动机未明确', suggestion: '沿用原稿对伙伴履约的动机' }
    const pending = retainScriptDraft(project.id, { draft, findings: [issue, { ...issue, explanation: '同一动机的重复问题' }],
      source_version: createHash('sha256').update(JSON.stringify([project.name, project.brief, creationState(project.id, before.script).version, scriptDocumentVersion(uploaded)])).digest('hex'),
      request: chatBody(model.id, { use_tools: useTools, workflow: { stage: 'characters' } }) })
    let repairs = 0, audits = 0
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).messages[0].content as string
      const analyzedSource = sourceAnalysisFixture(prompt)
      if (analyzedSource) return response(analyzedSource)
      if (prompt.includes('继续已授权阶段的候选草稿')) {
        repairs++
        assert.ok(prompt.includes(JSON.stringify(content).slice(1, -1)), 'the repair receives the entire effective source')
        assert.ok(prompt.includes(JSON.stringify(draft.artifacts[0].content).slice(1, -1)), 'the repair receives the entire candidate')
        return response({ decisions: ['林舟为履行对伙伴的承诺而归还钥匙。', '承诺对象为伙伴，归还动机沿用原稿。'], summary: '人物动机与有效稿一致。', source_edits: [], edits: [{ source_key: 'characters',
          find: '林舟动机：待补齐。', replace: '林舟动机：履行对伙伴的承诺归还钥匙。', reason: '原稿已正确，只同步人物候选稿' }] })
      }
      assert.match(prompt, /待核对草稿原文（资料）：/, 'repair must proceed to independent review')
      audits++
      const material = sources(prompt) as any
      if (Array.isArray(material)) {
        assert.match(material.find((item: any) => item.key === 'characters').content, /履行对伙伴的承诺/)
        return response({ checked_artifacts: scriptStageArtifacts.characters, findings: [], facts: material.map((item: any) => ({ source_key: item.key, quote: item.content, meaning: '原稿与候选稿的具体人物事实' })) })
      }
      return response({ checked_artifacts: scriptStageArtifacts.characters, findings: [], facts: [] })
    })
    const result = await api<any>('POST', `/api/projects/${project.id}/script/director/chat`, chatBody(model.id, {
      draft_resolution: { id: pending.id, version: pending.version, strategy: 'ai' },
    }))
    assert.equal(repairs, 1); assert.equal(audits, 1)
    assert.equal(result.draft_resolution, null); assert.equal(pendingScriptDraft(project.id), null)
    const documents = useTools ? result.tool_draft.documents : result.draft.artifacts
    assert.equal(documents.find((item: any) => item.artifact_type === 'characters').content, '林舟动机：履行对伙伴的承诺归还钥匙。\n其他人物保持。')
    assert.equal(documents.find((item: any) => item.artifact_type === 'relationships').content, '伙伴之间原本互相信任。')
    assert.deepEqual((await api<any>('GET', `/api/projects/${project.id}`)).script, before.script)
    assert.equal((await api<any>('GET', `/api/projects/${project.id}/script/source/original`)).content, content)
  })
})

test('whole-work audit retains cross-document contradictions and reads all original evidence in the same request', async () => {
  const draft = candidate('characters', '林舟是记者。' + '完整剧情铺垫。'.repeat(2400) + '结局林舟归还钥匙。')
  draft.artifacts[1].content = '林舟是医生。伙伴与林舟共同守护钥匙。'
  let calls = 0
  await assert.rejects(reviewScriptDraftCompleteness(draft, async prompt => {
    calls++
    const submitted = sources(prompt)
    assert.deepEqual(submitted.map(item => item.content), draft.artifacts.map(item => item.content))
    assert.ok(prompt.includes('开场林舟拿到钥匙。'))
    assert.ok(prompt.includes('结局林舟归还钥匙。'))
    return JSON.stringify({ checked_artifacts: scriptStageArtifacts.characters, facts: [], findings: [{ source_key: 'relationships', quote: '林舟是医生。',
      kind: 'contradiction', explanation: '人物身份与人物小传不一致', suggestion: '沿用已确认记者身份' }] })
  }, { sourceBatches: [[{ id: 0, content: '开场林舟拿到钥匙。' }], [{ id: 1, content: '结局林舟归还钥匙。' }]] }), /人物身份与人物小传不一致/)
  assert.equal(calls, 1)
})
