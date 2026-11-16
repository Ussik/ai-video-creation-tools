import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const directory = await mkdtemp(join(tmpdir(), 'source-ordinary-entry-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, now, newId } = await import('../src/infrastructure/database/db.js')
const { createScriptSourceAnalyzer, scriptSourceAnalysis } = await import('../src/modules/script/script-source-analysis.js')
const { sourceAnalysisConfigurationHash } = await import('../src/modules/script/script-source-revision-reuse.js')
const { scriptSourceVersion } = await import('../src/modules/script/script-source-identity.js')
const { sourceAnalysisPipelineVersion } = await import('../src/modules/script/script-source-map.js')
initDb()
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
const configuration = { fixture: 'ordinary-config' }
function fixture() {
  const id = newId(), stamp = now(), content = '林舟归还钥匙。', source = { filename: 'story.txt', content }
  db.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run(id, 'grant entry', stamp, stamp)
  db.prepare('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)').run(id, source.filename, content, stamp)
  const state = { id: newId(), source_version: scriptSourceVersion(source), model_id: 'fixture', configuration_hash: sourceAnalysisConfigurationHash(configuration),
    status: 'failed', phase: 'synthesis', completed_chunks: 1, total_chunks: 1, pipeline_version: sourceAnalysisPipelineVersion,
    error: '其他任务保留专属许可', updated_at: stamp, sections: [{ title: '第一章', offset: 0, length: content.length,
      summary: '林舟归还钥匙。', characters: [], events: [{ summary: content, evidence: { offset: 0, quote: content } }] }],
    ordinary_story_dispatch: { run_id: 'old-run', binding: 'must-not-inherit', work_hash: 'work', protected_task_keys: [], authorized_at: stamp },
    story_work: { input_hash: 'work', tasks: [{ key: 'completed:0', result: { preserved: true } },
      { key: 'characters_merge:new', failure: { code: 'source_request_sibling_pending', message: 'not sent' },
        output_candidate: { context_hash: 'candidate', checkpoint: {} } }] } }
  db.prepare('INSERT INTO script_source_analyses (project_id,id,source_version,status,snapshot,updated_at) VALUES (?,?,?,?,?,?)').run(id, state.id, state.source_version, state.status, JSON.stringify(state), stamp)
  return { id, stamp, state }
}
test('ordinary explicit start persists a current-run grant before queuing; automatic starts do not inherit it', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('entry test must not use network'))
  for (const explicitDispatch of [false, true]) {
    const original = fixture()
    const analyzer = createScriptSourceAnalyzer(async () => assert.fail('close before queue pump'), undefined, { configuration: () => configuration })
    const queued = analyzer.start(original.id, 'fixture', { sourceUpdatedAt: original.stamp, explicitDispatch })
    // close() freezes the worker synchronously, before the queued microtask.
    await analyzer.close()
    const stored = scriptSourceAnalysis(original.id)!
    assert.equal(stored.status, 'queued')
    assert.notEqual(stored.id, original.state.id)
    assert.deepEqual(stored.story_work, original.state.story_work)
    if (explicitDispatch) {
      assert.equal(queued.ordinary_story_dispatch?.run_id, stored.id)
      assert.deepEqual(stored.ordinary_story_dispatch, queued.ordinary_story_dispatch)
      assert.notEqual(stored.ordinary_story_dispatch?.binding, 'must-not-inherit')
      assert.deepEqual(stored.ordinary_story_dispatch?.protected_task_keys, ['completed:0'])
    } else assert.equal(stored.ordinary_story_dispatch, undefined)
  }
})
