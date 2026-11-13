import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Project, ScriptArtifact, ScriptScene } from '../src/infrastructure/database/db.js'
import type { ScriptSnapshot } from '../src/modules/script/script-document-tools.js'
import { assertDialogueBoundary } from '../src/modules/script/script-dialogue-boundary.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-dialogue-revision-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db, one, all, run } = await import('../src/infrastructure/database/db.js')
const { documentAction, documentTools, getToolDraft, runScriptTools } = await import('../src/modules/script/script-document-tools.js')
const { directorStageContext } = await import('../src/modules/script/script-workflow.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

async function call<T>(method: 'POST' | 'PUT', url: string, payload: unknown): Promise<T> {
  const result = await app.inject({ method, url, payload })
  assert.equal(result.statusCode, 200, result.body)
  return result.json() as T
}
async function fixture() {
  const project = await call<Project>('POST', '/api/projects', { name: '对白专项范围测试' })
  await call('PUT', `/api/projects/${project.id}/script`, { outline: '', characters: '', scenes: [
    { episode_number: 1, heading: '1-1 车站 夜 内', location: '车站', time_of_day: '夜', characters: '林晚，陈默', action: '林晚攥住陈默的衣袖。', dialogue: '林晚：别走。', narration: '末班车的广播响起。', duration: 8 },
    { episode_number: 2, heading: '2-1 医院 日 内', location: '医院', time_of_day: '日', characters: '陈默', action: '陈默收起病历。', dialogue: '陈默：明天见。', narration: '门外传来脚步。', duration: 6 },
  ] })
  await call('PUT', `/api/projects/${project.id}/script/artifacts`, { artifacts: [
    { artifact_type: 'episode_script', episode_number: 1, title: '第一集 末班车', content: '林晚攥住陈默的衣袖。\n林晚：别走。\n末班车的广播响起。', status: 'ready' },
    { artifact_type: 'episode_script', episode_number: 2, title: '第二集 病历', content: '陈默收起病历。\n陈默：明天见。\n门外传来脚步。', status: 'ready' },
  ] })
  const script = (): ScriptSnapshot => {
    const saved = one<{ outline: string; characters: string; generation_options: string }>('SELECT * FROM scripts WHERE project_id=?', project.id)
    return { outline: saved?.outline || '', characters: saved?.characters || '', generation_options: JSON.parse(saved?.generation_options || '{}'),
      artifacts: all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=? ORDER BY position', project.id),
      scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position', project.id) }
  }
  const selected = script().artifacts!.find(doc => doc.episode_number === 1)!
  const action = { operation: 'revise' as const, document_ids: [selected.id], revision_kind: 'dialogue' as const }
  const tools = (extra: Partial<Parameters<typeof documentTools>[0]> = {}) => documentTools({ project, script,
    stage: directorStageContext(script(), { explicit: { stage: 'episode', episode_number: 1 } }),
    skillSelections: {}, action, messages: [{ role: 'user', text: '只润色第一集对白，保留剧情和其他内容。' }],
    validateDialogueRevision: async input => {
      for (const target of input.targets.filter(item => item.before !== item.after)) {
        const speech = ['让我把话说完，你再走。', '等我把话说完，再走。'].find(text => target.after.includes(text)) || '别走。'
        assertDialogueBoundary(target, { verdict: 'allowed', explanation: '仅核准本测试指定的挽留台词，保护周围正文。',
          changes: [{ before: { quote: '别走。', occurrence: 0 }, after: { quote: speech, occurrence: 0 } }] })
      }
    },
    checkApproval: async () => false, onEvent: () => {}, ...extra })
  return { project, script, selected, action, tools }
}
async function readDocument(tools: ReturnType<typeof documentTools>, id: string) {
  const result = await tools.execute('read_documents', { document_ids: [id] }) as { documents: Array<{ id: string; version: string; scenes: Array<{ id: string; version: string }> }> }
  return result.documents[0]!
}
function patch(doc: { id: string; version: string }, scene: { id: string; version: string }, changes: Record<string, unknown> = { dialogue: '林晚：等我把话说完，再走。' }) {
  return { summary: '强化林晚挽留时的具体诉求', changes: [{ document_id: doc.id, base_version: doc.version,
    replacements: [{ find: '林晚：别走。', replace: '林晚：等我把话说完，再走。', reason: '保留挽留含义，增强口语节奏' }] }],
    scene_changes: [{ scene_id: scene.id, base_version: scene.version, changes }] }
}

test('dialogue revision is an explicit revise action and cannot be attached to review', () => {
  assert.equal(documentAction.safeParse({ operation: 'revise', document_ids: ['doc'], revision_kind: 'dialogue' }).success, true)
  assert.equal(documentAction.safeParse({ operation: 'review', document_ids: ['doc'], revision_kind: 'dialogue' }).success, false)
  assert.equal(documentAction.safeParse({ operation: 'revise', document_ids: ['doc'], revision_kind: 'all' }).success, false)
})

test('dialogue actions cannot rewrite story decisions, visual settings or unified task decisions', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected paid or network request') })
  const { project, script, tools } = await fixture(), before = script(), session = tools()
  await assert.rejects(session.execute('record_story_decision', { topic: '人物身份', content: '林晚改为医生', basis: 'delegated_model', source_message_index: 0,
    settings_patch: { episode_count: 20 } }), /对白专项/)
  await assert.rejects(session.execute('set_project_visual_style', {}), /对白专项/)
  for (const operation of ['start', 'update']) await assert.rejects(session.execute('manage_revision_task', { operation, summary: '修改全剧设定', source_message_index: 0,
    decisions: [{ topic: '人物身份', choice: '林晚改为医生', reason: '越界拟定' }] }), /对白专项/)
  assert.deepEqual(all('SELECT * FROM script_story_decisions WHERE project_id=?', project.id), [])
  assert.equal(getToolDraft(project.id), null)
  assert.deepEqual(script(), before)
})

test('dialogue patches lock selected documents and permit only the scene dialogue field before drafting', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected paid or network request') })
  const { project, script, selected, tools } = await fixture(), before = script(), session = tools()
  const read = await readDocument(session, selected.id), scene = read.scenes[0]!
  for (const changes of [{ action: '林晚追上列车。' }, { narration: '新的旁白。' }, { characters: '另一人' }, { location: '医院' }, { duration: 10 }, { dialogue: '林晚：等我。', action: '转身。' }]) {
    await assert.rejects(session.execute('propose_document_patch', patch(read, scene, changes)), /对白专项/)
    assert.equal(getToolDraft(project.id), null)
  }
  const outside = before.artifacts!.find(doc => doc.episode_number === 2)!, outsideRead = await readDocument(session, outside.id)
  await assert.rejects(session.execute('propose_document_patch', { summary: '越界修改第二集', changes: [{ document_id: outside.id, base_version: outsideRead.version,
    replacements: [{ find: '明天见', replace: '后天见', reason: '越界修改' }] }] }), /只处理创作者选择/)
  await assert.rejects(session.execute('propose_document_patch', patch(read, outsideRead.scenes[0]!)), /属于本次修改的分集/)
  assert.equal(getToolDraft(project.id), null)
  assert.deepEqual(script(), before)
})

test('dialogue changes stay in a pending draft through updates and require a new approved turn to save', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected paid or network request') })
  const { project, script, selected, tools } = await fixture(), before = script(), session = tools()
  const scene = before.scenes.find(item => item.episode_number === 1)!
  run('INSERT INTO shots (id, project_id, position, title, source_scene_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', 'dialogue-linked-shot', project.id, 0, '衣袖特写', scene.id, new Date().toISOString())
  const read = await readDocument(session, selected.id)
  const proposal = await session.execute('propose_document_patch', patch(read, read.scenes[0]!)) as { saved: boolean }
  assert.equal(proposal.saved, false)
  let draft = getToolDraft(project.id)!
  assert.equal(draft.status, 'pending')
  assert.deepEqual(script(), before)
  await assert.rejects(session.execute('commit_document_draft', { draft_id: draft.id, version: draft.version }), /本轮开始前/)

  const continuation = tools()
  await continuation.execute('manage_document_draft', { operation: 'read', draft_id: draft.id })
  for (const forbidden of [{ action: '林晚转身离开。' }, { narration: '旁白变化。' }, { heading: '新场次' }, { duration: 12 }]) {
    await assert.rejects(continuation.execute('manage_document_draft', { operation: 'update', draft_id: draft.id, version: draft.version,
      scene_changes: [{ scene_id: scene.id, base_version: draft.version, changes: forbidden }] }), /对白专项/)
    assert.equal(getToolDraft(project.id)!.version, draft.version)
  }
  await assert.rejects(continuation.execute('manage_document_draft', { operation: 'update', draft_id: draft.id, version: draft.version, scenes: [] }), /不能替换完整分场/)
  await continuation.execute('manage_document_draft', { operation: 'update', draft_id: draft.id, version: draft.version,
    changes: [{ document_id: selected.id, base_version: draft.version, replacements: [{ find: '等我把话说完，再走。', replace: '让我把话说完，你再走。', reason: '顺畅口语节奏' }] }],
    scene_changes: [{ scene_id: scene.id, base_version: draft.version, changes: { dialogue: '林晚：让我把话说完，你再走。' } }] })
  const firstVersion = draft.version
  draft = getToolDraft(project.id)!
  assert.notEqual(draft.version, firstVersion)
  assert.deepEqual(script(), before)
  await assert.rejects(continuation.execute('commit_document_draft', { draft_id: draft.id, version: draft.version }), /本轮开始前/)
  await assert.rejects(tools().execute('commit_document_draft', { draft_id: draft.id, version: draft.version }), /尚未明确批准/)
  await tools({ checkApproval: async () => true }).execute('commit_document_draft', { draft_id: draft.id, version: draft.version })

  const after = script(), changed = after.scenes.find(item => item.id === scene.id)!
  assert.equal(after.artifacts!.find(doc => doc.id === selected.id)!.content, '林晚攥住陈默的衣袖。\n林晚：让我把话说完，你再走。\n末班车的广播响起。')
  assert.equal(changed.dialogue, '林晚：让我把话说完，你再走。')
  for (const key of ['id', 'episode_number', 'position', 'heading', 'location', 'time_of_day', 'characters', 'action', 'narration', 'duration', 'created_at'] as const) assert.equal(changed[key], scene[key], key)
  assert.deepEqual(after.scenes.find(item => item.episode_number === 2), before.scenes.find(item => item.episode_number === 2))
  assert.deepEqual(after.artifacts!.find(doc => doc.episode_number === 2), before.artifacts!.find(doc => doc.episode_number === 2))
  assert.equal(one<{ source_scene_id: string }>('SELECT source_scene_id FROM shots WHERE id=?', 'dialogue-linked-shot')!.source_scene_id, scene.id)
  assert.equal(getToolDraft(project.id), null)
})

test('dialogue continuation rejects a pending patch that already changes non-dialogue scene fields', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected paid or network request') })
  const { project, script, selected, tools } = await fixture(), ordinary = tools({ action: { operation: 'revise', document_ids: [selected.id] } })
  const read = await readDocument(ordinary, selected.id)
  await ordinary.execute('propose_document_patch', patch(read, read.scenes[0]!, { action: '林晚挡住陈默的去路。', dialogue: '林晚：等我把话说完，再走。' }))
  const draft = getToolDraft(project.id)!, before = script(), dialogue = tools()
  await dialogue.execute('manage_document_draft', { operation: 'read', draft_id: draft.id })
  await assert.rejects(dialogue.execute('manage_document_draft', { operation: 'update', draft_id: draft.id, version: draft.version, summary: '冒用对白专项继续' }), /对白以外/)
  await assert.rejects(tools({ checkApproval: async () => true }).execute('commit_document_draft', { draft_id: draft.id, version: draft.version }), /对白以外/)
  assert.equal(getToolDraft(project.id)!.version, draft.version)
  assert.deepEqual(script(), before)
})

test('dialogue action cannot continue or save an existing complete episode regeneration draft', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected paid or network request') })
  const { project, script, selected, tools } = await fixture(), before = script()
  const regeneration = tools({ action: undefined, workflow: 'episode', operation: 'regenerate', taskContract: { intent: 'stage_design', artifact_types: ['episode_script'] } })
  await readDocument(regeneration, selected.id)
  const scene = before.scenes.find(item => item.episode_number === 1)!
  await regeneration.execute('create_document_draft', { stage: 'episode', scope: 'episode', episode_number: 1,
    artifacts: [{ artifact_type: 'episode_script', title: selected.title, content: selected.content }],
    scenes: [{ source_scene_id: scene.id, heading: scene.heading, location: scene.location, time_of_day: scene.time_of_day,
      characters: scene.characters, action: scene.action, dialogue: scene.dialogue, narration: scene.narration, duration: scene.duration }] })
  const draft = getToolDraft(project.id)!, dialogue = tools()
  assert.equal(draft.kind, 'create')
  await dialogue.execute('manage_document_draft', { operation: 'read', draft_id: draft.id })
  await assert.rejects(dialogue.execute('manage_document_draft', { operation: 'update', draft_id: draft.id, version: draft.version, summary: '对白调整' }), /只能继续所选文档的局部修订草稿/)
  await assert.rejects(tools({ checkApproval: async () => true }).execute('commit_document_draft', { draft_id: draft.id, version: draft.version }), /只能继续所选文档的局部修订草稿/)
  assert.deepEqual(script(), before)
})

test('free-text dialogue proposals and continuations cannot smuggle changes to action or narration', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected paid or network request') })
  const { project, script, selected, tools } = await fixture(), before = script(), session = tools()
  const read = await readDocument(session, selected.id)
  for (const content of [selected.content.replace('攥住陈默的衣袖', '追上列车'), selected.content.replace('末班车的广播响起', '陈默突然晕倒')]) {
    const proposal = patch(read, read.scenes[0]!)
    proposal.changes[0]!.replacements = [{ find: selected.content, replace: content.replace('别走。', '等我把话说完，再走。'), reason: '试图在整段台词润色中夹带动作变化' }]
    await assert.rejects(session.execute('propose_document_patch', proposal), /对白范围以外/)
    assert.equal(getToolDraft(project.id), null)
  }
  await session.execute('propose_document_patch', patch(read, read.scenes[0]!))
  const draft = getToolDraft(project.id)!, continuation = tools({ action: undefined })
  await continuation.execute('manage_document_draft', { operation: 'read', draft_id: draft.id })
  await assert.rejects(continuation.execute('manage_document_draft', { operation: 'update', draft_id: draft.id, version: draft.version,
    changes: [{ document_id: selected.id, base_version: draft.version, replacements: [{ find: '林晚攥住陈默的衣袖。', replace: '林晚跳下站台。', reason: '未获授权的动作修改' }] }] }), /对白范围以外/)
  assert.equal(getToolDraft(project.id)!.version, draft.version)
  assert.deepEqual(script(), before)
})

test('successful scope review is reused for unchanged confirmation and invalidated by continued dialogue edits', async () => {
  const { project, selected, tools } = await fixture()
  let reviews = 0
  const validator = async () => { reviews++ }
  const session = tools({ validateDialogueRevision: validator }), read = await readDocument(session, selected.id)
  await session.execute('propose_document_patch', patch(read, read.scenes[0]!))
  let draft = getToolDraft(project.id)!
  assert.equal(reviews, 1)
  assert.equal(draft.revision_kind, 'dialogue')
  const firstReview = draft.dialogue_review!.fingerprint
  const continuation = tools({ validateDialogueRevision: validator })
  await continuation.execute('manage_document_draft', { operation: 'read', draft_id: draft.id })
  await continuation.execute('manage_document_draft', { operation: 'update', draft_id: draft.id, version: draft.version,
    changes: [{ document_id: selected.id, base_version: draft.version, replacements: [{ find: '等我把话说完，再走。', replace: '让我把话说完，你再走。', reason: '保留原意调整表达' }] }],
    scene_changes: [{ scene_id: read.scenes[0]!.id, base_version: draft.version, changes: { dialogue: '林晚：让我把话说完，你再走。' } }] })
  draft = getToolDraft(project.id)!
  assert.equal(reviews, 2)
  assert.notEqual(draft.dialogue_review!.fingerprint, firstReview)
  await tools({ checkApproval: async () => true, validateDialogueRevision: async () => { throw new Error('Unchanged confirmation must reuse review') } })
    .execute('commit_document_draft', { draft_id: draft.id, version: draft.version })
  assert.equal(reviews, 2)
})

test('shared REST commit rejects changed dialogue previews, and an explicit ordinary revision drops the old scope cache', async () => {
  const { project, script, selected, tools } = await fixture(), before = script(), session = tools(), read = await readDocument(session, selected.id)
  await session.execute('propose_document_patch', patch(read, read.scenes[0]!))
  let draft = getToolDraft(project.id)!
  const edited = await call<typeof draft>('PUT', `/api/projects/${project.id}/script/director/tool-drafts/${draft.id}`, { version: draft.version,
    documents: [{ id: selected.id, content: draft.documents[0]!.content.replace('林晚攥住陈默的衣袖。', '林晚挡住陈默的去路。') }] })
  const blocked = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/tool-drafts/${edited.id}/commit`, payload: { version: edited.version, approved: true } })
  assert.equal(blocked.statusCode, 422, blocked.body)
  assert.match(blocked.body, /原范围核对/)
  await assert.rejects(tools({ checkApproval: async () => true }).execute('commit_document_draft', { draft_id: edited.id, version: edited.version }), /对白范围以外/)
  assert.deepEqual(script(), before)

  const ordinary = tools({ action: { operation: 'revise', document_ids: [selected.id] }, validateDialogueRevision: async () => { throw new Error('An ordinary revision must not inherit dialogue-only review') } })
  await ordinary.execute('manage_document_draft', { operation: 'read', draft_id: edited.id })
  await ordinary.execute('manage_document_draft', { operation: 'update', draft_id: edited.id, version: edited.version,
    scene_changes: [{ scene_id: read.scenes[0]!.id, base_version: edited.version, changes: { action: '林晚挡住陈默的去路。' } }] })
  draft = getToolDraft(project.id)!
  assert.equal(draft.revision_kind, undefined)
  assert.equal(draft.dialogue_review, undefined)
  await call('POST', `/api/projects/${project.id}/script/director/tool-drafts/${draft.id}/commit`, { version: draft.version, approved: true })
  assert.match(script().artifacts!.find(doc => doc.id === selected.id)!.content, /挡住陈默的去路/)
})

test('unavailable, cancelled or stale-source scope review never persists a new dialogue draft', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected paid or network request') })
  const unavailable = await fixture(), unavailableTools = unavailable.tools({ validateDialogueRevision: undefined })
  const unread = await readDocument(unavailableTools, unavailable.selected.id)
  await assert.rejects(unavailableTools.execute('propose_document_patch', patch(unread, unread.scenes[0]!)), /无法确认对白专项/)
  assert.equal(getToolDraft(unavailable.project.id), null)
  for (const mode of ['cancel', 'source_changed'] as const) {
    const { project, selected, tools } = await fixture(), controller = new AbortController()
    const session = tools({ signal: controller.signal, validateDialogueRevision: async () => {
      if (mode === 'cancel') controller.abort()
      else run('UPDATE script_artifacts SET content=? WHERE id=?', selected.content + '\n其他窗口新增的原文。', selected.id)
    } }), read = await readDocument(session, selected.id)
    await assert.rejects(session.execute('propose_document_patch', patch(read, read.scenes[0]!)), mode === 'cancel' ? /abort/i : /原文或分场版本已变化/)
    assert.equal(getToolDraft(project.id), null)
    if (mode === 'source_changed') assert.match(one<{ content: string }>('SELECT content FROM script_artifacts WHERE id=?', selected.id)!.content, /其他窗口新增/)
  }
})

test('legacy unreviewed text patches must pass whole-difference scope review before dialogue confirmation', async () => {
  const { project, script, selected, tools } = await fixture(), before = script()
  const ordinary = tools({ action: { operation: 'revise', document_ids: [selected.id] } }), read = await readDocument(ordinary, selected.id)
  const proposal = patch(read, read.scenes[0]!)
  proposal.changes[0]!.replacements = [{ find: selected.content, replace: selected.content.replace('别走。', '等我把话说完，再走。').replace('广播响起', '大火蔓延'), reason: '普通修订包含剧情变化' }]
  await ordinary.execute('propose_document_patch', proposal)
  const draft = getToolDraft(project.id)!
  assert.equal(draft.dialogue_review, undefined)
  await assert.rejects(tools({ checkApproval: async () => true }).execute('commit_document_draft', { draft_id: draft.id, version: draft.version }), /对白范围以外/)
  assert.deepEqual(script(), before)
})

test('native dialogue proposals independently review scope and retry an identical input after a temporary review failure', async t => {
  const { project, script, selected, action } = await fixture()
  let nativeRounds = 0, boundaryRequests = 0
  let proposed: ReturnType<typeof patch> | undefined
  const response = (content: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] })
  const tool = (name: string, args: unknown) => Response.json({ choices: [{ message: { content: '', tool_calls: [{ id: `native-${nativeRounds}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    if (!body.tools) {
      boundaryRequests++
      assert.match(body.messages[0].content, /独立的对白专项边界核对员/)
      if (boundaryRequests === 1) return Response.json({ error: { code: 'invalid_request', message: '测试一次临时核对失败' } }, { status: 400 })
      return response({ verdict: 'allowed', explanation: '只调整挽留台词，其他内容逐字保持。',
        changes: [{ before: { quote: '别走。', occurrence: 0 }, after: { quote: '等我把话说完，再走。', occurrence: 0 } }] })
    }
    nativeRounds++
    if (nativeRounds === 1) return tool('load_creation_skills', { stage: 'script' })
    if (nativeRounds === 2) return tool('read_documents', { document_ids: [selected.id] })
    if (nativeRounds === 3) {
      const last = body.messages.filter((item: { role: string }) => item.role === 'tool').at(-1)
      const document = JSON.parse(last.content).result.documents[0]
      proposed = patch(document, document.scenes[0])
      return tool('propose_document_patch', proposed)
    }
    if (nativeRounds === 4) return tool('propose_document_patch', proposed)
    return response('对白草稿供预览。')
  })
  const result = await runScriptTools({ project, script, action, stage: directorStageContext(script(), { explicit: { stage: 'episode', episode_number: 1 } }),
    skillSelections: { script: [] }, messages: [{ role: 'user', text: '只改对白，保留原意。' }], prompt: '只改所选文档台词，保留其他正文。',
    model: { id: 'dialogue-test', remote_id: 'fixture', modality: 'text', protocol: 'chat_completions', settings: { stream: false, request_path: 'chat/completions',
      structured_output_mode: 'prompt', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } },
    provider: { adapter: 'http', base_url: 'https://fixture.invalid/v1', auth_header: 'X-Test-Key', auth_prefix: '' }, resolveKey: () => '', checkApproval: async () => false, onEvent: () => {} })
  assert.ok(result.tool_draft?.dialogue_review)
  assert.equal(boundaryRequests, 3, 'a temporary failure is evicted before retry, then document and structured dialogue are protected')
  assert.equal(nativeRounds, 5)
})
