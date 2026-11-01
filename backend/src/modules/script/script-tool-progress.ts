import { createHash } from 'node:crypto'

export type ScriptToolProgressDecision = {
  action: 'continue' | 'warn' | 'stop'
  reason?: 'repeated_failure' | 'no_progress' | 'draft_cycle' | 'empty_response' | 'incomplete_response'
  message?: string
  instruction?: string
}

/** Only hashes and counters are retained; manuscript text is never copied into
 * this checkpoint. The caller owns the task/authorization boundary. */
export type ScriptToolProgressHistory = {
  states: string[]
  drafts: string[]
  evidence: string[]
  current_state?: string
  current_draft?: string
  failures: Array<[string, number]>
  no_progress: number
  unfinished_responses: number
  empty_responses: number
  ranges: Array<[string, Array<[number, number]>]>
}

type ProgressState = { state?: unknown; draftState?: unknown }
export type ScriptToolProgressObservation = ProgressState & {
  name: string
  arguments?: unknown
  ok: boolean
  result?: unknown
  error?: unknown
}

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const noise = new Set(['version', 'draft_version', 'updated_at', 'created_at', 'started_at', 'timestamp', 'summary', 'note', 'notes',
  'batches', 'replacements', 'explanation', 'reason'])
function canonical(value: unknown, ignored?: Set<string>): string {
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, ignored)).join(',')}]`
  if (value && typeof value === 'object') {
    if (value instanceof Error) return canonical({ ...value, message: value.message }, ignored)
    const data = value as Record<string, unknown>
    return `{${Object.keys(data).filter(key => data[key] !== undefined && !ignored?.has(key)).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(data[key], ignored)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
const hash = (value: unknown, ignored?: Set<string>) => createHash('sha256').update(canonical(value, ignored)).digest('hex')
const continueDecision: ScriptToolProgressDecision = { action: 'continue' }
const instruction = '沿用现有草稿和已授权决定，先查看未完成项与下一段未读范围；改变具体失败参数或处理方式，再执行剩余事项。不得重放相同请求、重建任务或自动保存。'

/** Detect repeated work rather than imposing a request, token or round quota.
 * `state` must include semantic progress (effective text, read coverage and
 * review results), excluding opaque draft IDs, timestamps and status prose.
 * `draftState` omits read coverage so rereading cannot disguise A -> B -> A.
 * Call finish only when the model ends an already-incomplete revision. */
export function createScriptToolProgress(initial: ProgressState & { history?: ScriptToolProgressHistory } = {}) {
  const previous = initial.history
  const states = new Set(previous?.states), drafts = new Set(previous?.drafts), evidence = new Set(previous?.evidence)
  const failures = new Map(previous?.failures), ranges = new Map(previous?.ranges.map(([key, value]) => [key, value.map(([from, to]) => [from, to] as [number, number])]))
  let currentState = previous?.current_state, currentDraft = previous?.current_draft
  let noProgress = previous?.no_progress || 0, unfinishedResponses = previous?.unfinished_responses || 0, emptyResponses = previous?.empty_responses || 0
  if (own(initial, 'state')) { currentState = hash(initial.state); states.add(currentState) }
  if (own(initial, 'draftState')) { currentDraft = hash(initial.draftState); drafts.add(currentDraft) }

  function inspectState(input: ProgressState) {
    let progress = false, cycle = false
    if (own(input, 'state')) {
      const next = hash(input.state)
      if (next !== currentState && !states.has(next)) progress = true
      states.add(next); currentState = next
    }
    if (own(input, 'draftState')) {
      const next = hash(input.draftState)
      if (next !== currentDraft) {
        cycle = drafts.has(next)
        if (!cycle) {
          progress = true
          // A real content/review change can require a new global consistency
          // pass over unchanged documents. Reads are new evidence once in that
          // semantic epoch, while read-coverage changes alone never reset it.
          evidence.clear(); ranges.clear()
        }
      }
      drafts.add(next); currentDraft = next
    }
    return { progress, cycle }
  }
  function reset() { noProgress = 0; unfinishedResponses = 0; emptyResponses = 0; failures.clear() }
  function seen(value: unknown) {
    const key = hash(value, noise)
    if (evidence.has(key)) return false
    evidence.add(key)
    return true
  }
  function readRange(key: string, from: unknown, to: unknown) {
    if (typeof from !== 'number' || typeof to !== 'number' || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) return false
    const old = ranges.get(key) || []
    // An empty document is new evidence once; a changed length alone is not.
    const newRange = !old.length || !old.some(([start, end]) => start <= from && end >= to)
    if (!newRange) return false
    const merged: Array<[number, number]> = []
    for (const range of [...old, [from, to] as [number, number]].sort(([left], [right]) => left - right)) {
      const last = merged.at(-1)
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
      else merged.push([...range])
    }
    ranges.set(key, merged)
    return true
  }
  function readEvidence(name: string, args: unknown, result: unknown) {
    const value = record(result), input = record(args)
    if (!value) return false
    if (name === 'read_documents') {
      let changed = false
      for (const raw of Array.isArray(value.documents) ? value.documents : []) {
        const doc = record(raw)
        if (!doc) continue
        const key = `document:${doc.source ?? input?.source ?? 'saved'}:${doc.id}:${doc.version}`
        changed = readRange(key, doc.offset, doc.next_offset) || changed
        for (const scene of Array.isArray(doc.scenes) ? doc.scenes : []) changed = seen({ kind: 'scene', scene }) || changed
        for (const rawFragment of Array.isArray(doc.scene_fragments) ? doc.scene_fragments : []) {
          const fragment = record(rawFragment)
          if (fragment) changed = readRange(`scene:${fragment.id}:${fragment.version}`, fragment.offset, fragment.next_offset) || changed
        }
      }
      return changed
    }
    if (name === 'read_source_document' || name === 'read_full_source_document') return readRange(`source:${value.source_version}`, value.offset, value.next_offset)
    if (name === 'read_episode_scenes') {
      let changed = false
      for (const scene of Array.isArray(value.scenes) ? value.scenes : []) changed = seen({ kind: 'scene', scene }) || changed
      if (!Array.isArray(value.scenes) || !value.scenes.length) changed = seen({ kind: 'empty_scenes', episode: value.episode_number }) || changed
      return changed
    }
    // Repeated writes can mint new draft versions and prose summaries without
    // changing anything. Their progress is determined only by the caller state.
    const readOnly = name.startsWith('get_') || name.startsWith('read_') || name.startsWith('search_') || name === 'find_related_content' || name === 'load_creation_skills'
      || (name === 'manage_revision_task' || name === 'manage_document_draft') && input?.operation === 'read'
    return readOnly && seen({ name, result: value })
  }
  function stalled(reason: NonNullable<ScriptToolProgressDecision['reason']>, stop: boolean): ScriptToolProgressDecision {
    const message = reason === 'repeated_failure' ? '相同操作和参数已重复失败，未获得新的有效结果；已停止重复请求并保留当前草稿。'
      : reason === 'draft_cycle' ? '修订回到了本轮已处理过的相同正文与核对状态，已停止循环并保留当前草稿。'
      : reason === 'empty_response' ? '模型连续返回空回复，且没有新增读取、修订或核对进展；已保留当前草稿。'
      : reason === 'incomplete_response' ? '模型重复结束回复，但剩余修订与核对没有进展；已保留当前草稿。'
      : '连续操作没有新增已读范围、有效修订或核对结果，已停止重复处理并保留当前草稿。'
    const warning = reason === 'repeated_failure' ? '相同操作和参数再次失败，请根据真实错误改变参数或处理方式。'
      : reason === 'incomplete_response' || reason === 'empty_response' ? '任务尚未完成，请继续执行剩余修订与核对，不能仅返回进度说明。'
      : '近期操作没有新增已读范围、有效修订或核对结果，请转向下一未完成项。'
    return { action: stop ? 'stop' : 'warn', reason, message: stop ? message : warning, instruction }
  }
  return {
    observe(input: ScriptToolProgressObservation): ScriptToolProgressDecision {
      const state = inspectState(input)
      if (state.cycle) return stalled('draft_cycle', true)
      const newEvidence = input.ok && readEvidence(input.name, input.arguments, input.result)
      const progress = state.progress || newEvidence
      if (progress) reset()
      if (!input.ok) {
        const failure = record(input.error)
        const error = failure ? { code: failure.code, message: failure.code ? undefined : failure.message } : input.error
        const key = hash({ name: input.name, arguments: input.arguments, error }, new Set(['task_id', 'draft_id', 'version', 'draft_version']))
        const count = (failures.get(key) || 0) + 1
        failures.set(key, count); noProgress++
        if (count >= 3) return stalled('repeated_failure', true)
        if (noProgress >= 5) return stalled('no_progress', true)
        if (count >= 2) return stalled('repeated_failure', false)
      } else if (!progress) noProgress++
      if (noProgress >= 5) return stalled('no_progress', true)
      if (noProgress >= 3) return stalled('no_progress', false)
      return continueDecision
    },
    finish(input: ProgressState & { text?: string } = {}): ScriptToolProgressDecision {
      const state = inspectState(input)
      if (state.cycle) return stalled('draft_cycle', true)
      if (state.progress) reset()
      unfinishedResponses++; noProgress++
      emptyResponses = input.text?.trim() ? 0 : emptyResponses + 1
      return stalled(emptyResponses >= 2 ? 'empty_response' : 'incomplete_response', unfinishedResponses >= 2 || noProgress >= 5)
    },
    snapshot(): ScriptToolProgressHistory {
      return { states: [...states], drafts: [...drafts], evidence: [...evidence], current_state: currentState, current_draft: currentDraft,
        failures: [...failures], no_progress: noProgress, unfinished_responses: unfinishedResponses, empty_responses: emptyResponses,
        ranges: [...ranges].map(([key, value]) => [key, value.map(([from, to]) => [from, to])]) }
    },
  }
}
