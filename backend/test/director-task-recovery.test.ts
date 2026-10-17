import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptActivity } from '@video-studio/shared/script/script-activity-types'

const dataDir = await mkdtemp(join(tmpdir(), 'studio-task-recovery-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, one, run, now } = await import('../src/infrastructure/database/db.js')
const { createDirectorTasks } = await import('../src/modules/script/director-tasks.js')
initDb()
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })

const styleSync: ScriptActivity = { id: 'style-sync', kind: 'tool', name: 'set_project_visual_style',
  step_id: 'confirmed_visual_style_sync', scope: 'step', status: 'succeeded', label: '保存已确认画风', summary: '已保存', started_at: 1 }
function project(id: string) {
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, 'recovery test', now(), now())
}
function input(id: string) {
  return { id, conversation: { id: `conversation-${id}`, messages: [{ id: `user-${id}`, role: 'user' as const, text: '采用二维水彩画风并生成大纲' }] },
    execution: { title: '大纲', request: '采用二维水彩画风并生成大纲', started_at: 1 } }
}
async function settled(tasks: ReturnType<typeof createDirectorTasks>, projectId: string, id: string) {
  for (let attempt = 0; attempt < 20 && tasks.read(projectId, id).status === 'running'; attempt++) await Promise.resolve()
  assert.notEqual(tasks.read(projectId, id).status, 'running')
  return tasks.read(projectId, id)
}

test('confirmed server style sync advances the recovery key and remains resumable after later generation failure', async () => {
  const projectId = 'server-sync', id = 'server-sync-task'
  project(projectId)
  const tasks = createDirectorTasks()
  try {
    tasks.start(projectId, input(id), {}, async (_signal, send) => {
      send({ type: 'activity', activity: { ...styleSync } })
      tasks.refreshRecoveryKey(projectId, id, 'after-style-sync')
      throw new Error('后续生成失败')
    }, { key: 'before-style-sync', resumable: true })
    const failed = await settled(tasks, projectId, id)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.can_resume, true)
    assert.equal(one<{ resume_key: string }>('SELECT resume_key FROM script_director_tasks WHERE id=?', id)!.resume_key, 'after-style-sync')
    assert.throws(() => tasks.refreshRecoveryKey(projectId, id, 'late-update'), /只有正在运行/)
    assert.throws(() => tasks.refreshRecoveryKey('foreign-project', id, 'foreign-update'), /不属于当前项目/)
    const resume = async () => ({ reply: '生成完成' })
    assert.throws(() => tasks.continue(projectId, id, 'before-style-sync', resume), /已变化/)
    assert.throws(() => tasks.continue(projectId, id, 'external-project-change', resume), /已变化/)
    tasks.continue(projectId, id, 'after-style-sync', async () => {
      tasks.refreshRecoveryKey(projectId, id, 'continued-current-version')
      return resume()
    })
    assert.equal((await settled(tasks, projectId, id)).status, 'succeeded')
    assert.equal(one<{ resume_key: string }>('SELECT resume_key FROM script_director_tasks WHERE id=?', id)!.resume_key, 'continued-current-version')
    assert.throws(() => tasks.refreshRecoveryKey(projectId, id, 'completed-update'), /只有正在运行/)
  } finally { await tasks.close() }
})

test('native writes and incomplete server sync markers still prohibit task replay', async () => {
  const projectId = 'native-writes'
  project(projectId)
  const tasks = createDirectorTasks()
  const writes: Array<Partial<ScriptActivity>> = [
    { name: 'set_project_visual_style', step_id: undefined, scope: undefined, round: 2 },
    { name: 'record_story_decision' },
    { name: 'create_document_draft' },
    { name: 'commit_document_draft' },
    { round: 1 },
    { scope: undefined },
    { step_id: 'other-sync' },
  ]
  try {
    for (const [index, write] of writes.entries()) {
      const id = `native-write-${index}`
      tasks.start(projectId, input(id), {}, async (_signal, send) => {
        send({ type: 'activity', activity: { ...styleSync, ...write } })
        throw new Error('生成失败')
      }, { key: 'current-version', resumable: true })
      const failed = await settled(tasks, projectId, id)
      assert.equal(failed.can_resume, false, JSON.stringify(write))
      assert.throws(() => tasks.continue(projectId, id, 'current-version', async () => ({ reply: '不可重放' })), /不能继续/)
    }
  } finally { await tasks.close() }
})
