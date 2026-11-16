import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'

/** Snapshot changes record observed application work, never model reasoning.
 * Called only by the same persistence paths as analysis state. GET/polling
 * cannot fabricate past steps, finish an operation or authorize a request. */
export function captureSourceRuntimeEvents(state: ScriptSourceAnalysis, timestamp = Date.now()): void {
  if (state.analysis_mode !== 'extract') return
  const terminal = ['ready', 'failed', 'paused'].includes(state.status)
  const stage = terminal ? state.status : state.progress?.stage || state.phase || 'reading'
  const label = terminal ? state.status === 'ready' ? '原文索引与全剧资料已保存' : state.status === 'paused' ? '分析已暂停，已有成果保留' : '当前分析未完成，已有成果保留'
    : state.progress?.message || (state.status === 'queued' ? '原稿已保存，等待分析' : '正在读取原稿')
  const events = state.runtime_events ??= [], previous = events.at(-1)
  if (previous?.stage === stage && previous.label === label && previous.status !== 'running') return
  if (previous?.stage === stage && previous.label === label && !terminal) return
  if (previous?.status === 'running') { previous.status = terminal && state.status !== 'ready' ? state.status === 'paused' ? 'cancelled' : 'failed' : 'succeeded'; previous.ended_at = timestamp }
  events.push({ id: `${state.id}:runtime:${(state.runtime_events_omitted || 0) + events.length}`, stage, label: label.slice(0, 1000),
    status: terminal ? state.status === 'ready' ? 'succeeded' : state.status === 'paused' ? 'cancelled' : 'failed' : 'running',
    started_at: timestamp, ...(terminal ? { ended_at: timestamp } : {}) })
  if (events.length > 512) { events.shift(); state.runtime_events_omitted = (state.runtime_events_omitted || 0) + 1 }
}
