import { storyboardOutlineExecution } from '../storyboard/storyboard-outline-execution.js'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { all, db, now, one, required, type Project } from '../../infrastructure/database/db.js'
import { currentAiOperationId } from '../generation/ai-operations.js'
import type { BusinessTaskKind, BusinessTaskRecord, BusinessTaskScope } from '@video-studio/shared/jobs/business-tasks'

type Stored = { id: string; project_id: string; kind: BusinessTaskKind; title: string; scope_json: string; state: BusinessTaskRecord['status']; summary: string; entry: BusinessTaskRecord['entry'];
  operation_ids: string; model_task_ids: string; job_ids: string; domain_task_id: string | null; created_at: string; updated_at: string }
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const strings = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length <= 160))] : []
const parse = <T>(raw: string | null | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback } catch { return fallback } }
const has = (table: string) => !!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table)
export function initBusinessTasks() {
  db.exec(`CREATE TABLE IF NOT EXISTS business_tasks(
    id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,kind TEXT NOT NULL,title TEXT NOT NULL,
    scope_json TEXT NOT NULL,state TEXT NOT NULL,summary TEXT NOT NULL,entry TEXT NOT NULL,operation_ids TEXT NOT NULL DEFAULT '[]',
    model_task_ids TEXT NOT NULL DEFAULT '[]',job_ids TEXT NOT NULL DEFAULT '[]',domain_task_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_business_tasks_project ON business_tasks(project_id,created_at)`)
}
/** Inventory of explicit user actions, not a regex fallback for arbitrary AI routes. */
export function businessAction(route: string, body: unknown): { kind: BusinessTaskKind; name: string; entry: BusinessTaskRecord['entry'] } | undefined {
  const path = route.split('?')[0]!.replace(/^\/api/, '')
  const suffix = /^\/projects\/[^/]+\/(.+)$/.exec(path)?.[1]
  if (suffix) {
    if (/^(?:script\/storyboard\/(?:plan|review|repair)|storyboard\/clip\/(?:plan|review))$/.test(suffix)) return { kind: 'storyboard', name: suffix.endsWith('/plan') ? '分镜规划' : suffix.endsWith('/repair') ? '分镜修订' : '分镜复核', entry: 'storyboard' }
    if (suffix === 'script/canvas/prepare' || suffix === 'visual-profiles/analyze') return { kind: 'reference', name: '分镜参考整理', entry: 'storyboard' }
    if (/^script\/(?:generate|artifacts\/generate|director\/chat|director\/asset-prompt|themes\/visuals)$/.test(suffix)) return { kind: 'script', name: '剧本创作', entry: 'script' }
    if (suffix === 'script/source/analysis') return { kind: 'analysis', name: '原稿分析', entry: 'script' }
    if (/^(?:skills\/refine-prompt|jobs\/[^/]+\/optimize-prompt)$/.test(suffix)) return { kind: 'prompt', name: '提示词优化', entry: 'canvas' }
    if (/^canvas\/(?:image-prompt-analysis|video-prompt-analysis|video-audio-plan|video-continuity-review)$/.test(suffix)) return { kind: 'analysis', name: suffix.endsWith('video-audio-plan') ? '镜头声音设计' : '镜头分析', entry: 'canvas' }
    if (/^canvases\/[^/]+\/node-proposals$/.test(suffix)) return { kind: 'analysis', name: '画布内容建议', entry: 'canvas' }
    if (/^assets\/[^/]+\/video-reviews$/.test(suffix)) return { kind: 'analysis', name: '视频复核', entry: 'assets' }
    if (suffix === 'continuity/analyze') return { kind: 'analysis', name: '分镜连续性核对', entry: 'storyboard' }
    // Media and speech HTTP receipts are linked to the real job, never a second primary list row.
    if (suffix === 'generate' || /^speech\/(?:lines\/[^/]+|batch)\/generate$/.test(suffix)) return undefined
  }
  if (/^\/(?:visual-profiles|asset-tasks)\/[^/]+\/(?:generate|reference-generate)$/.test(path)) return { kind: 'reference', name: '参考图生成', entry: 'assets' }
  return undefined
}
function scopeFor(projectId: string, body: unknown, route: string): BusinessTaskScope {
  const input = object(body), shotIds = strings(input.shot_ids), sceneIds = strings(input.scene_ids)
  if (typeof input.shot_id === 'string') shotIds.push(input.shot_id)
  const shots = all<{ id: string; title: string; source_scene_id: string | null }>('SELECT id,title,source_scene_id FROM shots WHERE project_id=?', projectId).filter(shot => shotIds.includes(shot.id))
  for (const shot of shots) if (shot.source_scene_id) sceneIds.push(shot.source_scene_id)
  const scenes = all<{ id: string; episode_number: number; heading: string }>('SELECT id,episode_number,heading FROM script_scenes WHERE project_id=?', projectId).filter(scene => sceneIds.includes(scene.id))
  const episodes = [...new Set(scenes.map(scene => scene.episode_number))].sort((a,b) => a-b)
  const profileMatch = /^\/api\/visual-profiles\/([^/]+)\//.exec(route)
  const assetMatch = /\/assets\/([^/]+)\/video-reviews/.exec(route)
  const profile = profileMatch ? one<{id:string;name:string;variant:string}>('SELECT id,name,variant FROM visual_profiles WHERE project_id=? AND id=?',projectId,decodeURIComponent(profileMatch[1]!)) : undefined
  const asset = assetMatch ? one<{id:string;filename:string}>('SELECT id,filename FROM assets WHERE project_id=? AND id=?',projectId,decodeURIComponent(assetMatch[1]!)) : undefined
  const label = profile ? `${profile.name} · ${profile.variant}` : asset ? asset.filename : shots.length ? shots.map(shot => shot.title || '未命名镜头').join('、') : episodes.length ? episodes.map(number => `第${number}集`).join('、') : '项目'
  return { ...(profile ? {profile_ids:[profile.id]} : {}), ...(asset ? {asset_ids:[asset.id]} : {}), shot_ids: [...new Set(shotIds)], scene_ids: [...new Set(sceneIds)], episode_numbers: episodes, label }
}
const toRecord = (row: Stored): BusinessTaskRecord => ({ id: row.id, project_id: row.project_id, kind: row.kind, title: row.title,
  scope: parse(row.scope_json, { shot_ids: [], scene_ids: [], episode_numbers: [], label: '项目' }), status: row.state, summary: row.summary, entry: row.entry,
  operation_ids: parse(row.operation_ids, []), model_task_ids: parse(row.model_task_ids, []), job_ids: parse(row.job_ids, []),
  ...(row.domain_task_id ? { domain_task_id: row.domain_task_id } : {}), created_at: row.created_at, updated_at: row.updated_at })
function planningRecords(projectId: string): BusinessTaskRecord[] {
  return all<{ namespace: string; payload: string }>('SELECT namespace,payload FROM script_step_checkpoints WHERE project_id=? AND namespace LIKE ?', projectId, 'storyboard-planning-task:%')
    .flatMap(row => {
      const state = parse<any>(row.payload, {}), snapshot = object(state.snapshot)
      if (!snapshot.id || row.namespace !== `storyboard-planning-task:${snapshot.id}` || snapshot.project_id !== projectId) return []
      const scope = scopeFor(projectId, state.input, ''), status = snapshot.status === 'succeeded' ? 'succeeded' : snapshot.status === 'running' ? 'running' : snapshot.status === 'failed' ? 'failed' : 'interrupted'
      const stages: Record<string,string> = { preparing: '准备资料', generating: '生成分镜', reviewing: '复核分镜', repairing: '修订分镜', rechecking: '复查修订结果', completed: '已完成' }
      const progress = object(snapshot.progress), outlineExecution = storyboardOutlineExecution(object(state.steps))
      if (progress.phase !== 'shots' && outlineExecution) snapshot.stage = outlineExecution.stage
      return [{ id: `planning:${snapshot.id}`, project_id: projectId, kind: 'storyboard' as const, title: `${scope.label}分镜规划`, scope, status,
        summary: snapshot.error?.message || (progress.phase === 'shots' ? `已完成 ${progress.completed_shots}/${progress.total_shots} 镜` : stages[snapshot.stage] || '查看原任务'), entry: 'storyboard' as const,
        operation_ids: [], model_task_ids: [`storyboard:${snapshot.id}`], job_ids: [], domain_task_id: snapshot.id,
        created_at: new Date(snapshot.started_at).toISOString(), updated_at: new Date(snapshot.updated_at).toISOString() } as BusinessTaskRecord]
    })
}
export function projectBusinessTasks(projectId: string) {
  required<Project>('projects', projectId)
  const tasks = [...all<Stored>('SELECT * FROM business_tasks WHERE project_id=? ORDER BY created_at DESC', projectId).map(toRecord), ...planningRecords(projectId)]
  // Only exact operation IDs/model-task IDs/result job IDs may associate records.
  for (const task of tasks) if (task.status === 'running' && task.operation_ids.length) {
    const op = one<{ state: string; lease_until: number }>('SELECT state,lease_until FROM ai_operations WHERE id=? AND project_id=?', task.operation_ids[0]!, projectId)
    if (op?.state === 'running' && op.lease_until < Date.now()) { task.status = 'interrupted'; task.summary = '处理已中断，请回原任务核对保留成果' }
  }
  const operationIds = new Set(tasks.flatMap(task => task.operation_ids)), modelIds = new Set(tasks.flatMap(task => task.model_task_ids))
  const unlinkedOperations = has('ai_operations') ? all<{id:string}>('SELECT id FROM ai_operations WHERE project_id=?', projectId).filter(row => !operationIds.has(row.id)).length : 0
  const unlinkedModels = has('model_request_tasks') ? all<{id:string}>('SELECT id FROM model_request_tasks WHERE project_id=?', projectId).filter(row => !modelIds.has(row.id)).length : 0
  return { tasks: tasks.sort((a,b) => b.created_at.localeCompare(a.created_at)), legacy_unlinked_count: unlinkedOperations + unlinkedModels }
}
export function businessTaskDetails(projectId: string, id: string): BusinessTaskRecord | undefined {
  const task = projectBusinessTasks(projectId).tasks.find(task => task.id === id)
  if (!task) return
  const operationSet = new Set(task.operation_ids)
  const operations = has('ai_operations') ? all<any>('SELECT id,route,state,result,model_task_id FROM ai_operations WHERE project_id=?', projectId).filter(row => operationSet.has(row.id)) : []
  const modelIds = new Set([...task.model_task_ids, ...operations.map(row => row.model_task_id).filter(Boolean)])
  const models = has('model_request_tasks') ? all<any>('SELECT id,state,label,usage,results FROM model_request_tasks WHERE project_id=?', projectId).filter(row => modelIds.has(row.id)).map(row => {
    const usage = parse<any>(row.usage, {}), results = parse<any[]>(row.results, [])
    return { id: row.id, state: row.state, label: row.label, requests: Number(usage.requests || 0), uncertain_requests: Number(usage.uncertain_requests || 0), phases: [...new Set(results.map(result => String(result.stage || '')).filter(Boolean))] }
  }) : []
  return { ...task, details: { operations: operations.map(row => ({ id: row.id, state: row.state, route: row.route, message: object(parse(row.result, {})).detail })), models } }
}
export function registerBusinessTaskHistory(app: FastifyInstance) {
  initBusinessTasks()
  const owned = new WeakMap<FastifyRequest, string>()
  app.addHook('preHandler', async request => {
    if (request.method !== 'POST') return
    const action = businessAction(request.url, request.body), operationId = currentAiOperationId(request)
    if (!action || !operationId) return
    const projectMatch = /^\/api\/projects\/([^/]+)\//.exec(request.url)
    const projectId = projectMatch ? decodeURIComponent(projectMatch[1]!) : one<{project_id:string}>('SELECT project_id FROM ai_operations WHERE id=?', operationId)?.project_id
    if (!projectId) return
    const scope = scopeFor(projectId, request.body, request.url), id = `operation:${operationId}`, time = now()
    db.prepare(`INSERT OR IGNORE INTO business_tasks(id,project_id,kind,title,scope_json,state,summary,entry,operation_ids,created_at,updated_at)
      VALUES(?,?,?,?,?,'running','等待处理结果',?,?,?,?)`).run(id,projectId,action.kind,`${scope.label}${action.name}`,JSON.stringify(scope),action.entry,JSON.stringify([operationId]),time,time)
    owned.set(request,id)
  })
  app.addHook('onSend', async (request,reply,payload) => {
    const id = owned.get(request)
    if (!id || typeof payload !== 'string') return payload
    const result = parse<any>(payload, {}), task = object(result.preparation), job = object(result.job)
    const modelId = String(reply.getHeader('x-model-task-id') || ''), jobIds = strings([job.id, result.job_id, ...(Array.isArray(result.jobs) ? result.jobs.map((value:any) => value.id) : [])])
    db.prepare('UPDATE business_tasks SET state=?,summary=?,model_task_ids=?,job_ids=?,domain_task_id=?,updated_at=? WHERE id=?')
      .run(reply.statusCode >= 400 ? 'failed' : ['partial','unknown','running','failed','cancelled'].includes(String(task.state)) || result.status === 'partial' ? 'interrupted' : 'succeeded', reply.statusCode >= 400 ? String(result.detail || result.message || '未完成，请回原功能查看') : task.state === 'unknown' ? '响应尚未确认，请核对原任务' : task.state === 'partial' || result.status === 'partial' ? '部分成果已保留，请回原功能继续未完成项' : '已完成，请回原功能查看结果',
        JSON.stringify(modelId ? [modelId] : []),JSON.stringify(jobIds),typeof task.run_id === 'string' ? task.run_id : null,now(),id)
    return payload
  })
  app.get('/api/projects/:id/task-history',async request => projectBusinessTasks((request.params as {id:string}).id))
  app.get('/api/projects/:id/task-history/:taskId',async (request,reply) => {
    const {id,taskId} = request.params as {id:string;taskId:string}; const task=businessTaskDetails(id,taskId)
    return task || reply.code(404).send({detail:'业务任务不存在'})
  })
}
