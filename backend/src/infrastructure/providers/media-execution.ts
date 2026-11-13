import { ProviderExecutionError } from './provider-failure.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { modelStepSignal } from '../../modules/generation/model-execution.js'

export type LocalMediaKind = 'image' | 'video' | 'audio' | 'text'
export type LocalMediaResult = { path: string; kind: LocalMediaKind; metadata?: Record<string, unknown> }
type MediaExecution = {
  signal?: AbortSignal
  beforeDispatch?: (requestId?: string) => void
  onLocalWriting?: (result: LocalMediaResult) => void
  onLocalResult?: (result: LocalMediaResult) => Promise<void>
}
const execution = new AsyncLocalStorage<MediaExecution>()
export function withMediaExecution<T>(context: MediaExecution, work: () => T): T { return execution.run(context, work) }
export function mediaExecutionSignal() { return modelStepSignal(execution.getStore()?.signal) }
export function beforeMediaDispatch(requestId?: string) {
  mediaExecutionSignal()?.throwIfAborted()
  execution.getStore()?.beforeDispatch?.(requestId)
  mediaExecutionSignal()?.throwIfAborted()
}
export function localMediaWriting(result: LocalMediaResult) {
  mediaExecutionSignal()?.throwIfAborted()
  execution.getStore()?.onLocalWriting?.(result)
}
export async function localMediaReady(result: LocalMediaResult) {
  mediaExecutionSignal()?.throwIfAborted()
  await execution.getStore()?.onLocalResult?.(result)
  mediaExecutionSignal()?.throwIfAborted()
}
export class MediaDownloadError extends ProviderExecutionError {
  readonly code = 'media_download_failed'
  constructor(public readonly http_status?: number) { super(`下载模型结果失败${http_status ? `（HTTP ${http_status}）` : ''}，已保留原任务和恢复信息，不会重新提交生成。`,
    { reason: 'protocol', stage: 'download', delivery: http_status ? 'rejected' : 'accepted', upstreamStatus: http_status, retryable: !http_status || [408, 429, 500, 502, 503, 504].includes(http_status) }) }
}
export function expiredMediaDownload(error: unknown): boolean {
  return error instanceof MediaDownloadError && [401, 403, 404, 410].includes(error.http_status || 0)
}
