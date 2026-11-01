import { api, json, type Job, type Shot } from '../../shared/api/api'
import type { CanvasGraph } from './ProjectCanvas'

export type CanvasGenerationSubmissionScope = { projectId: string; canvasId: string; nodeId: string }
export type CanvasGenerationSubmission = CanvasGenerationSubmissionScope & {
  version: 1
  id: string
  createdAt: string
  sourceSignature: string
  baselineJobId: string | null
  request: Record<string, unknown>
  shot: { key: string; input: Record<string, unknown>; id: string | null } | null
  candidates: { key: string; jobId: string | null }[]
  inFlightKey?: string | null
  rejected?: string
}
type SubmissionStorage = Pick<Storage, 'getItem' | 'setItem'>
type SubmissionApi = <T>(path: string, init?: RequestInit) => Promise<T>
type SubmissionLock = Pick<LockManager, 'request'>

export const canvasGenerationSubmissionStoragePrefix = 'canvas-generation-submission:'
export const canvasGenerationSubmissionStorageKey = (scope: CanvasGenerationSubmissionScope) =>
  `${canvasGenerationSubmissionStoragePrefix}${JSON.stringify([scope.projectId, scope.canvasId, scope.nodeId])}`

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

// Geometry, output and selection are not generation inputs. Incoming sources
// are included so recovering a task cannot overwrite a newly changed reference.
export function canvasGenerationSubmissionSource(graph: CanvasGraph, nodeId: string, createdShotId?: string | null): string {
  const node = graph.nodes.find(item => item.id === nodeId)
  if (!node) return ''
  const { generation_completed_job_id: _completed, ...settings } = node.settings
  if (!node.shot_id || createdShotId) delete settings.storyboard_revision
  return canonical({ node: { type: node.type, title: node.title, prompt: node.prompt, text: node.text,
    model_id: node.model_id, shot_id: createdShotId && node.shot_id === createdShotId ? null : node.shot_id, settings },
  references: graph.edges.filter(edge => edge.target === nodeId).map(edge => {
    const source = graph.nodes.find(item => item.id === edge.source)
    return { source: edge.source, reference_asset_id: edge.reference_asset_id,
      node: source && { type: source.type, asset_id: source.asset_id, job_id: source.job_id, text: source.text, prompt: source.prompt } }
  }) })
}

export function readCanvasGenerationSubmission(scope: CanvasGenerationSubmissionScope,
  storage: SubmissionStorage = window.localStorage): CanvasGenerationSubmission | null {
  const raw = storage.getItem(canvasGenerationSubmissionStorageKey(scope))
  if (!raw) return null
  let item: CanvasGenerationSubmission
  try { item = JSON.parse(raw) } catch { throw new Error('生成提交记录无法读取，请保留浏览器数据并查看任务记录') }
  if (item?.version !== 1 || item.projectId !== scope.projectId || item.canvasId !== scope.canvasId || item.nodeId !== scope.nodeId
    || typeof item.id !== 'string' || typeof item.sourceSignature !== 'string' || !item.request || typeof item.request !== 'object'
    || !Array.isArray(item.candidates) || item.candidates.length < 1 || item.candidates.length > 4
    || item.candidates.some(candidate => typeof candidate.key !== 'string' || candidate.jobId !== null && typeof candidate.jobId !== 'string')
    || item.shot && (typeof item.shot.key !== 'string' || !item.shot.input || typeof item.shot.input !== 'object')) {
    throw new Error('生成提交记录不完整，请保留浏览器数据并查看任务记录')
  }
  return item
}

export const canvasGenerationSubmissionFinished = (item: CanvasGenerationSubmission) =>
  !!item.rejected || item.candidates.every(candidate => !!candidate.jobId)

export function persistCanvasGenerationSubmission(item: CanvasGenerationSubmission,
  storage: SubmissionStorage = window.localStorage, creating = false): CanvasGenerationSubmission {
  const previous = readCanvasGenerationSubmission(item, storage)
  if (!creating && previous?.id !== item.id) throw new Error('生成提交记录已变化，请重新检查已有任务')
  const next = previous?.id === item.id ? { ...item, shot: item.shot && { ...item.shot, id: previous.shot?.id || item.shot.id },
    candidates: item.candidates.map((candidate, index) => ({ ...candidate, jobId: previous.candidates[index]?.jobId || candidate.jobId })) } : item
  const key = canvasGenerationSubmissionStorageKey(item), value = JSON.stringify(next)
  try {
    storage.setItem(key, value)
    if (storage.getItem(key) !== value) throw new Error('write verification failed')
  } catch { throw new Error('无法保存生成提交记录，已停止后续提交；请恢复浏览器存储后检查已有任务') }
  return next
}

export function createCanvasGenerationSubmission(input: CanvasGenerationSubmissionScope & {
  sourceSignature: string; baselineJobId: string | null; request: Record<string, unknown>; candidateCount: number;
  shotInput?: Record<string, unknown>
}, storage: SubmissionStorage = window.localStorage): CanvasGenerationSubmission {
  const existing = readCanvasGenerationSubmission(input, storage)
  if (existing && (!canvasGenerationSubmissionFinished(existing)
    // A second tab can still display the pre-submit node. Its first click must
    // recover the first tab's intent, not create another candidate batch.
    || !existing.rejected && existing.sourceSignature === input.sourceSignature && existing.baselineJobId === input.baselineJobId)) return existing
  const id = crypto.randomUUID()
  return persistCanvasGenerationSubmission({ version: 1, id, createdAt: new Date().toISOString(), projectId: input.projectId,
    canvasId: input.canvasId, nodeId: input.nodeId, sourceSignature: input.sourceSignature, baselineJobId: input.baselineJobId,
    request: JSON.parse(JSON.stringify(input.request)),
    shot: input.shotInput ? { key: `${id}_shot`, input: JSON.parse(JSON.stringify(input.shotInput)), id: null } : null,
    candidates: Array.from({ length: Math.max(1, Math.min(4, Math.trunc(input.candidateCount))) }, (_, index) => ({ key: `${id}_${index}`, jobId: null })),
  }, storage, true)
}

const localLocks = new Map<string, Promise<unknown>>()
export async function withCanvasGenerationSubmissionLock<T>(scope: CanvasGenerationSubmissionScope, allowSubmit: boolean,
  action: () => Promise<T>, locks: SubmissionLock | undefined = window.navigator.locks): Promise<T> {
  const name = canvasGenerationSubmissionStorageKey(scope)
  if (locks?.request) return locks.request(name, action)
  if (allowSubmit) throw new Error('当前浏览器环境无法保护重复提交，请通过 localhost 或 HTTPS 使用新版 Chrome/Edge；已有任务仍可检查找回')
  // Read-only recovery remains available without Web Locks. No paid POST is
  // allowed in this fallback; durable operation keys are retained throughout.
  const previous = localLocks.get(name) || Promise.resolve()
  const current = previous.catch(() => {}).then(action)
  localLocks.set(name, current)
  try { return await current } finally { if (localLocks.get(name) === current) localLocks.delete(name) }
}

export async function recoverCanvasGenerationSubmission(item: CanvasGenerationSubmission, options: {
  allowSubmit?: boolean
  storage?: SubmissionStorage
  api?: SubmissionApi
  isActive?: () => boolean
  onProgress?: (item: CanvasGenerationSubmission) => Promise<void> | void
} = {}): Promise<CanvasGenerationSubmission> {
  const storage = options.storage || window.localStorage, request = options.api || api
  let current = readCanvasGenerationSubmission(item, storage)
  if (!current || current.id !== item.id) throw new Error('生成提交记录已变化，请重新检查已有任务')
  const active = () => options.isActive?.() !== false
  const persist = async (next: CanvasGenerationSubmission) => {
    current = persistCanvasGenerationSubmission(next, storage)
    await options.onProgress?.(current)
  }
  const base = `/projects/${encodeURIComponent(item.projectId)}`
  const send = async <T>(path: string, key: string, value: Record<string, unknown>): Promise<T> => {
    const hadUnknownAttempt = !!current!.inFlightKey
    await persist({ ...current!, inFlightKey: key })
    if (!active()) throw new Error('已离开来源画布，原提交已保留，请回到该画布检查已有任务')
    try { return await request<T>(path, { ...json('POST', value), headers: { 'Idempotency-Key': key } }) }
    catch (error) {
      const status = (error as { status?: number })?.status
      // These statuses definitively reject input before acceptance. A conflict
      // may be an accepted tombstone, so it must keep the original identity.
      if (!hadUnknownAttempt && (status === 400 || status === 422)) await persist({ ...current!, inFlightKey: null,
        rejected: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
  if (current.shot && !current.shot.id) {
    const key = current.shot.key
    const found = await request<{ shot: Shot | null }>(`${base}/shot-submissions/${encodeURIComponent(key)}`)
    if (found.shot !== null && (typeof found.shot?.id !== 'string' || !found.shot.id)) throw new Error('无法确认已有镜头，已停止提交')
    if (found.shot) await persist({ ...current, inFlightKey: null, shot: { ...current.shot!, id: found.shot.id } })
    else if (options.allowSubmit && !current.rejected && active()) {
      try {
        const shot = await send<Shot>(`${base}/shots`, key, current.shot.input)
        if (typeof shot?.id !== 'string' || !shot.id) throw new Error('镜头提交响应不完整，请检查已有任务')
        await persist({ ...current!, inFlightKey: null, shot: { ...current!.shot!, id: shot.id } })
      } catch (error) {
        // Lost responses are resolved with GET only. Stop this run even if the
        // shot is found, so a refresh never turns into a paid submission.
        if (!current!.rejected) {
          const recovered = await request<{ shot: Shot | null }>(`${base}/shot-submissions/${encodeURIComponent(key)}`).catch(() => null)
          if (typeof recovered?.shot?.id === 'string') await persist({ ...current!, inFlightKey: null, shot: { ...current!.shot!, id: recovered.shot.id } })
        }
        throw error
      }
    }
    if (!current!.shot?.id) return current!
  }
  for (let index = 0; index < current.candidates.length; index++) {
    const candidate = current.candidates[index]
    if (candidate.jobId) continue
    const lookup = `${base}/generation-submissions/${encodeURIComponent(candidate.key)}`
    const found = await request<{ job: Job | null }>(lookup)
    if (found.job !== null && (typeof found.job?.id !== 'string' || !found.job.id)) throw new Error('无法确认已有生成任务，已停止提交')
    if (found.job) { await persist({ ...current, inFlightKey: current.inFlightKey === candidate.key ? null : current.inFlightKey,
      candidates: current.candidates.map((value, ordinal) => ordinal === index ? { ...value, jobId: found.job!.id } : value) }); continue }
    if (!options.allowSubmit || current.rejected || !active()) continue
    const body = { ...current.request, shot_id: current.shot?.id || current.request.shot_id || null }
    try {
      const job = await send<Job>(`${base}/generate`, candidate.key, body)
      if (typeof job?.id !== 'string' || !job.id) throw new Error('生成提交响应不完整，请检查已有任务')
      await persist({ ...current!, inFlightKey: null, candidates: current!.candidates.map((value, ordinal) => ordinal === index ? { ...value, jobId: job.id } : value) })
    } catch (error) {
      if (!current!.rejected) {
        const recovered = await request<{ job: Job | null }>(lookup).catch(() => null)
        if (typeof recovered?.job?.id === 'string') await persist({ ...current!, inFlightKey: null,
          candidates: current!.candidates.map((value, ordinal) => ordinal === index ? { ...value, jobId: recovered.job!.id } : value) })
      }
      throw error
    }
  }
  return current
}
