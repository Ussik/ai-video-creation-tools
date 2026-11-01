import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'

const directory = await mkdtemp(join(tmpdir(), 'candidate-preview-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, one, run, now, newId } = await import('../src/infrastructure/database/db.js')
const { retainScriptDraft, pendingScriptDraft, claimScriptDraft, updateScriptDraftRun } = await import('../src/modules/script/script-draft-resolution.js')
const { workflowGenerationDraftSchema } = await import('../src/modules/script/script-workflow.js')
assert.equal(db.name, join(directory, 'studio.db'), 'candidate previews must use a temporary isolated database')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function fixture(t: TestContext, withSourceUpdate = true) {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('preview must never contact a model') })
  const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '候选稿只读预览' } })
  assert.equal(created.statusCode, 200, created.body)
  const project = created.json(), stamp = now()
  const original = '原稿明确十七集，林晚最终归还钥匙。'
  const formal = '已经保存的历史大纲完整保留。'
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', project.id, 'original.md', original, stamp)
  run(`INSERT INTO script_artifacts (id,project_id,artifact_type,title,content,position,status,created_at,updated_at,episode_number)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, newId(), project.id, 'outline', '历史大纲', formal, 0, 'ready', stamp, stamp, 0)
  const draft = workflowGenerationDraftSchema.parse({ stage: 'outline', episode_number: 0, scenes: [],
    artifacts: scriptStageArtifacts.outline.map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type],
      content: `${scriptArtifactLabels[artifact_type]}候选全文：林晚使用钥匙会失去当天记忆，结局归还钥匙。\n尾段及换行完整保留。` })) })
  const sourceUpdate = { id: newId(), base_version: 'source-before', original_content: original,
    content: original + '钥匙代价：失去当天记忆。', replacements: [{ find: original, replace: original + '钥匙代价：失去当天记忆。', reason: '预览修订，尚未保存' }] }
  const candidate = retainScriptDraft(project.id, { draft,
    findings: [{ source_key: 'world', kind: 'contradiction', quote: '钥匙', explanation: '尚待完整审读', suggestion: '核对跨文档一致性' }],
    source_version: 'source-binding', ...(withSourceUpdate ? { source_update: sourceUpdate } : {}),
    request: { model_id: 'preview-must-not-load-this-model', messages: [{ role: 'user', text: '仅供后台恢复的创作要求。' }] } })
  const url = (id = candidate.id, version = candidate.version) => `/api/projects/${project.id}/script/director/resolutions/${id}?version=${encodeURIComponent(version)}`
  const stored = () => ({
    candidate: one<{ payload: string }>('SELECT payload FROM script_draft_resolutions WHERE project_id=?', project.id)!.payload,
    source: one<{ content: string }>('SELECT content FROM script_source_documents WHERE project_id=?', project.id)!.content,
    formal: one<{ content: string }>("SELECT content FROM script_artifacts WHERE project_id=? AND artifact_type='outline'", project.id)!.content,
    changes: one<{ n: number }>('SELECT total_changes() AS n')!.n,
  })
  return { project, candidate, draft, sourceUpdate, original, formal, url, stored, requests: () => requests }
}

test('candidate preview returns exact unsaved documents and source revision without model calls or formal writes', async t => {
  const f = await fixture(t), before = f.stored()
  const result = await app.inject({ method: 'GET', url: f.url() })
  assert.equal(result.statusCode, 200, result.body)
  assert.deepEqual(result.json(), { id: f.candidate.id, version: f.candidate.version, draft: f.draft, source_update: f.sourceUpdate })
  assert.deepEqual(f.stored(), before, 'a preview must not alter the candidate, manuscript, formal documents or any database state')
  assert.equal(f.requests(), 0)
})

test('candidate without source revision omits source_update and never exposes private recovery metadata', async t => {
  const f = await fixture(t, false), before = f.stored()
  const result = await app.inject({ method: 'GET', url: f.url() })
  assert.equal(result.statusCode, 200, result.body)
  assert.deepEqual(result.json(), { id: f.candidate.id, version: f.candidate.version, draft: f.draft })
  assert.deepEqual(f.stored(), before)
  assert.equal(f.requests(), 0)
})

test('missing candidate and cross-project candidate ids return 404; changed candidate versions return 409', async t => {
  const f = await fixture(t), before = f.stored()
  const unknown = await app.inject({ method: 'GET', url: f.url('missing-candidate') })
  assert.equal(unknown.statusCode, 404, unknown.body)
  const stale = await app.inject({ method: 'GET', url: f.url(f.candidate.id, 'outdated-version') })
  assert.equal(stale.statusCode, 409, stale.body)
  const created = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '其他项目' } })
  const foreign = await app.inject({ method: 'GET', url: `/api/projects/${created.json().id}/script/director/resolutions/${f.candidate.id}?version=${f.candidate.version}` })
  assert.equal(foreign.statusCode, 404, foreign.body)
  // The intentional second-project fixture is the only write in this case.
  assert.equal(f.stored().candidate, before.candidate)
  assert.equal(f.stored().source, f.original)
  assert.equal(f.stored().formal, f.formal)
  assert.equal(f.requests(), 0)
})

test('a busy repair remains previewable without releasing its claim, advancing progress or saving candidate text', async t => {
  const f = await fixture(t)
  updateScriptDraftRun(f.project.id, f.candidate, { strategy: 'ai', answers: ['沿用已授权具体决定。'], status: 'running', completed: 0, total: 1,
    review_messages: [{ role: 'user', text: '不应通过预览返回的后台恢复记录。' }] })
  const claimed = claimScriptDraft(f.project.id, { id: f.candidate.id, version: f.candidate.version, strategy: 'ai' }, 'source-binding')
  try {
    const before = f.stored()
    const result = await app.inject({ method: 'GET', url: f.url() })
    assert.equal(result.statusCode, 200, result.body)
    assert.deepEqual(result.json(), { id: f.candidate.id, version: f.candidate.version, draft: f.draft, source_update: f.sourceUpdate })
    assert.deepEqual(f.stored(), before)
    assert.equal(pendingScriptDraft(f.project.id)!.run!.status, 'running')
    assert.throws(() => claimScriptDraft(f.project.id, { id: f.candidate.id, version: f.candidate.version, strategy: 'ai' }, 'source-binding'), /正在补齐/)
    assert.equal(f.requests(), 0)
  } finally { claimed.release() }
})
