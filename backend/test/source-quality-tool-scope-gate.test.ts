import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import type { Project, ScriptArtifact, ScriptScene } from '../src/infrastructure/database/db.js'
import type { ScriptSnapshot, ScriptToolDraft } from '../src/modules/script/script-document-tools.js'
import { scriptStageArtifacts, scriptArtifactLabels } from '@video-studio/shared/script/script-stage-content'

const directory = await mkdtemp(join(tmpdir(), 'source-quality-tool-gate-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, now, newId, all } = await import('../src/infrastructure/database/db.js')
const { documentTools, getToolDraft, commitToolDraft } = await import('../src/modules/script/script-document-tools.js')
const { directorStageContext } = await import('../src/modules/script/script-workflow.js')
const { scriptSourceDocument } = await import('../src/modules/script/script-source-documents.js')
const { sourceQualityInputHash } = await import('../src/modules/script/script-source-quality.js')
const { assertSourceQualityCreationAccess } = await import('../src/modules/script/script-source-quality-gate.js')
const { scriptSourceVersion } = await import('../src/modules/script/script-source-identity.js')
const { sourceAnalysisPipelineVersion } = await import('../src/modules/script/script-source-map.js')
const { initSkills } = await import('../src/modules/skills/skills.js')
initDb()
initSkills()
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

function fixture(level: 'blocking' | 'scoped' | 'advisory' = 'scoped') {
  const id = newId(), stamp = now(), content = '第一集\n旅人归乡。\n第二集\n旧钟的来历尚未说明。'
  const split = content.indexOf('第二集'), document = { project_id: id, filename: 'quality.txt', content, updated_at: stamp }
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, 'tool quality gate', stamp, stamp)
  db.prepare('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)').run(id, document.filename, content, stamp)
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(id) as Project
  const state: ScriptSourceAnalysis = { id: newId(), source_version: scriptSourceVersion(document), model_id: 'fixture', status: 'ready', phase: 'ready',
    pipeline_version: sourceAnalysisPipelineVersion, completed_chunks: 1, total_chunks: 1, completed_characters: content.length, error: null, updated_at: stamp,
    sections: [{ offset: 0, length: split, title: '第一集', episode_number: 1, summary: '旅人归乡。', characters: [], events: [] },
      { offset: split, length: content.length - split, title: '第二集', episode_number: 2, summary: '旧钟来历未明。', characters: [], events: [] }],
    story: { summary: '旅人归乡，旧钟的来历没有说明。', characters: [], timeline: [], threads: [], ending: { summary: '尚未给出结局。', section_ids: [1] },
      uncertainties: [{ description: '旧钟的来历没有说明。', section_ids: [1] }] } }
  state.quality = { input_hash: sourceQualityInputHash(state), status: 'issues', findings: [{ kind: level === 'blocking' ? 'unsupported' : 'omission', explanation: '核对旧钟资料的依据与影响。', unit_ids: [2],
    assessment: { issue_type: level === 'blocking' ? 'unsupported_fact' : 'open_question', analysis_paths: ['story.uncertainties[0].description'], proposition: '旧钟来历没有说明',
      impact: { level, section_ids: level === 'scoped' ? [1] : [], reason: '仅在继续使用旧钟来历时需要确认。' } } }] }
  const save = () => db.prepare('INSERT OR REPLACE INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, state.id, state.source_version, state.status, JSON.stringify(state), state.updated_at)
  save()
  const script = (): ScriptSnapshot => ({ outline: '', characters: '', generation_options: {},
    artifacts: all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=? ORDER BY position', id),
    scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position', id) })
  let paid = 0
  const tools = (extra: Partial<Parameters<typeof documentTools>[0]> = {}) => documentTools({ project, script,
    stage: directorStageContext(script()), messages: [{ role: 'user', text: '修改指定文档并保存' }], onEvent: () => {},
    authorizeCreation: async () => { paid++; return true }, validateCreation: async () => { paid++ },
    checkApproval: async () => { paid++; return true }, ...extra })
  const artifact = (episode: number, artifact_type = 'episode_script') => {
    const aid = newId()
    db.prepare("INSERT INTO script_artifacts (id,project_id,artifact_type,episode_number,title,content,position,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'ready',?,?)")
      .run(aid, id, artifact_type, episode, `${artifact_type}:${episode}`, '旅人归乡。', episode, stamp, stamp)
    return aid
  }
  return { id, state, save, script, tools, artifact, paid: () => paid }
}
const blocked = { code: 'source_quality_creation_blocked', delivery: 'not_sent', retryable: false }
async function patch(tools: ReturnType<typeof documentTools>, id: string, replacement = '旅人携信归乡。') {
  const read = await tools.execute('read_documents', { document_ids: [id] }) as { documents: Array<{ id: string; version: string }> }
  return tools.execute('propose_document_patch', { summary: '补充归乡细节', changes: [{ document_id: id, base_version: read.documents[0]!.version,
    replacements: [{ find: '旅人归乡。', replace: replacement, reason: '明确动作' }] }] })
}

test('optional source audit does not gate authorized creation; model cannot self-declare a contract', async () => {
  const f = fixture('blocking'), tools = f.tools()
  const args = { stage: 'outline', episode_number: 0, artifacts: scriptStageArtifacts.outline.map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type], content: '旅人归乡。' })), scenes: [] }
  await assert.rejects(tools.execute('create_document_draft', { ...args, intent: 'source_outline' }), /尚未明确分项成果范围/)
  await tools.execute('create_document_draft', args)
  assert.ok(getToolDraft(f.id)); assert.ok(f.paid() > 0)
  assert.equal(f.script().artifacts!.length, 0, 'creation remains a preview until explicit save')
})

test('server-selected source outline remains available for faithful source summarization', async () => {
  const f = fixture('blocking')
  const tools = f.tools({ workflow: 'outline', stage: directorStageContext(f.script(), { explicit: { stage: 'outline', episode_number: 0 } }),
    taskContract: { intent: 'source_outline', artifact_types: ['outline'] } })
  await tools.execute('create_document_draft', { stage: 'outline', episode_number: 0, artifacts: [{ artifact_type: 'outline', title: '原稿大纲', content: '旅人归乡，旧钟来历尚未说明。' }], scenes: [] })
  assert.equal(getToolDraft(f.id)?.workflow?.intent, 'source_outline')
})

test('optional audit findings do not lock related or mixed episode patch drafts; saved state stays unchanged', async () => {
  const f = fixture(), ids = [f.artifact(1), f.artifact(2), f.artifact(0, 'characters')]
  const tools = f.tools(), read = await tools.execute('read_documents', { document_ids: ids }) as { documents: Array<{ id: string; version: string }> }
  await tools.execute('propose_document_patch', { summary: '明确动作', changes: read.documents.map(doc => ({ document_id: doc.id, base_version: doc.version,
    replacements: [{ find: '旅人归乡。', replace: '旅人携信归乡。', reason: '明确动作' }] })) })
  assert.equal(getToolDraft(f.id)!.documents.length, 3)
  assert.ok(f.script().artifacts!.every(doc => doc.content === '旅人归乡。'))
  assert.equal(f.paid(), 0)
})

test('explicit commit keeps version and creator approval checks but does not require a passed optional audit', async () => {
  const f = fixture('advisory'), episode2 = f.artifact(2)
  await patch(f.tools(), episode2)
  const read = getToolDraft(f.id)!
  f.state.quality!.findings[0]!.assessment!.impact = { level: 'scoped', section_ids: [1], reason: '涉及第二集' }; f.save()
  assert.throws(() => commitToolDraft(f.id, read.id, 'wrong-version', f.script), /变化/)
  const tools = f.tools()
  await tools.execute('commit_document_draft', { draft_id: read.id, version: read.version })
  assert.equal(f.script().artifacts![0]!.content, '旅人携信归乡。')
  assert.ok(f.paid() > 0); assert.equal(f.state.quality!.status, 'issues')
})

test('extracted public material ignores historical review gates while legacy guards retain their contract', () => {
  const f = fixture('advisory')
  f.state.story!.summary = '内容变化，旧核对已过期。'; f.state.status = 'failed'; f.save()
  const source = scriptSourceDocument(f.id)!
  assert.equal(source.analysis!.analysis_mode, 'extract')
  assert.equal(source.analysis!.quality_summary, undefined)
  assert.doesNotThrow(() => assertSourceQualityCreationAccess(source, { stage: 'episode', episode_number: 1 }))
  delete f.state.quality; f.state.status = 'queued'; f.save()
  assert.doesNotThrow(() => assertSourceQualityCreationAccess(scriptSourceDocument(f.id), { stage: 'outline' }))
  f.state.status = 'ready'; f.save()
  assert.throws(() => assertSourceQualityCreationAccess({ ...source, analysis: f.state }, { stage: 'outline' }), blocked)
})
