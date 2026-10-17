import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Project, ScriptArtifact, ScriptScene } from '../src/infrastructure/database/db.js'
import type { ScriptSnapshot } from '../src/modules/script/script-document-tools.js'
import type { ScriptIntent } from '../src/modules/script/script-intent.js'

const directory = await mkdtemp(join(tmpdir(), 'intent-visual-style-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, all, one, run, newId, now } = await import('../src/infrastructure/database/db.js')
const { syncIntentVisualStyle } = await import('../src/modules/script/script-intent-visual-style.js')
const { activityRecorder, scriptActivitiesSchema } = await import('../src/modules/script/script-activity.js')
const { projectVisualStyle } = await import('../src/modules/visuals/project-visual-style.js')
initDb()
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

const creatorText = '画风改为日漫二维动画，采用赛璐璐，不要真人摄影。'
const stylePatch = { visual_style: '日漫二维动画', visual_style_details: { medium: '二维绘制', rendering: '赛璐璐', exclusions: ['真人摄影'] },
  genre: '不应保存的客户端题材', episode_count: 99 }
function intent(source: { message_index: number; quote: string } | undefined = { message_index: 0, quote: creatorText }): ScriptIntent {
  return { action: 'discuss', settings_patch: stylePatch, ...(source ? { visual_style_source: source } : {}) } as ScriptIntent
}
function fixture(settings: Record<string, unknown> = { genre: '悬疑', episode_count: 12, episode_duration: 90,
  visual_style: '水彩', visual_style_details: { palette: '暖灰' } }) {
  const timestamp = now()
  const project: Project = { id: newId(), name: '意图画风同步', brief: '保留原故事', ratio: '16:9', music_asset_id: null, created_at: timestamp, updated_at: timestamp }
  run('INSERT INTO projects (id,name,brief,ratio,created_at,updated_at) VALUES (?,?,?,?,?,?)', project.id, project.name, project.brief, project.ratio, timestamp, timestamp)
  run('INSERT INTO scripts (project_id,outline,characters,generation_options,updated_at) VALUES (?,?,?,?,?)', project.id, '已保存大纲', '已保存人物', JSON.stringify(settings), timestamp)
  run("INSERT INTO script_artifacts (id,project_id,artifact_type,episode_number,title,content,position,status,created_at,updated_at) VALUES (?,?,'outline',0,'原大纲','完整原文',0,'ready',?,?)", newId(), project.id, timestamp, timestamp)
  run('INSERT INTO script_source_documents (project_id,filename,content,updated_at) VALUES (?,?,?,?)', project.id, '原剧本.txt', '必须保留的上传原文', timestamp)
  const script = (): ScriptSnapshot => {
    const row = one<{ outline: string; characters: string; generation_options: string }>('SELECT * FROM scripts WHERE project_id=?', project.id)!
    return { outline: row.outline, characters: row.characters, generation_options: JSON.parse(row.generation_options),
      artifacts: all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=?', project.id), scenes: all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=?', project.id) }
  }
  const events: Record<string, unknown>[] = []
  const onEvent = (event: Record<string, unknown>) => { events.push(structuredClone(event)) }
  const activity = activityRecorder(onEvent)
  const options = { project, script, messages: [{ role: 'user' as const, text: creatorText }], intent: intent(),
    expectedVersion: projectVisualStyle(project.id).version, onEvent, activity }
  return { project, script, events, activity, options }
}
function documents(projectId: string) {
  return {
    artifacts: all('SELECT * FROM script_artifacts WHERE project_id=?', projectId),
    scenes: all('SELECT * FROM script_scenes WHERE project_id=?', projectId),
    source: one('SELECT * FROM script_source_documents WHERE project_id=?', projectId),
    shots: all('SELECT * FROM shots WHERE project_id=?', projectId),
    jobs: all('SELECT * FROM jobs WHERE project_id=?', projectId),
    drafts: all('SELECT * FROM script_tool_drafts WHERE project_id=?', projectId),
  }
}

test('current creator evidence saves style through the native tool, reports its result and preserves other work', async () => {
  const f = fixture(), before = documents(f.project.id), original = f.script()
  const result = await syncIntentVisualStyle(f.options)
  assert.deepEqual(result, { changed: true, generation_options: { genre: '悬疑', episode_count: 12, episode_duration: 90,
    visual_style: stylePatch.visual_style, visual_style_details: stylePatch.visual_style_details } })
  assert.deepEqual(f.script().generation_options, result!.generation_options)
  assert.equal(f.script().outline, original.outline)
  assert.equal(f.script().characters, original.characters)
  assert.deepEqual(documents(f.project.id), before)
  const decision = one<{ basis: string; source_text: string; content: string }>('SELECT * FROM script_story_decisions WHERE project_id=?', f.project.id)!
  assert.equal(decision.basis, 'creator_confirmed')
  assert.equal(decision.source_text, creatorText)
  assert.deepEqual(JSON.parse(decision.content), { name: stylePatch.visual_style, ...stylePatch.visual_style_details })
  assert.equal(f.activity.entries.length, 1)
  assert.equal(f.activity.entries[0]!.name, 'set_project_visual_style')
  assert.equal(f.activity.entries[0]!.status, 'succeeded')
  assert.equal(JSON.parse(f.activity.entries[0]!.output!).saved, true)
  scriptActivitiesSchema.parse(f.activity.entries)
  assert.ok(f.events.every(event => event.type === 'activity'), 'caller merges and publishes the final intent settings')
})

test('missing, forged, assistant and older creator provenance leave persistence to the existing tool conversation', async () => {
  const cases: Array<{ messages?: Parameters<typeof syncIntentVisualStyle>[0]['messages']; intent: ScriptIntent }> = [
    { intent: { action: 'discuss', settings_patch: stylePatch } },
    { intent: intent({ message_index: 0, quote: '用户未说过的画风' }) },
    { intent: intent({ message_index: 0, quote: '   ' }) },
    { intent: intent({ message_index: 4, quote: creatorText }) },
    { intent: intent({ message_index: -1, quote: creatorText }) },
    { intent: intent({ message_index: 0.5, quote: creatorText }) },
    { messages: [{ role: 'assistant', text: creatorText }, { role: 'user', text: '先讨论故事' }], intent: intent() },
    { messages: [{ role: 'user', text: creatorText }, { role: 'assistant', text: '好的' }, { role: 'user', text: '后来改成水彩风' }], intent: intent() },
    { intent: { ...intent(), settings_patch: { visual_style: '   ' } } },
    { intent: { ...intent(), settings_patch: { visual_style_details: stylePatch.visual_style_details } } },
  ]
  for (const item of cases) {
    const f = fixture(), before = f.script(), priorDocuments = documents(f.project.id)
    const result = await syncIntentVisualStyle({ ...f.options, ...item })
    assert.equal(result, undefined)
    assert.deepEqual(f.script(), before)
    assert.deepEqual(documents(f.project.id), priorDocuments)
    assert.equal(all('SELECT * FROM script_story_decisions WHERE project_id=?', f.project.id).length, 0)
    assert.deepEqual(f.activity.entries, [])
    assert.deepEqual(f.events, [])
  }
})

test('a pre-intent version cannot overwrite a concurrently saved style', async () => {
  const f = fixture()
  run('UPDATE scripts SET generation_options=? WHERE project_id=?', JSON.stringify({ genre: '悬疑', visual_style: '并发确认的三维动画' }), f.project.id)
  const before = f.script()
  await assert.rejects(syncIntentVisualStyle(f.options), (error: unknown) => {
    assert.equal((error as { statusCode: number }).statusCode, 409)
    return true
  })
  assert.deepEqual(f.script(), before)
  assert.equal(all('SELECT * FROM script_story_decisions WHERE project_id=?', f.project.id).length, 0)
  assert.equal(f.activity.entries[0]!.status, 'failed')
})

test('cancellation before execution or from the activity callback never writes style', async () => {
  for (const cancelOnActivity of [false, true]) {
    const f = fixture(), controller = new AbortController(), before = f.script()
    const activity = activityRecorder(event => { if (cancelOnActivity && event.type === 'activity') controller.abort(new Error('已取消')) })
    if (!cancelOnActivity) controller.abort(new Error('已取消'))
    await assert.rejects(syncIntentVisualStyle({ ...f.options, activity, signal: controller.signal }), /已取消/)
    assert.deepEqual(f.script(), before)
    assert.equal(all('SELECT * FROM script_story_decisions WHERE project_id=?', f.project.id).length, 0)
    assert.equal(activity.entries.length, cancelOnActivity ? 1 : 0)
    if (cancelOnActivity) assert.equal(activity.entries[0]!.status, 'cancelled')
  }
})

test('a matching unproven style still records its first real creator confirmation', async () => {
  const f = fixture({ visual_style: stylePatch.visual_style, visual_style_details: stylePatch.visual_style_details })
  assert.equal(all('SELECT * FROM script_story_decisions WHERE project_id=?', f.project.id).length, 0)
  const result = await syncIntentVisualStyle(f.options)
  assert.equal(result?.changed, true)
  assert.equal(one<{ source_text: string }>('SELECT source_text FROM script_story_decisions WHERE project_id=?', f.project.id)!.source_text, creatorText)
})

test('a new style without details clears obsolete details while preserving saved configuration', async () => {
  const f = fixture()
  const result = await syncIntentVisualStyle({ ...f.options, intent: { ...intent(), settings_patch: { visual_style: '日漫二维动画' } } })
  assert.deepEqual(result?.generation_options, { genre: '悬疑', episode_count: 12, episode_duration: 90,
    visual_style: '日漫二维动画', visual_style_details: {} })
})

test('replaying the same creator confirmation reuses its saved decision regardless of detail key order', async () => {
  const f = fixture()
  await syncIntentVisualStyle(f.options)
  run('UPDATE script_story_decisions SET updated_at=? WHERE project_id=?', '2020-01-01T00:00:00.000Z', f.project.id)
  run('UPDATE scripts SET updated_at=? WHERE project_id=?', '2020-01-01T00:00:00.000Z', f.project.id)
  const beforeDecision = all('SELECT * FROM script_story_decisions WHERE project_id=?', f.project.id)
  const beforeScript = one('SELECT * FROM scripts WHERE project_id=?', f.project.id)
  const beforeStyle = projectVisualStyle(f.project.id)
  let savedCallbacks = 0
  const result = await syncIntentVisualStyle({ ...f.options, expectedVersion: beforeStyle.version,
    onSaved: () => { savedCallbacks++ },
    intent: { ...intent(), settings_patch: { visual_style: stylePatch.visual_style,
      visual_style_details: { exclusions: ['真人摄影'], rendering: '赛璐璐', medium: '二维绘制' } } } })
  assert.equal(result?.changed, false)
  assert.equal(savedCallbacks, 1)
  assert.deepEqual(all('SELECT * FROM script_story_decisions WHERE project_id=?', f.project.id), beforeDecision)
  assert.deepEqual(one('SELECT * FROM scripts WHERE project_id=?', f.project.id), beforeScript)
  assert.deepEqual(projectVisualStyle(f.project.id), beforeStyle)
  assert.equal(f.activity.entries.at(-1)!.reused, true)
  assert.equal(f.activity.entries.at(-1)!.step_id, 'confirmed_visual_style_sync')
})

test('a changed full-input baseline stops the style write and its saved callback', async () => {
  const f = fixture(), before = f.script()
  let savedCallbacks = 0
  await assert.rejects(syncIntentVisualStyle({ ...f.options,
    beforeSave: () => { throw Object.assign(new Error('项目资料已变化'), { statusCode: 409 }) },
    onSaved: () => { savedCallbacks++ },
  }), /项目资料已变化/)
  assert.equal(savedCallbacks, 0)
  assert.deepEqual(f.script(), before)
  assert.equal(all('SELECT * FROM script_story_decisions WHERE project_id=?', f.project.id).length, 0)
})
