import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ScriptActivity } from '@video-studio/shared/script/script-activity-types'

const dataDir = await mkdtemp(join(tmpdir(), 'studio-task-usage-persistence-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { db, initDb, one, run, now } = await import('../src/infrastructure/database/db.js')
assert.equal(db.name, join(dataDir, 'studio.db'), 'usage recovery fixtures must not open the workspace database')
const { createDirectorTasks } = await import('../src/modules/script/director-tasks.js')
const { createScriptExecutionUsage } = await import('../src/modules/script/script-execution-usage.js')
const { beginTextRequest } = await import('../src/infrastructure/providers/text-request-usage.js')
const { backgroundTextResponse } = await import('../src/infrastructure/providers/text-background.js')
initDb()
after(async () => { db.close(); await rm(dataDir, { recursive: true, force: true }) })

function project(id: string) {
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', id, 'usage persistence test', now(), now())
}
function input(id: string) {
  return { id, conversation: { id: `conversation-${id}`, messages: [{ id: `user-${id}`, role: 'user' as const, text: '补齐候选设定' }] },
    execution: { title: '补齐候选设定', request: '补齐候选设定', started_at: 1 } }
}
function stored(id: string) {
  return JSON.parse(one<{ snapshot: string }>('SELECT snapshot FROM script_director_tasks WHERE id=?', id)!.snapshot) as {
    status: string; events: Array<{ type: string; activity?: ScriptActivity[]; text?: string }>
  }
}
const activities = (snapshot: ReturnType<typeof stored>) => snapshot.events.find(event => event.type === 'activity')?.activity || []

test('usage reservations persist synchronously while ordinary activity keeps its write throttle', async () => {
  const projectId = 'usage-dispatch', id = 'usage-dispatch-task'
  project(projectId)
  const tasks = createDirectorTasks()
  try {
    tasks.start(projectId, input(id), {}, async (_signal, send) => {
      send({ type: 'delta', text: '已读取相关文档' })
      assert.equal(stored(id).events.length, 0, 'ordinary progress remains debounced')
      const budget = createScriptExecutionUsage({ onUpdate: usage => send({ type: 'activity', activity: {
        id: 'execution-usage', kind: 'context', scope: 'notice', status: 'running', started_at: 1,
        label: '本轮模型用量', summary: '统计本轮请求', usage,
      } satisfies ScriptActivity }) })
      budget.run(() => {
        const request = beginTextRequest({ request_bytes: 20, estimated_input_tokens: 10, reserved_output_tokens: 30 })
        const reserved = activities(stored(id))[0]!.usage!.current
        assert.equal(reserved.requests, 1)
        assert.equal(reserved.estimated_input_tokens, 10)
        assert.equal(reserved.estimated_output_tokens, 30)
        assert.equal(stored(id).events.find(event => event.type === 'delta')?.text, '已读取相关文档')
        request.identify('resp_durable_before_poll')
        assert.equal(activities(stored(id))[0]!.usage!.current.pending_requests[0]!.id, 'resp_durable_before_poll')
        request.complete({ input_tokens: 7, output_tokens: 11 })
        assert.equal(activities(stored(id))[0]!.usage!.current.output_tokens, 11)
      })
      return { reply: '完成' }
    })
    for (let i = 0; i < 20 && tasks.read(projectId, id).status === 'running'; i++) await Promise.resolve()
    assert.equal(tasks.read(projectId, id).status, 'succeeded')
  } finally { await tasks.close() }
})

test('a restored execution polls its accepted response and replaces the durable reserve without another generation POST', async t => {
  const projectId = 'usage-recovery', id = 'usage-recovery-task'
  project(projectId)
  let tasks = createDirectorTasks(), posts = 0, polls = 0, completePoll = false
  let markPolling!: () => void
  const polling = new Promise<void>(resolve => { markPolling = resolve })
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts++
      assert.equal(activities(stored(id))[0]!.usage!.current.requests, 1, 'reserve reaches disk before generation POST')
      return Response.json({ id: 'resp_durable_recovery', status: 'queued' })
    }
    polls++
    assert.equal(activities(stored(id))[0]!.usage!.current.pending_requests[0]!.id, 'resp_durable_recovery', 'response ID reaches disk before polling')
    if (completePoll) return Response.json({ id: 'resp_durable_recovery', status: 'completed', output_text: '修补完成',
      usage: { input_tokens: 17, output_tokens: 13, output_tokens_details: { reasoning_tokens: 8 } } })
    markPolling()
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))
  })
  const execute = async (signal: AbortSignal, send: (event: Record<string, unknown>) => void) => {
    const budget = createScriptExecutionUsage({ activities: activities(stored(id)), limits: { max_requests: 1, max_tokens: 100_000 },
      onUpdate: usage => send({ type: 'activity', activity: { id: 'execution-usage', kind: 'context', scope: 'notice',
        status: 'running', started_at: 1, label: '本轮模型用量', summary: '统计本轮请求', usage } satisfies ScriptActivity }) })
    return budget.run(async () => {
      const response = await backgroundTextResponse('https://usage-fixture.invalid/responses', { model: 'fixture', input: 'source' }, {},
        signal, promise => promise, () => {})
      const payload = await response.json() as { output_text: string }
      return { reply: payload.output_text }
    })
  }
  try {
    tasks.start(projectId, input(id), {}, execute, { key: 'source-version', resumable: true })
    await polling
    // Save the exact checkpoint observable at process exit, before graceful
    // cleanup adds terminal records, then restart from that persisted state.
    const atExit = one<{ snapshot: string }>('SELECT snapshot FROM script_director_tasks WHERE id=?', id)!.snapshot
    assert.equal(one<{ payload: string }>('SELECT payload FROM script_text_responses WHERE task_id=?', id)!.payload,
      JSON.stringify({ state: 'accepted', id: 'resp_durable_recovery' }))
    await tasks.close()
    run("UPDATE script_director_tasks SET status='running',snapshot=? WHERE id=?", atExit, id)
    tasks = createDirectorTasks()
    assert.equal(tasks.read(projectId, id).status, 'interrupted')
    assert.equal(activities(stored(id))[0]!.usage!.current.requests, 1)
    completePoll = true
    tasks.continue(projectId, id, 'source-version', execute)
    for (let i = 0; i < 40 && tasks.read(projectId, id).status === 'running'; i++) await Promise.resolve()
    assert.equal(tasks.read(projectId, id).status, 'succeeded')
    assert.equal(posts, 1)
    assert.equal(polls, 2)
    const current = activities(stored(id))[0]!.usage!.current
    assert.equal(current.requests, 1)
    assert.equal(current.transport_requests, 2)
    assert.equal(current.input_tokens, 17)
    assert.equal(current.output_tokens, 13)
    assert.equal(current.reasoning_tokens, 8)
    assert.equal(current.estimated_input_tokens, 0)
    assert.equal(current.estimated_output_tokens, 0)
    assert.equal(current.uncertain_requests, 0)
    assert.deepEqual(current.pending_requests, [])
  } finally { await tasks.close() }
})
