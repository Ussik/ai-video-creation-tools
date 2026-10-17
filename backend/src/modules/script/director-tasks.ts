import { createHash } from 'node:crypto'
import type { FastifyReply } from 'fastify'
import type { ScriptActivity, ScriptExecution } from '@video-studio/shared/script/script-activity-types'
import { createStreamScope, directorStreamHeartbeatMs, directorTaskSoftTimeoutMs, StreamWaitTimeoutError } from '@video-studio/shared/script/script-stream-policy'
import { all, db, now, one, run } from '../../infrastructure/database/db.js'
import { withTextResponseRecovery, type BackgroundResponse } from '../../infrastructure/providers/text-background.js'
import { invalid } from '../../infrastructure/http/request.js'
import { conversationTimestamp, insertConversationMessage, saveConversation, type ConversationMessage } from './script-conversations.js'

type Event = Record<string, unknown>
type Status = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'paused'
export type DirectorTaskSnapshot = {
  id: string; project_id: string; conversation_id: string; message_id: string; status: Status;
  started_at: number; sequence?: number; can_resume?: boolean; active_duration_ms?: number; execution: ScriptExecution; events: Event[];
}
type TaskRow = { id: string; project_id: string; conversation_id: string; message_id: string; request_hash: string; snapshot: string; status: Status; request_payload?: string; resume_key?: string }
export type DirectorTaskInput = { id: string; conversation: { id: string; label?: string; messages: ConversationMessage[] }; execution: ScriptExecution }
type Running = { snapshot: DirectorTaskSnapshot; controller: AbortController; listeners: Set<(event: Event) => void>; timer?: ReturnType<typeof setTimeout>; work?: Promise<void> }
const readOnlyTools = new Set(['get_creation_state', 'get_project_visual_style', 'search_project_content', 'read_documents', 'find_related_content', 'get_document_review_context', 'read_visual_profiles', 'get_storyboard_context', 'read_source_document', 'search_source_document', 'ask_creator'])
function canReplayAfter(activity: ScriptActivity) {
  return readOnlyTools.has(activity.name || '') || activity.name === 'set_project_visual_style'
    && activity.step_id === 'confirmed_visual_style_sync' && activity.scope === 'step' && activity.round === undefined
}
const problem = (message: string, statusCode = 409): never => { throw Object.assign(new Error(message), { statusCode }) }

function resultExecution(execution: ScriptExecution, result: Event, id: string): ScriptExecution {
  const draft = result.tool_draft as { id: string; version: string; status: string; workflow?: ScriptExecution['workflow']; revision_task?: { status: string }; documents: Array<{ title: string }>; resource_changes?: Array<{ title: string }> } | undefined
  let outcome: ScriptExecution['outcome'] = { kind: 'reply', summary: '本轮回复已完成，可继续讨论。' }
  if (draft) outcome = { kind: draft.status === 'saved' ? 'saved' : draft.status === 'discarded' ? 'discarded' : draft.revision_task && draft.revision_task.status !== 'ready' ? 'partial' : 'draft',
    summary: draft.status === 'saved' ? '修改已保存。' : '草稿已保留，可预览后确认或继续处理。', draft_id: draft.id, draft_version: draft.version }
  else if (result.draft) outcome = { kind: 'draft', summary: '创作草稿已准备，尚未写入项目。请预览后确认。', draft_id: `workflow:${id}` }
  else if (result.review) outcome = { kind: 'review', summary: '评审已完成，文档正文未修改。' }
  else if ((result.classification as { status?: string } | undefined)?.status === 'pending') outcome = { kind: 'question', summary: '需要你确认当前设定。' }
  else if (result.completion_kind === 'next_step') outcome = { kind: 'next_step', summary: '下一步建议已准备。' }
  return { ...execution, ...(draft ? { targets: [...draft.documents.map(doc => doc.title), ...(draft.resource_changes || []).map(item => item.title)].slice(0, 50) } : {}),
    ...(result.workflow || draft?.workflow ? { workflow: (result.workflow || draft?.workflow) as ScriptExecution['workflow'] } : {}),
    outcome: { ...outcome, ...result.execution_outcome as ScriptExecution['outcome'] } }
}

/** Execution belongs to the server, while each SSE connection is only a viewer. */
export function createDirectorTasks() {
  const running = new Map<string, Running>()
  let shuttingDown = false
  function read(projectId: string, id: string): DirectorTaskSnapshot {
    const row = one<TaskRow>('SELECT * FROM script_director_tasks WHERE id=? AND project_id=?', id, projectId)
    if (!row) return problem('创作任务不存在或不属于当前项目', 404)
    return running.get(id)?.snapshot || JSON.parse(row.snapshot) as DirectorTaskSnapshot
  }
  function persist(snapshot: DirectorTaskSnapshot) {
    run('UPDATE script_director_tasks SET status=?, snapshot=?, updated_at=? WHERE id=?', snapshot.status, JSON.stringify(snapshot), now(), snapshot.id)
  }
  function saveReply(snapshot: DirectorTaskSnapshot) {
    const row = one<{ position: number }>('SELECT position FROM script_messages WHERE conversation_id=? AND id=?', snapshot.conversation_id, snapshot.message_id)
    if (!row) return // The project may have been explicitly deleted.
    const final = snapshot.events.find(event => event.type === 'done')
    const error = snapshot.events.find(event => event.type === 'error')
    const delta = snapshot.events.find(event => event.type === 'delta')
    const intent = snapshot.events.find(event => event.type === 'intent')
    const activities = snapshot.events.find(event => event.type === 'activity')?.activity as ScriptActivity[] | undefined
    const text = String(final?.reply || error?.message || delta?.text || '正在处理创作任务…')
    const metadata: Record<string, unknown> = { execution: snapshot.execution, task_id: snapshot.id, task_status: snapshot.status, task_can_resume: snapshot.can_resume === true }
    for (const key of ['classification', 'classification_version', 'classification_source', 'review']) if (final?.[key] !== undefined) metadata[key] = final[key]
    if (final?.classification_source) metadata.classification_context = '[]'
    insertConversationMessage(snapshot.conversation_id, { id: snapshot.message_id, role: 'assistant', text,
      processing_duration_ms: snapshot.active_duration_ms ?? Math.max(0, Date.now() - snapshot.started_at), activity: activities,
      stage_context: final?.stage_context || intent?.stage_context, reply_metadata: metadata }, row.position)
    run('UPDATE script_conversations SET updated_at=? WHERE id=?', conversationTimestamp(snapshot.project_id), snapshot.conversation_id)
  }
  function settle(snapshot: DirectorTaskSnapshot, status: Exclude<Status, 'running' | 'succeeded'>, message: string) {
    snapshot.status = status
    const event = snapshot.events.find(item => item.type === 'activity')
    if ((event?.activity as ScriptActivity[] | undefined)?.some(item => item.kind === 'tool' && item.status === 'succeeded' && !canReplayAfter(item))) snapshot.can_resume = false
    if (event) event.activity = (event.activity as ScriptActivity[]).map(item => item.status === 'running' ? { ...item,
      status: status === 'cancelled' ? 'cancelled' : 'failed', ended_at: Date.now(), duration_ms: Math.max(0, Date.now() - item.started_at), summary: message } : item)
    snapshot.execution = { ...snapshot.execution, outcome: { ...snapshot.execution.outcome, kind: status === 'cancelled' ? 'cancelled' : status === 'paused' ? 'partial' : 'failed', summary: message.slice(0, 3000) } }
    snapshot.events = [...snapshot.events.filter(item => !['done', 'error'].includes(String(item.type))), { type: 'error', message, task_status: status, can_resume: snapshot.can_resume, sequence: snapshot.sequence = (snapshot.sequence || 0) + 1 }]
    db.transaction(() => { persist(snapshot); saveReply(snapshot) })()
  }
  // A process restart cannot reconnect to an old provider call. Do not charge
  // for an automatic replay; retain its records and report the interruption.
  for (const row of all<TaskRow>("SELECT * FROM script_director_tasks WHERE status='running'")) {
    const snapshot = JSON.parse(row.snapshot) as DirectorTaskSnapshot
    settle(snapshot, 'interrupted', '后端服务已重启，本轮任务已中断。已完成的草稿和操作仍保留，请检查后继续。')
  }
  function emit(task: Running, event: Event) {
    if (task.snapshot.status !== 'running') return
    event = { ...event, task_id: task.snapshot.id, sequence: task.snapshot.sequence = (task.snapshot.sequence || 0) + 1 }
    const events = task.snapshot.events
    const kind = String(event.type)
    if (kind === 'activity') {
      let saved = events.find(item => item.type === kind)
      if (!saved) { saved = { type: kind, activity: [] }; events.push(saved) }
      const entries = saved.activity as ScriptActivity[]
      for (const entry of (Array.isArray(event.activity) ? event.activity : [event.activity]) as ScriptActivity[]) {
        Object.assign(entry, { task_id: task.snapshot.id, sequence: event.sequence })
        const index = entries.findIndex(item => item.id === entry.id)
        if (index < 0) entries.push(entry); else entries[index] = entry
      }
    } else if (kind === 'delta') {
      let saved = events.find(item => item.type === kind)
      if (!saved) { saved = { type: kind, text: '' }; events.push(saved) }
      saved.text = String(saved.text) + String(event.delta || event.text || '')
    } else if (kind === 'process') {
      events.push(event)
      while (events.filter(item => item.type === kind).length > 20) events.splice(events.findIndex(item => item.type === kind), 1)
    } else if (!['heartbeat', 'close'].includes(kind)) {
      const index = events.findIndex(item => item.type === kind)
      if (index < 0) events.push(event); else events[index] = { ...events[index], ...event }
    }
    if (!task.timer) {
      task.timer = setTimeout(() => { task.timer = undefined; persist(task.snapshot) }, 250)
      task.timer.unref()
    }
    for (const listener of task.listeners) listener(event)
  }
  function start(projectId: string, input: DirectorTaskInput, request: unknown, execute: (signal: AbortSignal, emit: (event: Event) => void) => Promise<Event>, recovery?: { key: string; resumable: boolean }) {
    const hash = createHash('sha256').update(JSON.stringify({ projectId, input, request })).digest('hex')
    const existing = one<TaskRow>('SELECT * FROM script_director_tasks WHERE id=?', input.id)
    if (existing) {
      if (existing.project_id !== projectId || existing.request_hash !== hash) problem('任务 ID 已用于另一条请求，请重新进入查看原任务')
      return read(projectId, input.id)
    }
    if (shuttingDown) problem('服务正在关闭，请稍后重试', 503)
    if (one("SELECT id FROM script_director_tasks WHERE project_id=? AND status='running'", projectId)) problem('当前项目还有创作任务正在运行，请先查看或停止该任务')
    const user = input.conversation.messages.at(-1)
    if (!user?.id || user.role !== 'user' || input.conversation.messages.some(item => item.id === input.id)) invalid('任务需关联最后一条创作者消息与独立的回复 ID')
    const started_at = Date.now()
    const snapshot: DirectorTaskSnapshot = { id: input.id, project_id: projectId, conversation_id: input.conversation.id,
      message_id: input.id, status: 'running', started_at, sequence: 0, can_resume: recovery?.resumable, active_duration_ms: 0, execution: { ...input.execution, started_at }, events: [] }
    db.transaction(() => {
      saveConversation(projectId, input.conversation)
      run('INSERT INTO script_director_tasks (id, project_id, conversation_id, user_message_id, message_id, request_hash, status, snapshot, created_at, updated_at, request_payload, resume_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        input.id, projectId, input.conversation.id, user.id, input.id, hash, 'running', JSON.stringify(snapshot), now(), now(), JSON.stringify(request), recovery?.key || null)
      const position = one<{ position: number }>('SELECT COALESCE(MAX(position), -1)+1 AS position FROM script_messages WHERE conversation_id=?', input.conversation.id)!.position
      insertConversationMessage(input.conversation.id, { id: input.id, role: 'assistant', text: '正在处理创作任务…',
        reply_metadata: { execution: snapshot.execution, task_id: input.id, task_status: 'running' } }, position)
    })()
    launch(snapshot, execute)
    return snapshot
  }
  function launch(snapshot: DirectorTaskSnapshot, execute: (signal: AbortSignal, emit: (event: Event) => void) => Promise<Event>) {
    const task: Running = { snapshot, controller: new AbortController(), listeners: new Set() }
    const sessionStarted = Date.now(), previousDuration = snapshot.active_duration_ms || 0
    const progressTimer = setInterval(() => { snapshot.active_duration_ms = previousDuration + Date.now() - sessionStarted; persist(snapshot) }, directorStreamHeartbeatMs)
    progressTimer.unref()
    running.set(snapshot.id, task)
    task.work = (async () => {
      const scope = createStreamScope(task.controller.signal, { totalMessage: '本次任务执行已达到 180 分钟，已保存完成步骤。请检查后继续未完成部分。' })
      const softTimer = setTimeout(() => emit(task, { type: 'progress', stage: 'long_running', text: '任务执行较久，已完成步骤持续保留；仍在处理，可继续等待或停止。' }), directorTaskSoftTimeoutMs)
      softTimer.unref()
      try {
        const result = await withTextResponseRecovery({
          read: key => { const row = one<{ payload: string }>('SELECT payload FROM script_text_responses WHERE task_id=? AND request_key=?', snapshot.id, key); return row ? JSON.parse(row.payload) as BackgroundResponse : undefined },
          save: (key, value) => {
            if (!value) run('DELETE FROM script_text_responses WHERE task_id=? AND request_key=?', snapshot.id, key)
            else run('INSERT INTO script_text_responses (task_id,request_key,payload,updated_at) VALUES (?,?,?,?) ON CONFLICT(task_id,request_key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at', snapshot.id, key, JSON.stringify(value), now())
          },
        }, () => scope.wait(execute(scope.signal, event => emit(task, event))))
        emit(task, { type: 'done', ...result })
        snapshot.status = 'succeeded'
        snapshot.can_resume = false
        snapshot.active_duration_ms = previousDuration + Date.now() - sessionStarted
        snapshot.execution = resultExecution(snapshot.execution, result, snapshot.id)
        db.transaction(() => { persist(snapshot); saveReply(snapshot) })()
      } catch (error) {
        snapshot.active_duration_ms = previousDuration + Date.now() - sessionStarted
        const status = shuttingDown ? 'interrupted' : task.controller.signal.aborted ? 'cancelled' : scope.signal.aborted && error instanceof StreamWaitTimeoutError && error.kind === 'total' ? 'paused' : 'failed'
        settle(snapshot, status, status === 'interrupted' ? '后端服务已关闭，本轮任务已中断。已完成的草稿和操作仍保留。'
          : status === 'cancelled' ? '已停止生成。已完成的草稿和操作仍保留。' : String(error instanceof Error ? error.message : error).slice(0, 3000))
        for (const listener of task.listeners) {
          const activity = snapshot.events.find(event => event.type === 'activity')
          if (activity) listener(activity)
          listener(snapshot.events.find(event => event.type === 'error')!)
        }
      } finally {
        clearTimeout(softTimer)
        clearInterval(progressTimer)
        if (task.timer) clearTimeout(task.timer)
        scope.close()
        for (const listener of task.listeners) listener({ type: 'close' })
        task.listeners.clear(); running.delete(snapshot.id)
      }
    })()
    return snapshot
  }
  async function subscribe(projectId: string, id: string, reply: FastifyReply) {
    const snapshot = read(projectId, id)
    reply.hijack()
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    const send = (event: Event) => { if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`) }
    send({ type: 'task', task_id: id, task_status: snapshot.status, can_resume: snapshot.can_resume, snapshot_sequence: snapshot.sequence || 0, execution: snapshot.execution })
    for (const event of snapshot.events) send(event)
    if (snapshot.status !== 'running') { send({ type: 'close' }); reply.raw.end(); return }
    const task = running.get(id)!
    await new Promise<void>(resolve => {
      const timer = setInterval(() => send({ type: 'heartbeat' }), directorStreamHeartbeatMs)
      timer.unref()
      const cleanup = () => { clearInterval(timer); task.listeners.delete(listener); reply.raw.removeListener('close', cleanup); resolve() }
      const listener = (event: Event) => { send(event); if (event.type === 'close') { cleanup(); reply.raw.end() } }
      task.listeners.add(listener)
      reply.raw.once('close', cleanup)
      // Disconnect only detaches this viewer. Explicit cancellation is a
      // separate request and applies to the server-owned task.
    })
  }
  return {
    start, read, subscribe,
    refreshRecoveryKey(projectId: string, id: string, key: string) {
      if (read(projectId, id).status !== 'running') problem('只有正在运行的创作任务可以更新恢复版本')
      const updated = db.prepare("UPDATE script_director_tasks SET resume_key=?, updated_at=? WHERE id=? AND project_id=? AND status='running'").run(key, now(), id, projectId)
      if (!updated.changes) problem('创作任务状态已变化，不能更新恢复版本')
    },
    request(projectId: string, id: string) {
      read(projectId, id)
      const row = one<TaskRow>('SELECT * FROM script_director_tasks WHERE id=?', id)!
      if (!row.request_payload) return problem('此历史任务未保存恢复资料，请检查草稿后重新发起')
      return JSON.parse(row.request_payload!) as unknown
    },
    continue(projectId: string, id: string, key: string, execute: (signal: AbortSignal, emit: (event: Event) => void) => Promise<Event>) {
      const snapshot = read(projectId, id)
      if (snapshot.status === 'running') return snapshot
      if (shuttingDown) return problem('服务正在关闭，请稍后重试', 503)
      if (snapshot.status === 'succeeded' || !snapshot.can_resume) return problem('此任务不能继续，请检查已有草稿后重新发起')
      const row = one<TaskRow>('SELECT * FROM script_director_tasks WHERE id=?', id)!
      if (row.resume_key !== key) return problem('项目资料、有效稿、候选版本或模型配置已变化，请重新检查后发起，不能续用旧任务')
      if (one("SELECT id FROM script_director_tasks WHERE project_id=? AND status='running'", projectId)) return problem('当前项目已有任务运行，请先查看或停止')
      snapshot.status = 'running'
      snapshot.execution = { ...snapshot.execution, outcome: undefined }
      snapshot.events = snapshot.events.filter(event => ['activity', 'process'].includes(String(event.type)))
      persist(snapshot)
      launch(snapshot, execute)
      return snapshot
    },
    active(projectId: string) { return all<TaskRow>("SELECT * FROM script_director_tasks WHERE project_id=? AND status='running'", projectId).map(row => read(projectId, row.id)) },
    unconfirmedDrafts(projectId: string) {
      return all<TaskRow>("SELECT * FROM script_director_tasks WHERE project_id=? AND status='succeeded' ORDER BY created_at DESC LIMIT 30", projectId)
        .map(row => read(projectId, row.id)).filter(task => task.execution.outcome?.kind === 'draft' && task.events.some(event => event.type === 'done' && event.draft))
        .map(task => ({ id: task.id, conversation_id: task.conversation_id, message_id: task.message_id,
          started_at: task.started_at, execution: task.execution,
          events: task.events.filter(event => event.type === 'done').map(event => ({ type: 'done', draft: event.draft })) }))
    },
    resolveDraft(projectId: string, id: string, kind: 'saved' | 'discarded') {
      const snapshot = read(projectId, id)
      if (snapshot.status !== 'succeeded' || !snapshot.events.some(event => event.type === 'done' && event.draft)) problem('当前任务没有可处理的阶段草稿')
      snapshot.execution = { ...snapshot.execution, outcome: { ...snapshot.execution.outcome, kind, summary: kind === 'saved' ? '阶段草稿已保存。' : '阶段草稿已放弃。' } }
      db.transaction(() => { persist(snapshot); saveReply(snapshot) })()
      return snapshot
    },
    cancel(projectId: string, id: string) { const snapshot = read(projectId, id); running.get(id)?.controller.abort(); return snapshot },
    cancelProject(projectId: string) { for (const task of running.values()) if (task.snapshot.project_id === projectId) task.controller.abort() },
    async close() { shuttingDown = true; for (const task of running.values()) task.controller.abort(new Error('服务关闭，任务可在重启后继续')); await Promise.all([...running.values()].map(task => task.work)) },
  }
}
