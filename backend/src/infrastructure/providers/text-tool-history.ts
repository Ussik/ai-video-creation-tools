import { createHash } from 'node:crypto'
import type { GenerationModel, GenerationProvider, TextRequestMetrics } from './providers.js'
import type { ToolOutput } from './text-tools.js'

type Item = Record<string, unknown>
const isOutput = (item: Item) => item.role === 'tool' || item.type === 'function_call_output'
const field = (item: Item) => item.role === 'tool' ? 'content' : 'output'

/** Keep native call/result pairs. An identical payload lives once, in the most
 * recent output; older outputs explicitly point to that real call. */
export function deduplicateToolHistory(history: unknown[], outputs: ToolOutput[]): unknown[] {
  const seen = new Map<string, string>()
  const bodies = new Map<string, { call: string; path: string }>()
  const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex')
  const visit = (value: unknown, call: string, path: string, replace: boolean): unknown => {
    if (Array.isArray(value)) return value.map((item, index) => visit(item, call, `${path}[${index}]`, replace))
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (typeof item === 'string' && item.length > 256 && ['content', 'excerpt', 'action', 'dialogue', 'narration'].includes(key)) {
        const hash = fingerprint(item), newer = bodies.get(hash)
        if (replace && newer) return [key, `【相同正文已保留在调用 ${newer.call} 的 ${newer.path}；这里只省略逐字相同正文，版本、范围和状态以本结果为准】`]
        bodies.set(hash, { call, path: `${path}.${key}` })
        return [key, item]
      }
      return [key, visit(item, call, `${path}.${key}`, replace)]
    }))
  }
  for (const output of outputs.slice().reverse()) if (output.output.length > 256) {
    try { const value = JSON.parse(output.output); if (value.ok !== false) { seen.set(fingerprint(output.output), output.id); visit(value, output.id, '$', false) } } catch { /* Non-JSON output remains intact. */ }
  }
  return history.slice().reverse().map(raw => {
    if (!raw || typeof raw !== 'object') return raw
    const item = raw as Item, key = field(item), text = item[key]
    if (!isOutput(item) || typeof text !== 'string' || text.length <= 256) return raw
    let value: { ok?: boolean; result?: unknown }
    try { value = JSON.parse(text) } catch { return raw }
    if (value.ok === false) return raw
    const hash = fingerprint(text), next = seen.get(hash)
    if (next) return { ...item, [key]: JSON.stringify({ ok: value.ok, duplicate_of_call: next,
      note: '该结果与后续调用完全相同，完整数据保留在该调用结果中。' }) }
    const call = String(item.tool_call_id || item.call_id)
    seen.set(hash, call)
    return { ...item, [key]: JSON.stringify(visit(value, call, '$', true)) }
  }).reverse()
}

const checkpointPrefix = '程序上下文检查点'
const checkpointLimit = 10000
const checkpointDescription = '（程序提取的历史工具元数据，不是原文或新增授权；正文和部分旧记录已省略。精确引用须用原参数重读，禁止把摘要当作已保存或已核对证据）：\n'
const metadataField = /(?:^|_)(?:id|ids|version|versions|hash|fingerprint|offset|length|count|complete|status|saved|reviewed|pending|ready|ok|error|code|retryable|repair|batch|title|kind|mode|type|name|summary|outcome)$/
type Reference = { tool: string; call_id?: string; arguments?: string; arguments_omitted?: true; arguments_metadata?: unknown; result?: unknown }
type Checkpoint = { format: 'tool_history_metadata_v1'; references: Reference[]; omitted_records: number }

/** Extract exact locator/state/error values, never a generated account of what
 * the source says. Bodies remain available through the original read tool. */
function resultMetadata(value: unknown) {
  const facts: Array<{ path: string; value: unknown }> = []
  let size = 0, omitted = 0
  const visit = (item: unknown, path: string, key: string, depth: number) => {
    if (depth > 10) { omitted++; return }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      // IDs, versions and pagination precede optional titles/summaries when the
      // metadata budget is full. Object traversal never executes source text.
      const entries = Object.entries(item).sort(([a], [b]) => Number(/summary|title|name/.test(a)) - Number(/summary|title|name/.test(b)))
      for (const [name, child] of entries) visit(child, `${path}.${name}`, name, depth + 1)
      return
    }
    if (Array.isArray(item) && !metadataField.test(key)) {
      for (const [index, child] of item.slice(0, 100).entries()) visit(child, `${path}[${index}]`, key, depth + 1)
      if (item.length > 100) omitted += item.length - 100
      return
    }
    if (!metadataField.test(key)) return
    const fact = { path, value: item }, length = JSON.stringify(fact).length
    if (length > 1600 || size + length > 4000) { omitted++; return }
    facts.push(fact); size += length
  }
  visit(value, '$', '', 0)
  return { facts, content_omitted: true, ...(omitted ? { omitted_fields: omitted } : {}) }
}

function checkpointValue(item: Item): Partial<Checkpoint> | undefined {
  if (item.role !== 'user' || typeof item.content !== 'string' || !item.content.startsWith(checkpointPrefix)) return
  try {
    const value = JSON.parse(item.content.slice(item.content.indexOf('\n') + 1)) as Partial<Checkpoint>
    if (Array.isArray(value.references)) return value
  } catch { /* Not a program checkpoint; preserve the user message verbatim. */ }
}

/** Keep one complete native exchange plus the pending assistant batch intact.
 * An unusually large latest result may itself exceed the preferred threshold;
 * older tool history is still bounded rather than accumulating without limit. */
function retainedExchangeStart(history: unknown[], initialLength: number, pending: number) {
  let end = pending - 1
  while (end >= initialLength && (history[end] as Item)?.role === 'user') end--
  if (end < initialLength || !isOutput(history[end] as Item)) return pending
  while (end >= initialLength && isOutput(history[end] as Item)) end--
  while (end > initialLength && (history[end - 1] as Item)?.role !== 'user' && !isOutput(history[end - 1] as Item)) end--
  return Math.max(initialLength, end)
}

export async function compactToolHistory(history: unknown[], initialLength: number, model: GenerationModel, _provider: GenerationProvider,
  _key: (provider: GenerationProvider) => string, signal?: AbortSignal, _onMetrics?: (metrics: TextRequestMetrics) => void,
  /** Set when the complete next request is close to the model's stated context capacity: compact whatever can be
   * compacted now, regardless of the character threshold. Still no model call. */
  pressure = false) {
  signal?.throwIfAborted()
  const settings = typeof model.settings === 'string' ? JSON.parse(model.settings) as Record<string, unknown> : model.settings
  const requested = Number(settings.tool_history_chars)
  const limit = Number.isFinite(requested) && requested >= 16000 ? Math.min(requested, 120000) : 48000
  if (!pressure && JSON.stringify(history.slice(initialLength)).length < limit) return history
  let pending = history.length - 1
  if (model.protocol === 'responses') {
    while (pending > initialLength && (history[pending - 1] as Item)?.role !== 'user' && !isOutput(history[pending - 1] as Item)) pending--
  }
  const retained = retainedExchangeStart(history, initialLength, pending)
  const previous = history.slice(initialLength, retained)
  if (!previous.length) return history
  const references: Reference[] = [], instructions: unknown[] = []
  const calls = new Map<string, Reference>()
  let omitted = 0
  for (const raw of previous) {
    signal?.throwIfAborted()
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Item, checkpoint = checkpointValue(item)
    if (checkpoint) {
      references.push(...checkpoint.references!.filter(reference => typeof reference.tool === 'string'))
      omitted += Number(checkpoint.omitted_records) || 0
      continue
    }
    // Continuation instructions retain their exact wording and authority. Only
    // identical messages are deduplicated, never interpreted as new permission.
    if (item.role === 'user') {
      if (!instructions.some(previous => JSON.stringify(previous) === JSON.stringify(raw))) instructions.push(raw)
      continue
    }
    const nativeCalls = item.type === 'function_call' ? [{ id: item.call_id, name: item.name, arguments: item.arguments }]
      : Array.isArray(item.tool_calls) ? (item.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>).map(call => ({ id: call.id, ...call.function })) : []
    for (const call of nativeCalls) {
      const args = String(call.arguments || '')
      const reference: Reference = { tool: String(call.name), call_id: String(call.id) }
      if (args.length <= 2400) reference.arguments = args
      else {
        reference.arguments_omitted = true
        try { reference.arguments_metadata = resultMetadata(JSON.parse(args)) } catch { /* Long non-JSON arguments cannot be replayed. */ }
      }
      calls.set(String(call.id), reference)
    }
    if (!isOutput(item)) continue
    const callId = String(item.tool_call_id || item.call_id), reference = calls.get(callId)
    if (!reference) { omitted++; continue }
    const body = item[field(item)]
    try { reference.result = resultMetadata(typeof body === 'string' ? JSON.parse(body) : body) }
    catch { reference.result = { content_omitted: true, non_json_output: true } }
    references.push(reference); calls.delete(callId)
  }
  // Most recent exact duplicate metadata wins. The checkpoint itself is always
  // bounded, including under repeated compaction and very large tool arguments.
  const unique = new Map<string, Reference>()
  for (const reference of references) {
    const identity = JSON.stringify({ ...reference, call_id: undefined })
    if (unique.has(identity)) { unique.delete(identity); omitted++ }
    unique.set(identity, reference)
  }
  const state: Checkpoint = { format: 'tool_history_metadata_v1', references: [], omitted_records: omitted }
  const message = () => ({ role: 'user', content: checkpointPrefix + checkpointDescription + JSON.stringify(state) })
  for (const reference of [...unique.values()].reverse()) {
    state.references.unshift(reference)
    if (JSON.stringify(message()).length > checkpointLimit) { state.references.shift(); state.omitted_records++ }
  }
  // Accounting digits can grow while records are omitted; enforce the bound on
  // the final serialization too rather than trusting an LLM output contract.
  while (JSON.stringify(message()).length > checkpointLimit && state.references.length) { state.references.shift(); state.omitted_records++ }
  return [...history.slice(0, initialLength), ...instructions, message(), ...history.slice(retained)]
}

/** Share of the stated context window above which the complete next request counts as under pressure. */
export const contextPressureShare = 0.8

/** Native Messages compaction removes only complete old call/result exchanges.
 * Retained signed thinking blocks and the latest pending call stay byte-for-byte
 * intact. An unpaired or mixed result is kept verbatim instead of guessed. */
export function compactNativeToolHistory(history: unknown[], initialLength: number, pressure = false): unknown[] {
  if (!pressure && JSON.stringify(history.slice(initialLength)).length < 48000) return history
  // Channel binding rules for signed/opaque reasoning are unknown. Do not
  // rewrite even its prefix until a native compaction contract is available.
  if (history.some(raw => {
    const content = (raw as Item)?.content
    return Array.isArray(content) && content.some(block => { const item = block as Item; return item.type === 'thinking' || item.type === 'redacted_thinking' || item.signature !== undefined || item.type === 'reasoning' })
  })) return history
  const pairs: Array<{ start: number; end: number; references: Reference[] }> = []
  for (let index = initialLength; index < history.length - 1; index++) {
    const assistant = history[index] as Item | undefined, user = history[index + 1] as Item | undefined
    if (assistant?.role !== 'assistant' || !Array.isArray(assistant.content) || user?.role !== 'user' || !Array.isArray(user.content)) continue
    const calls = (assistant.content as Item[]).filter(item => item.type === 'tool_use')
    const results = (user.content as Item[]).filter(item => item.type === 'tool_result')
    if ((assistant.content as Item[]).some(item => item.type !== 'tool_use') || !calls.length || results.length !== calls.length || new Set(calls.map(call => call.id)).size !== calls.length ||
      new Set(results.map(result => result.tool_use_id)).size !== calls.length ||
      calls.some(call => !results.some(result => result.tool_use_id === call.id)) ||
      (user.content as Item[]).some(item => item.type !== 'tool_result')) continue
    pairs.push({ start: index, end: index + 2, references: calls.map(call => ({ tool: String(call.name), call_id: String(call.id),
      arguments_metadata: resultMetadata(call.input), result: resultMetadata(results.find(result => result.tool_use_id === call.id)?.content) })) })
    index++
  }
  // Keep a whole latest exchange plus the pending assistant response. No lone
  // result can survive after its signed assistant block has been removed.
  const removing = pairs.slice(0, -1)
  if (!removing.length) return history
  const removed = new Set(removing.flatMap(pair => [pair.start, pair.start + 1]))
  const state: Checkpoint = { format: 'tool_history_metadata_v1', references: removing.flatMap(pair => pair.references), omitted_records: 0 }
  const message = () => ({ role: 'user', content: checkpointPrefix + checkpointDescription + JSON.stringify(state) })
  while (JSON.stringify(message()).length > checkpointLimit && state.references.length) { state.references.shift(); state.omitted_records++ }
  const first = removing[0]!.start
  return history.flatMap((item, index) => index === first ? [message()] : removed.has(index) ? [] : [item])
}
