import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { scriptStageArtifacts, scriptArtifactLabels, type ScriptStage } from '@video-studio/shared/script/script-stage-content'
import { reviewScriptDraftCompleteness } from '../src/modules/script/script-draft-completeness.js'
import { workflowGenerationDraftSchema, type WorkflowDraft } from '../src/modules/script/script-workflow.js'
import { ScriptToolProblem } from '../src/modules/script/script-revision.js'
import type { Project } from '../src/infrastructure/database/db.js'
import type { ScriptSnapshot } from '../src/modules/script/script-document-tools.js'

const dataDir = await mkdtemp(join(tmpdir(), 'studio-setting-completeness-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/infrastructure/database/db.js')
const { documentTools, getToolDraft } = await import('../src/modules/script/script-document-tools.js')
const { directorStageContext } = await import('../src/modules/script/script-workflow.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(dataDir, { recursive: true, force: true }) })

function candidate(stage: ScriptStage, content = '能力使用后的具体损失以后再说。'): WorkflowDraft {
  return workflowGenerationDraftSchema.parse({ stage, episode_number: stage === 'episode' ? 1 : 0,
    artifacts: scriptStageArtifacts[stage].map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type], content })),
    scenes: stage === 'episode' ? [{ heading: '夜间车站', location: '车站', characters: '林晚', action: content, dialogue: '我会去查清楚。', duration: 12 }] : [] })
}
function sources(prompt: string): Array<{ key: string; artifact_type: string; content: string }> {
  return JSON.parse(prompt.slice(prompt.lastIndexOf('待核对草稿原文（资料）：') + '待核对草稿原文（资料）：'.length))
}

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

async function api<T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<T> {
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

test('native and JSON creation over both transports repair core settings before presenting a draft and never save automatically', async t => {
  for (const useTools of [true, false]) for (const suffix of ['', '/stream']) await t.test(`${useTools ? 'native' : 'JSON'} ${suffix || '/chat'}`, async t => {
    const { project, model } = await fixture(), before = await api('GET', `/api/projects/${project.id}`)
    let generations = 0, audits = 0, nativeTurns = 0
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(String(init?.body)), prompt = body.messages[0].content as string
      if (prompt.includes('本次独立调用只理解创作者意图')) return response({ action: 'draft', operation: 'create', workflow: { stage: 'outline' }, creative_brief: '生成大纲，本阶段缺失虚构细节由模型设计。' })
      if (prompt.includes('待核对草稿原文（资料）：')) {
        audits++
        assert.equal(getToolDraft(project.id), null, 'candidate is not persisted before review succeeds')
        const submitted = sources(prompt)
        return response({ checked_artifacts: scriptStageArtifacts.outline, findings: audits === 1 ? [{ source_key: submitted[0].key,
          kind: 'unresolved_setting', quote: submitted[0].content, explanation: '关键能力代价仍未设计。', suggestion: '确定每次使用损失一天记忆且无法恢复。' }] : [] })
      }
      if (useTools) {
        nativeTurns++
        if (nativeTurns === 2) {
          const diagnostic = JSON.parse(body.messages.at(-1).content)
          assert.equal(diagnostic.diagnostic.code, 'incomplete_creative_settings')
          assert.match(diagnostic.diagnostic.repair, /不重复授权/)
        }
        if (nativeTurns === 3) return response('草稿已完成，等待预览确认。')
      } else if (generations) assert.match(prompt, /设定完整性修正[\s\S]*无法恢复/)
      generations++
      const draft = candidate('outline', generations === 1 ? '能力代价：待定。' : '能力代价：每次使用损失一天记忆，无法恢复。结局主角放弃最后一次使用，保留与家人的记忆。')
      return useTools ? toolCall(`create-${generations}`, 'create_document_draft', draft) : response({ artifacts: draft.artifacts, scenes: [] })
    })
    const result = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat${suffix}`, payload: {
      model_id: model.id, mode: 'script', use_tools: useTools, workflow: { stage: 'outline' }, messages: [{ role: 'user', text: '生成全剧大纲，保持主角林晚，其他普通细节由你决定。' }] } })
    assert.equal(result.statusCode, 200, result.body)
    const done = suffix ? result.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(event => event.type === 'done') : result.json()
    assert.ok(done, result.body)
    assert.equal(audits, 2); assert.equal(generations, 2)
    const text = useTools ? done.tool_draft.documents[0].content : done.draft.artifacts[0].content
    assert.match(text, /损失一天记忆/); assert.doesNotMatch(text, /待定/)
    assert.equal(useTools ? done.tool_draft.status : done.draft.stage, useTools ? 'pending' : 'outline')
    const after = await api<any>('GET', `/api/projects/${project.id}`)
    assert.deepEqual(after.script, (before as any).script)
    assert.equal(done.activity.filter((step: any) => step.label === '核对阶段设定').length, 2)
  })
})

test('JSON generation bounds semantic repairs and leaves project data untouched when settings remain incomplete', async t => {
  const { project, model } = await fixture()
  let audits = 0, generations = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init?.body)), prompt = body.messages[0].content as string
    if (prompt.includes('本次独立调用只理解创作者意图')) return response({ action: 'draft', operation: 'create', workflow: { stage: 'outline' }, creative_brief: '完整大纲' })
    if (prompt.includes('待核对草稿原文（资料）：')) {
      audits++
      return response({ checked_artifacts: scriptStageArtifacts.outline, findings: [{ source_key: 'outline', kind: 'unresolved_setting',
        quote: '结局待定。', explanation: '主线结局尚未确定。', suggestion: '确定主角最后的选择与后果。' }] })
    }
    generations++
    const draft = candidate('outline', '结局待定。')
    return response({ artifacts: draft.artifacts, scenes: [] })
  })
  const result = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: {
    model_id: model.id, mode: 'script', workflow: { stage: 'outline' }, messages: [{ role: 'user', text: '生成完整大纲' }] } })
  assert.equal(result.statusCode, 422)
  assert.match(result.body, /主线结局尚未确定/)
  assert.equal(audits, 3); assert.equal(generations, 3)
  assert.equal(getToolDraft(project.id), null)
  assert.equal(((await api<any>('GET', `/api/projects/${project.id}`)).script.artifacts || []).length, 0)
})

test('native creation stops immediately after two unsuccessful semantic repairs even if the model keeps generating', async t => {
  const { project, model } = await fixture()
  const before = await api<{ script: ScriptSnapshot }>('GET', `/api/projects/${project.id}`)
  let generations = 0, audits = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init?.body)), prompt = body.messages[0].content as string
    if (prompt.includes('待核对草稿原文（资料）：')) {
      audits++
      return response({ checked_artifacts: scriptStageArtifacts.outline, findings: [{ source_key: 'outline', kind: 'unresolved_setting',
        quote: '结局待定。', explanation: '主线结局尚未确定。', suggestion: '确定主角最后的选择与后果。' }] })
    }
    generations++
    return toolCall(`create-limit-${generations}`, 'create_document_draft', candidate('outline', `候选${generations}：结局待定。`))
  })
  const result = await api<{ reply: string; execution_outcome: { kind: string }; tool_draft?: unknown }>('POST', `/api/projects/${project.id}/script/director/chat`, {
    model_id: model.id, mode: 'script', use_tools: true, workflow: { stage: 'outline' }, messages: [{ role: 'user', text: '生成完整大纲' }] })
  assert.equal(result.execution_outcome.kind, 'failed')
  assert.match(result.reply, /两次自动修正[\s\S]*主线结局尚未确定/)
  assert.equal(result.tool_draft, undefined)
  assert.equal(audits, 3); assert.equal(generations, 3)
  assert.equal(getToolDraft(project.id), null)
  assert.deepEqual((await api<{ script: ScriptSnapshot }>('GET', `/api/projects/${project.id}`)).script, before.script)
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
      return useTools ? toolCall('create-transport-test', 'create_document_draft', draft) : response({ artifacts: draft.artifacts, scenes: [] })
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
    assert.equal(generations, 1); assert.equal(audits, 1)
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
