import { acquireModelChannel, modelChannelIdentity, type ModelChannelLease } from './model-channel.js'
import { createTextTransportBoundary, textHeadersTimeoutMs, readTextErrorBody, readTextResponseBody } from './text-transport-boundary.js'
import { assertTextFrameBoundary } from './text-frame-boundary.js'
import type { GenerationModel, GenerationProvider, TextRequestMetrics, TextStreamEvent, TextStreamRequest } from './providers.js'
import type { TextTool, ToolCall, ToolOutput, ToolTurn } from './text-tools.js'
import { createStreamScope, generationStepBudgets, textRequestTimeoutMs, textReasoningIdleTimeoutMs, textStreamIdleTimeoutMs } from '@video-studio/shared/script/script-stream-policy'
import { isUnrestrictedScriptExecution, modelStepSignal } from '../../modules/generation/model-execution.js'
import { prepareTextRequest, textRequestTrace, notifyTextRequest } from './text-request-plan.js'
import { beginTextRequest } from './text-request-usage.js'
import { parseTextUsage, requestPurpose } from './text-usage-parse.js'
import { TextOutputLimitError, TextProviderError, TextToolOutputLimitError, transientTextNetworkError, annotateTextFailure } from './text-errors.js'
import { textImageCapacityBody, withTextImageInput } from './text-image-input.js'
import { currentModelRequestContext } from '../../modules/generation/model-task-policy.js'
import { strictJsonSchema } from '../../modules/generation/model-output.js'

type Item = Record<string, unknown>
const record = (value: unknown): value is Item => !!value && typeof value === 'object' && !Array.isArray(value)
type Input = {
  model: GenerationModel; provider: GenerationProvider; settings: Item; base: unknown; url: string; key: string;
  request: TextStreamRequest; signal?: AbortSignal; onEvent?: (event: TextStreamEvent) => void | Promise<void>;
  onMetrics?: (metrics: TextRequestMetrics) => void; onDispatch?: (metrics: TextRequestMetrics) => void;
  httpError: (response: Response, raw: string, url: string, started: number, model: string, secrets: string[]) => Error;
  tool?: { tools: TextTool[]; previous?: unknown[]; outputs: ToolOutput[]; continuation?: string; parallelCalls?: boolean;
    onText?: (text: string) => void };
}

function messages(value: unknown): Item[] {
  if (!Array.isArray(value) || !value.length || value.some(item => !record(item) || !['user', 'assistant'].includes(String(item.role)) ||
    !(typeof item.content === 'string' || Array.isArray(item.content)))) throw new Error('Anthropic Messages 请求必须包含原生 user/assistant messages')
  return structuredClone(value) as Item[]
}

/** Native Messages keeps signed thinking blocks private in assistant history.
 * Only text blocks become visible; incomplete tool arguments never execute. */
export async function requestAnthropicText(input: Input): Promise<{ text: string; turn?: ToolTurn }> {
  if (!record(input.base)) throw new Error('Anthropic Messages 请求模板必须为对象')
  const { settings, model, tool } = input
  if (input.request.video) throw new Error('Anthropic Messages 尚不支持视频输入，请选择已支持的视频理解协议')
  const base = { ...input.base }
  const initial = messages(base.messages)
  const history = messages(tool?.previous || initial)
  if (tool?.outputs.length) history.push({ role: 'user', content: tool.outputs.map(output => ({ type: 'tool_result', tool_use_id: output.id, content: output.output })) })
  if (tool?.continuation) history.push({ role: 'user', content: tool.continuation })
  const body: Item = { ...base, messages: history, stream: base.stream !== false && settings.stream !== false }
  if (tool) {
    if (record(body.output_config)) { body.output_config = { ...body.output_config }; delete (body.output_config as Item).format }
    const strict = settings.strict_tool_arguments === true
    body.tools = tool.tools.map(item => ({ name: item.name, description: item.description,
      input_schema: strict ? strictJsonSchema(item.parameters) : item.parameters, ...(strict ? { strict: true } : {}) }))
    body.tool_choice = { type: 'auto', disable_parallel_tool_use: tool.parallelCalls !== true }
  } else if (input.request.structured_output && settings.structured_output_mode && settings.structured_output_mode !== 'prompt') {
    if (settings.structured_output_mode !== 'json_schema') throw new Error('Anthropic Messages 结构化输出仅支持 prompt 或 json_schema')
    body.output_config = { ...(record(body.output_config) ? body.output_config : {}), format: { type: 'json_schema', schema: input.request.structured_output.schema } }
  }
  const outgoing = withTextImageInput(body, input.request.images, 'anthropic_messages', settings) as Item
  const customAuth = input.provider.auth_header && (input.provider.auth_header.toLowerCase() !== 'authorization' || (input.provider.auth_prefix ?? 'Bearer ') !== 'Bearer ')
  const header = customAuth ? input.provider.auth_header! : 'x-api-key'
  const prefix = customAuth ? input.provider.auth_prefix ?? '' : ''
  const headers = { 'anthropic-version': '2023-06-01', ...(input.key ? { [header]: prefix + input.key } : {}) }
  const planned = await prepareTextRequest(settings, outgoing, 'anthropic_messages', {
    modelId: model.id, purpose: tool ? 'tool_decision' : requestPurpose(input.request.structured_output?.name), url: input.url, headers, signal: modelStepSignal(input.signal),
    estimateBody: input.request.images?.length ? textImageCapacityBody(outgoing) : outgoing, visualInputTokens: (input.request.images?.length || 0) * 4096,
  })
  const capacity = planned.capacity
  const cap = (planned.body as Item).max_tokens
  if (typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap <= 0) throw new Error('Anthropic Messages 必须明确填写最大输出 token 数')
  const rawBody = JSON.stringify(planned.body)
  const metrics: TextRequestMetrics = { ...textRequestTrace(), model_id: model.id, remote_id: typeof planned.body.model === 'string' ? planned.body.model : model.remote_id, output_parameter: 'max_tokens', endpoint: new URL(input.url).origin + new URL(input.url).pathname, delivery: 'not_sent', request_bytes: Buffer.byteLength(rawBody), output_limit: cap,
    request_purpose: currentModelRequestContext()?.policy.purpose ?? (tool ? 'tool_decision' : requestPurpose(input.request.structured_output?.name)), ...capacity }
  const started = Date.now()
  const scope = createStreamScope(modelStepSignal(input.signal), {
    totalMs: isUnrestrictedScriptExecution() ? null : input.request.structured_output ? textRequestTimeoutMs : generationStepBudgets.discussion,
    idleMessage: '模型接口长时间没有返回事件，当前步骤已停止，已完成结果保留。', totalMessage: '文本模型请求超时，已保留完成步骤。',
  })
  const eventTimeout = body.thinking || body.stream === false ? textReasoningIdleTimeoutMs : textStreamIdleTimeoutMs
  const transport = createTextTransportBoundary(scope, { autoStart: false, headersMs: body.stream === true ? textHeadersTimeoutMs : textRequestTimeoutMs,
    firstEventMs: eventTimeout, idleMs: isUnrestrictedScriptExecution() ? undefined : eventTimeout })
  let channel: ModelChannelLease | undefined
  let usage: ReturnType<typeof beginTextRequest> | undefined
  const blocks = new Map<number, Item>()
  const closedBlocks = new Set<number>()
  const argumentsByBlock = new Map<number, string>()
  let text = '', stopReason: string | null = null, complete = false
  const setUsage = (value: unknown) => {
    const parsed = parseTextUsage(value)
    if (record(value)) {
      const read = value.cache_read_input_tokens, write = value.cache_creation_input_tokens
      if (typeof read === 'number' && Number.isSafeInteger(read) && read >= 0) parsed.cache_read_tokens = read
      if (typeof write === 'number' && Number.isSafeInteger(write) && write >= 0) parsed.cache_write_tokens = write
      if (parsed.input_tokens !== undefined && (parsed.cache_read_tokens !== undefined || parsed.cache_write_tokens !== undefined)) parsed.input_tokens += (parsed.cache_read_tokens || 0) + (parsed.cache_write_tokens || 0)
    }
    Object.assign(metrics, parsed)
  }
  const emitText = async (delta: string) => {
    text += delta; metrics.response_chars = text.length; metrics.output_started = !!text
    if (!delta) return
    if (tool) tool.onText?.(text)
    else await input.onEvent?.({ type: 'delta', text: delta })
  }
  const consume = async (payload: unknown) => {
    if (!record(payload)) throw new TextProviderError('上游未返回有效 Messages 响应', false, 'bad_response_body')
    transport.event(); metrics.first_event_ms ??= Date.now() - started
    if (payload.type === 'error' || payload.error) {
      const error = record(payload.error) ? payload.error : {}
      const code = typeof error.type === 'string' ? error.type : 'anthropic_error'
      throw new TextProviderError(`模型生成失败（${code}），已完成结果保留。`, ['overloaded_error', 'rate_limit_error', 'api_error'].includes(code), code)
    }
    if (payload.type === 'message_start') {
      if (!record(payload.message)) throw new TextProviderError('Messages 开始事件无效', false, 'bad_response_body')
      setUsage(payload.message.usage)
    } else if (payload.type === 'content_block_start') {
      if (!Number.isSafeInteger(payload.index) || Number(payload.index) < 0 || blocks.has(Number(payload.index)) || !record(payload.content_block)) throw new TextProviderError('Messages 内容单元标识无效', false, 'bad_response_body')
      const block = structuredClone(payload.content_block)
      blocks.set(Number(payload.index), block)
      if (block.type === 'text' && typeof block.text === 'string') await emitText(block.text)
    } else if (payload.type === 'content_block_delta') {
      const index = Number(payload.index), block = blocks.get(index), delta = payload.delta
      if (!block || closedBlocks.has(index) || !record(delta)) throw new TextProviderError('Messages 内容增量缺少对应的未闭合单元', false, 'bad_response_body')
      if (delta.type === 'text_delta' && block.type === 'text' && typeof delta.text === 'string') {
        block.text = String(block.text || '') + delta.text; await emitText(delta.text)
      } else if (delta.type === 'input_json_delta' && block.type === 'tool_use' && typeof delta.partial_json === 'string') {
        const args = (argumentsByBlock.get(index) || '') + delta.partial_json
        if (args.length > 650000) throw new TextProviderError('模型工具参数超过容量，未执行调用', false, 'invalid_tool_call')
        argumentsByBlock.set(index, args)
      } else if (delta.type === 'thinking_delta' && block.type === 'thinking' && typeof delta.thinking === 'string') block.thinking = String(block.thinking || '') + delta.thinking
      else if (delta.type === 'signature_delta' && block.type === 'thinking' && typeof delta.signature === 'string') block.signature = String(block.signature || '') + delta.signature
    } else if (payload.type === 'content_block_stop') {
      const index = Number(payload.index)
      if (!blocks.has(index) || closedBlocks.has(index)) throw new TextProviderError('Messages 内容单元结束事件无效', false, 'bad_response_body')
      closedBlocks.add(index)
    } else if (payload.type === 'message_delta') {
      setUsage(payload.usage)
      if (record(payload.delta) && typeof payload.delta.stop_reason === 'string') stopReason = payload.delta.stop_reason
    } else if (payload.type === 'message_stop') complete = true
    else if (payload.type === 'message') {
      if (!Array.isArray(payload.content)) throw new TextProviderError('Messages 响应缺少内容', false, 'bad_response_body')
      for (const [index, block] of payload.content.entries()) {
        if (!record(block)) throw new TextProviderError('Messages 响应包含无效内容', false, 'bad_response_body')
        blocks.set(index, structuredClone(block))
        closedBlocks.add(index)
        if (block.type === 'text' && typeof block.text === 'string') await emitText(block.text)
      }
      setUsage(payload.usage); stopReason = typeof payload.stop_reason === 'string' ? payload.stop_reason : null; complete = true
    }
  }
  try {
    scope.signal.throwIfAborted()
    channel = await acquireModelChannel(modelChannelIdentity(typeof settings.api_base_url === 'string' ? settings.api_base_url : input.provider.base_url,
      'anthropic_messages', header, input.key ? prefix + input.key : ''), transport.signal)
    transport.signal.throwIfAborted(); transport.start()
    usage = beginTextRequest({ request_bytes: metrics.request_bytes, estimated_input_tokens: capacity.estimated_input_tokens, reserved_output_tokens: cap })
    notifyTextRequest('dispatch', { ...metrics }, input.onDispatch)
    metrics.delivery = 'unknown'
    const response = await transport.wait(fetch(input.url, { method: 'POST', headers: {
      'Content-Type': 'application/json', Accept: 'text/event-stream, application/json', ...headers,
    }, body: rawBody, signal: transport.signal }))
    transport.headers(); channel.response(response); metrics.http_status = response.status; metrics.delivery = response.ok ? 'accepted' : 'rejected'
    const requestId = response.headers.get('request-id') || response.headers.get('x-request-id')
    if (requestId && /^[a-zA-Z0-9_.:-]{1,160}$/.test(requestId)) metrics.upstream_request_id = requestId
    if (!response.ok) throw input.httpError(response, await readTextErrorBody(response, { wait: transport.wait, onChunk: transport.event }), input.url, started, model.remote_id, [input.key, prefix + input.key])
    if (response.headers.get('content-type')?.includes('text/event-stream') && response.body) {
      const reader = response.body.getReader(), decoder = new TextDecoder()
      let buffer = ''
      const frame = async (value: string) => {
        assertTextFrameBoundary(value)
        const data = value.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data) return
        let payload: unknown
        try { payload = JSON.parse(data) } catch { throw new TextProviderError('Messages 流事件不是有效 JSON', false, 'bad_response_body') }
        await consume(payload)
      }
      try {
        while (!complete && stopReason !== 'max_tokens' && stopReason !== 'refusal') {
          const next = await transport.wait(reader.read())
          buffer += decoder.decode(next.value || new Uint8Array(), { stream: !next.done })
          const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() || ''; assertTextFrameBoundary(buffer)
          for (const value of frames) { await frame(value); if (complete || stopReason === 'max_tokens' || stopReason === 'refusal') break }
          if (next.done) break
        }
        if (!complete && stopReason !== 'max_tokens' && stopReason !== 'refusal' && buffer.trim()) await frame(buffer)
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
    } else {
      const raw = await readTextResponseBody(response, { wait: transport.wait, onChunk: transport.event })
      let payload: unknown
      try { payload = JSON.parse(raw) } catch { throw new TextProviderError('上游未返回有效 Messages 响应', false, 'bad_response_body') }
      await consume(payload)
    }
    metrics.raw_reason = stopReason ?? undefined
    if (stopReason === 'max_tokens') {
      const failure = tool ? new TextToolOutputLimitError('max_output_tokens', metrics, cap, text) : new TextOutputLimitError(text, 'max_output_tokens', metrics, cap)
      metrics.output_limit_reason = failure.reason; metrics.output_limit_kind = failure.outputLimitKind
      throw failure
    }
    if (stopReason === 'refusal') throw new TextProviderError('模型输出被内容审核中断', false, 'content_filter')
    if (!complete || !stopReason) throw new TextProviderError('Messages 连接提前结束，未收到完整结束事件，已完成结果保留。', true, 'stream_disconnected')
    if ([...blocks.keys()].some(index => !closedBlocks.has(index))) throw new TextProviderError('Messages 响应含未闭合内容单元，未执行工具调用', false, 'bad_response_body')
    if (!['end_turn', 'stop_sequence', ...(tool ? ['tool_use'] : [])].includes(stopReason)) throw new TextProviderError(
      stopReason === 'refusal' ? '模型输出被内容审核中断' : `模型输出异常结束（${stopReason}），未执行工具调用`, false, stopReason === 'refusal' ? 'content_filter' : stopReason)
    const content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([index, block]): Item => {
      if (block.type === 'tool_use' && argumentsByBlock.has(index)) {
        try { return { ...block, input: JSON.parse(argumentsByBlock.get(index)!) } }
        catch { throw new TextProviderError('模型返回的工具参数不完整，未执行调用', false, 'invalid_tool_call') }
      }
      return block
    })
    const calls: ToolCall[] = content.filter(block => block.type === 'tool_use').map(block => ({ id: String(block.id || ''), name: String(block.name || ''), arguments: JSON.stringify(block.input) }))
    if (calls.length > 10 || calls.some(call => !call.id || !call.name || typeof call.arguments !== 'string' || call.arguments.length > 650000) ||
      content.some(block => block.type === 'tool_use' && (!record(block.input) || typeof block.id !== 'string' || typeof block.name !== 'string')) || new Set(calls.map(call => call.id)).size !== calls.length ||
      calls.length && stopReason !== 'tool_use' || stopReason === 'tool_use' && !calls.length) throw new TextProviderError('模型返回了无效的工具调用', false, 'invalid_tool_call')
    metrics.response_chars = text.length + calls.reduce((sum, call) => sum + call.arguments.length, 0)
    metrics.delivery = 'completed'
    return { text, ...(tool ? { turn: { text, calls, history: [...history, { role: 'assistant', content }], initial_history_length: initial.length, metrics } } : {}) }
  } catch (issue) {
    channel?.failure(issue)
    if (scope.signal.aborted) { metrics.failure_reason = scope.signal.reason?.name === 'AbortError' ? 'cancelled' : 'disconnected'; metrics.raw_reason = scope.signal.reason?.kind; throw scope.signal.reason }
    const failure = !scope.signal.aborted && !(issue instanceof TextProviderError) && transientTextNetworkError(issue)
      ? new TextProviderError('模型接口连接中断，未完成的工具调用未执行；可继续当前任务。', true, 'connection_error', undefined, { cause: issue }) : issue
    annotateTextFailure(failure, { delivery: failure instanceof TextOutputLimitError || failure instanceof TextToolOutputLimitError ? 'completed' : text ? 'output_started' : metrics.delivery ?? 'unknown', partialText: text, tool: !!tool, rawReason: stopReason ?? undefined })
    if (failure instanceof TextProviderError) Object.assign(metrics, { failure_reason: failure.failureReason, raw_reason: failure.rawReason, delivery: failure.delivery, output_started: failure.outputStarted })
    throw failure
  } finally {
    try { usage?.complete(metrics); notifyTextRequest('metrics', metrics, input.onMetrics) } finally { channel?.release(); transport.close(); scope.close() }
  }
}
