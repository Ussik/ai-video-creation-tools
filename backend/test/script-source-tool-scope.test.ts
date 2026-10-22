import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Project } from '../src/infrastructure/database/db.js'

const directory = await mkdtemp(join(tmpdir(), 'studio-source-tool-scope-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, one, run, newId, now } = await import('../src/infrastructure/database/db.js')
const { documentTools } = await import('../src/modules/script/script-document-tools.js')
const { directorStageContext } = await import('../src/modules/script/script-workflow.js')
const { effectiveScriptSource, scriptDocumentVersion } = await import('../src/modules/script/script-source-versions.js')
initDb()
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

function fixture(content: string | null = '林晚进入旧车站。赵师傅：先关电源。') {
  const id = newId(), timestamp = now()
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, '版本绑定原文工具', timestamp, timestamp)
  const project = one<Project>('SELECT * FROM projects WHERE id=?', id)!
  const script = () => ({ outline: '', characters: '', artifacts: [], scenes: [], generation_options: {} })
  const write = (next: string) => run(`INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`, id, '原稿.md', next, new Date(Date.now() + 1000).toISOString())
  if (content !== null) write(content)
  const makeTools = (targeted = false) => documentTools({ project, script, stage: directorStageContext(script()),
    messages: [{ role: 'user', text: '“赵师傅”在哪一集出现过？' }], checkApproval: async () => false, onEvent: () => {},
    ...(targeted ? { sourceContextMode: 'targeted' as const } : {}) })
  return { id, write, makeTools }
}

test('source tools pin the session version even when the model omits the version argument', async () => {
  const fixtureValue = fixture(), tools = fixtureValue.makeTools()
  const version = scriptDocumentVersion(effectiveScriptSource(fixtureValue.id)!)
  const read = await tools.execute('read_source_document', { offset: 0, length: 2 }) as { source_version: string; content: string }
  assert.equal(read.source_version, version)
  assert.equal(read.content, '林晚')
  await assert.rejects(tools.execute('search_source_document', { query: '赵师傅', source_version: 'f'.repeat(64) }), { statusCode: 409 })
  fixtureValue.write('新正文在相同位置使用了不同人物。')
  for (const [name, args] of [
    ['read_source_document', { offset: 0 }], ['search_source_document', { query: '赵师傅' }],
    ['read_full_source_document', { reason: '补读全剧核实' }],
  ] as const) await assert.rejects(tools.execute(name, args), { statusCode: 409 })
  assert.throws(tools.assertSourceUnchanged, { statusCode: 409 })
  const fresh = fixtureValue.makeTools()
  assert.notEqual((await fresh.execute('read_source_document', { offset: 0 }) as { source_version: string }).source_version, version)
})

test('adding or removing a manuscript cannot silently change the source of an existing session', async () => {
  const absent = fixture(null), beforeUpload = absent.makeTools(true)
  absent.write('赵师傅：这是新上传的剧本。')
  await assert.rejects(beforeUpload.execute('search_source_document', { query: '赵师傅' }), { statusCode: 409 })
  const loaded = fixture(), beforeRemoval = loaded.makeTools()
  run('DELETE FROM script_source_documents WHERE project_id=?', loaded.id)
  await assert.rejects(beforeRemoval.execute('read_source_document', { offset: 0 }), { statusCode: 409 })
})

test('native source tools relay complete search pagination and exact same-version reads', async () => {
  const content = Array.from({ length: 25 }, (_, index) => `第${index + 1}集：赵师傅检修设备。\n`).join('')
  const value = fixture(content), tools = value.makeTools(true), offsets: number[] = []
  let cursor: string | null | undefined, sourceVersion: string | undefined
  do {
    const page = await tools.execute('search_source_document', { query: '赵师傅', limit: 8, ...(cursor ? { cursor } : {}),
      ...(sourceVersion ? { source_version: sourceVersion } : {}) }) as {
        source_version: string; total_matches: number; truncated: boolean; next_cursor: string | null;
        matches: Array<{ match_offset: number; match_length: number }>
      }
    assert.equal(page.total_matches, 25)
    sourceVersion ??= page.source_version
    assert.equal(page.source_version, sourceVersion)
    for (const match of page.matches) {
      offsets.push(match.match_offset)
      const read = await tools.execute('read_source_document', { source_version: page.source_version, offset: match.match_offset, length: match.match_length }) as {
        content: string; source_version: string; complete_source: boolean
      }
      assert.equal(read.content, '赵师傅')
      assert.equal(read.source_version, sourceVersion)
      assert.equal(read.complete_source, false)
    }
    assert.equal(page.truncated, page.next_cursor !== null)
    cursor = page.next_cursor
  } while (cursor)
  assert.equal(offsets.length, 25)
  assert.equal(new Set(offsets).size, 25)
  const missing = await tools.execute('search_source_document', { query: '未出现的姓名' }) as { total_matches: number; truncated: boolean; next_cursor: string | null }
  assert.equal(missing.total_matches, 0)
  assert.equal(missing.truncated, false)
  assert.equal(missing.next_cursor, null)
})

test('local sessions reject mutation tools and can explicitly expand to the entire pinned manuscript', async () => {
  const content = '开头。赵师傅走进车间。末集揭示了工具来源。', value = fixture(content), tools = value.makeTools(true)
  for (const name of ['record_story_decision', 'create_document_draft', 'propose_document_patch', 'propose_visual_profile_draft', 'commit_document_draft', 'submit_document_review']) {
    await assert.rejects(tools.execute(name, {}), /本轮仅查询剧本原文/)
  }
  const full = await tools.execute('read_full_source_document', { reason: '局部段落不能确定远处指代，补读全稿' }) as {
    content: string; complete_source: boolean; source_version: string; source_kind: string
  }
  assert.equal(full.content, content)
  assert.equal(full.complete_source, true)
  assert.equal(full.source_kind, 'effective')
  assert.equal(full.source_version, scriptDocumentVersion(effectiveScriptSource(value.id)!))
  assert.equal(one<{ count: number }>('SELECT count(*) AS count FROM script_tool_drafts WHERE project_id=?', value.id)!.count, 0)
  assert.equal(one<{ count: number }>('SELECT count(*) AS count FROM script_story_decisions WHERE project_id=?', value.id)!.count, 0)
})
