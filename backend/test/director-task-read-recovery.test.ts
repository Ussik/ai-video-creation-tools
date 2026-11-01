import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { after, test } from 'node:test'

const directory = await mkdtemp(join(tmpdir(), 'studio-director-read-recovery-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { all, db, initDb, newId, now, run } = await import('../src/infrastructure/database/db.js')
assert.equal(db.name, join(directory, 'studio.db'), 'recovery tests must not open the workspace database')
const { createDirectorTasks } = await import('../src/modules/script/director-tasks.js')
initDb()
const tasks = createDirectorTasks()
after(async () => { await tasks.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function interruptedAfter(name: string) {
  const projectId = newId(), taskId = newId(), conversationId = newId(), questionId = newId(), timestamp = now()
  run('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', projectId, '只读创作任务恢复', timestamp, timestamp)
  tasks.start(projectId, { id: taskId, conversation: { id: conversationId,
    messages: [{ id: questionId, role: 'user', text: '重新设计第一集，保留已有场次' }] },
    execution: { title: '重新设计第一集', request: '重新设计第一集，保留已有场次', started_at: Date.now() } }, {},
  async (_signal, emit) => {
    emit({ type: 'activity', activity: [{ id: 'completed-operation', kind: 'tool', name, status: 'succeeded',
      label: '完成资料操作', summary: '已完成', started_at: Date.now() }] })
    throw new Error('后续模型连接中断')
  }, { key: 'same-sources-and-configuration', resumable: true })
  await nextTurn()
  const failed = tasks.read(projectId, taskId)
  assert.equal(failed.status, 'failed')
  return { projectId, taskId, conversationId, questionId, failed }
}

for (const name of ['read_source_document', 'search_source_document', 'read_episode_scenes', 'get_repair_context', 'search_repair_context', 'submit_repair_patch']) {
  test(`a task interrupted after ${name} resumes under its original task and conversation`, async () => {
    const f = await interruptedAfter(name)
    assert.equal(f.failed.can_resume, true)
    let executions = 0
    tasks.continue(f.projectId, f.taskId, 'same-sources-and-configuration', async () => {
      executions++
      return { reply: '已沿用原任务继续处理' }
    })
    await nextTurn()
    assert.equal(executions, 1)
    const completed = tasks.read(f.projectId, f.taskId)
    assert.equal(completed.id, f.taskId)
    assert.equal(completed.conversation_id, f.conversationId)
    assert.equal(completed.status, 'succeeded')
    const activity = completed.events.find(event => event.type === 'activity')?.activity as Array<{ id: string; name: string; status: string }>
    assert.equal(activity.find(event => event.id === 'completed-operation')?.name, name)
    assert.equal(activity.find(event => event.id === 'completed-operation')?.status, 'succeeded')
    assert.deepEqual(all<{ id: string }>('SELECT id FROM script_messages WHERE conversation_id=? ORDER BY position', f.conversationId).map(row => row.id), [f.questionId, f.taskId])
  })
}

test('a completed write or unknown operation still prevents replay even if the following model request fails', async () => {
  for (const name of ['create_document_draft', 'propose_document_patch', 'record_story_decision', 'commit_document_draft', 'unknown_function']) {
    const f = await interruptedAfter(name)
    assert.equal(f.failed.can_resume, false, name)
    assert.throws(() => tasks.continue(f.projectId, f.taskId, 'same-sources-and-configuration', async () => {
      assert.fail('a completed write must never be replayed by task continuation')
    }), /不能继续/)
  }
})
