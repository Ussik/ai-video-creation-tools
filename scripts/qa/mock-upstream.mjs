// Controllable mock text upstream for script-agent acceptance. Never calls a real model.
// GET  /__log            -> recorded requests (JSON array); DELETE /__log clears
//   body_utf8_bytes = real request-body bytes; body_chars = string length; `bytes` is a deprecated alias of body_chars
// POST /__config         -> {usage:'openai_cache'|'deepseek'|'cache_write'|'plain'|'none', delay_ms, fail_next}
//   review_delay_ms delays only script_draft_completeness requests (makes parallel groups observable via at/finished_at)
//   fail_review: N makes the next N review requests return HTTP 400 (non-retryable)
//   finding_for: "<artifact_type>" arms ONE blocking finding on the first non-global review request that contains that document;
//     the later script_draft_repair request is answered with an exact edit that fixes it (so a draft_resolution round can be driven by public API)
//   plain = input/output/reasoning but no cache fields; none = no usage at all
import { createServer } from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'
import { sourceAnalysisFixture } from './source-analysis-fixture.mjs'

const port = Number(process.env.MOCK_PORT || 18100)
const logFile = process.env.MOCK_LOG || '/tmp/script-agent-mock-requests.jsonl'
writeFileSync(logFile, '')
let config = { usage: 'openai_cache', delay_ms: 0, fail_next: 0, review_delay_ms: 0, fail_review: 0, finding_for: null, image_delay_ms: 0, image_fail: false }
let armedQuote = null
let nextIntent = null
const log = []
let seq = 0
// POST /__intent {...} arms one reply for the next script_intent request (GET /__intent: armed?, DELETE: disarm)
// DELETE /__script empties the scripted-turn queue; GET /__script reports its length (DELETE /__log does not clear it)
// POST /__script [[{name,args,id?},...], ...] queues scripted tool-call turns consumed by the next native tool requests
const scriptQueue = []

function usageFor(mode, prompt) {
  const input = Math.ceil(prompt.length / 2), output = 120
  if (mode === 'none') return undefined
  if (mode === 'plain') return { prompt_tokens: input, completion_tokens: output, completion_tokens_details: { reasoning_tokens: 7 } }
  if (mode === 'deepseek') return { prompt_tokens: input, completion_tokens: output, prompt_cache_hit_tokens: Math.floor(input / 2), prompt_cache_miss_tokens: input - Math.floor(input / 2) }
  if (mode === 'cache_write') return { prompt_tokens: input, completion_tokens: output, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: Math.floor(input / 2) } }
  return { prompt_tokens: input, completion_tokens: output, prompt_tokens_details: { cached_tokens: Math.floor(input / 2) }, completion_tokens_details: { reasoning_tokens: 10 } }
}

function schemaTypes(body) {
  const item = (body.response_format?.json_schema ?? body.text?.format)?.schema?.properties?.artifacts?.items?.properties?.artifact_type
  return item?.enum || (item?.const ? [item.const] : ['outline'])
}
function submittedTypes(prompt) {
  const marker = '待核对草稿原文（资料）：', at = prompt.lastIndexOf(marker)
  try { return [...new Set(JSON.parse(prompt.slice(at + marker.length)).map(source => source.artifact_type))] } catch { return ['outline'] }
}
function answer(body) {
  const contract = (body.response_format?.json_schema ?? body.text?.format)?.name
  const first = body.messages?.[0]?.content ?? (Array.isArray(body.input) ? body.input[0]?.content : body.input)
  const text = typeof first === 'string' ? first : JSON.stringify(first ?? '')
  if (contract === 'script_source_map' || contract?.startsWith('script_source')) { const analyzed = sourceAnalysisFixture(text); if (analyzed) return JSON.parse(analyzed) }
  if (contract === 'workflow_draft') return { artifacts: schemaTypes(body).map(type => ({ artifact_type: type, title: type, content: `MOCK ${type}：依据完整原稿整理；原稿未交代的内容保持未知。` + '设定细节。'.repeat(Number(process.env.MOCK_DOC_REPEAT || 450)) })), scenes: [] }
  // POST /__intent <object> arms ONE reply to the next `script_intent` request (consumed on use); otherwise: discuss.
  if (contract === 'script_intent') { if (nextIntent) { const reply = nextIntent; nextIntent = null; return reply } return { action: 'discuss', settings_patch: {} } }
  // QA: the creator explicitly asked for the stage in the test conversation, so the authorization check says yes.
  if (contract === 'generation_authorization') return { authorized: true }
  if (contract === 'script_draft_completeness') {
    const types = submittedTypes(text)
    if (config.finding_for && !text.includes('【独立任务：全局一致性】') && types.includes(config.finding_for)) {
      const type = config.finding_for; config.finding_for = null
      armedQuote = { type, quote: `MOCK ${type}：依据完整原稿整理` }
      return { facts: [], checked_artifacts: types, findings: [{ source_key: type, kind: 'unresolved_setting', severity: 'blocking', quote: armedQuote.quote,
        explanation: '该文档的关键设定尚未明确（mock 注入）。', suggestion: '补充一句具体设定。' }] }
    }
    return { facts: [], checked_artifacts: types, findings: [] }
  }
  if (contract === 'script_draft_repair') {
    const q = armedQuote || { type: 'outline', quote: 'MOCK outline：依据完整原稿整理' }
    return { decisions: ['按创作者回答补充具体设定。'], summary: '已补充一句具体设定。', source_edits: [], edits: [{ source_key: q.type, find: q.quote, replace: q.quote + '（已补充：钥匙使用后失去一天记忆）', reason: '落实创作者回答' }] }
  }
  return { reply: 'mock reply', note: `unsupported contract ${contract ?? 'none'}` }
}

createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x')
    const send = (code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (url.pathname === '/__log') { if (req.method === 'DELETE') { log.length = 0; return send(200, { cleared: true }) }; return send(200, log) }
    // /__intent: POST arms ONE structured reply for the next `script_intent` request; GET shows whether one is armed; DELETE disarms.
    if (url.pathname === '/__intent') {
      if (req.method === 'DELETE') nextIntent = null
      if (req.method === 'POST') nextIntent = JSON.parse(Buffer.concat(chunks).toString() || 'null')
      return send(200, { armed: nextIntent !== null })
    }
    // /__script: POST appends scripted tool-call turns; GET shows how many remain; DELETE empties the queue.
    // DELETE /__log does NOT touch this queue, and POST never replaces it (POST [] is a no-op that appends nothing).
    if (url.pathname === '/__script') {
      if (req.method === 'DELETE') { const dropped = scriptQueue.length; scriptQueue.length = 0; return send(200, { queued: 0, dropped }) }
      if (req.method === 'POST') scriptQueue.push(...JSON.parse(Buffer.concat(chunks).toString() || '[]'))
      return send(200, { queued: scriptQueue.length })
    }
    if (url.pathname === '/__config') { if (req.method === 'POST') config = { ...config, ...JSON.parse(Buffer.concat(chunks).toString() || '{}') }; return send(200, config) }
    const raw = Buffer.concat(chunks).toString()
    let body = {}
    try { body = JSON.parse(raw) } catch {}
    const prompt = JSON.stringify(body.messages ?? body.input ?? '')
    const entry = { seq: ++seq, at: new Date().toISOString(), path: url.pathname, contract: (body.response_format?.json_schema ?? body.text?.format)?.name ?? null,
      tools: Array.isArray(body.tools) ? body.tools.map(t => t.function?.name ?? t.name) : [], body_utf8_bytes: Buffer.byteLength(raw), body_chars: raw.length, bytes: raw.length /* deprecated alias: characters, NOT bytes */, prompt_chars: prompt.length,
      parallel_tool_calls: body.parallel_tool_calls, config: { ...config }, body }
    log.push(entry); appendFileSync(logFile, JSON.stringify(entry) + '\n')
    const remote = String(body.model ?? '')
    entry.model = remote
    // Fake image upstream (nothing paid): any path ending in /image answers with a fixed 1x1 PNG as base64 in data[0].b64_json.
    // image_delay_ms (via /__config) holds the response so the queued asset task is observable; image_fail makes it fail.
    if (url.pathname.endsWith('/image')) {
      entry.image = true
      if (config.image_delay_ms) await new Promise(r => setTimeout(r, config.image_delay_ms))
      entry.finished_at = new Date().toISOString()
      if (config.image_fail) return send(500, { error: { message: 'mock image failure' } })
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
      return send(200, { data: [{ b64_json: png }] })
    }
    const slow = remote.startsWith('qa-slow-') ? Number(process.env.MOCK_SLOW_MS || 60000) : 0
    if (remote.startsWith('qa-fail-')) return send(400, { error: { message: 'mock deterministic failure' } })
    const reviewDelay = entry.contract === 'script_draft_completeness' ? (config.review_delay_ms || 0) : 0
    if (config.delay_ms || slow || reviewDelay) await new Promise(r => setTimeout(r, config.delay_ms || slow || reviewDelay))
    entry.finished_at = new Date().toISOString()
    if (config.fail_review > 0 && entry.contract === 'script_draft_completeness') { config.fail_review--; return send(400, { error: { message: 'mock review failure' } }) }
    if (config.fail_next > 0) { config.fail_next--; return send(500, { error: { message: 'mock injected failure' } }) }
    const usage = usageFor(config.usage, prompt)
    // Native tool requests (no structured contract) get a plain text turn; a header-free
    // `x-mock-tool-calls` JSON in the prompt is not needed because scripted calls use /__script.
    const scripted = body.tools && scriptQueue.length ? scriptQueue.shift() : null
    const message = scripted ? { role: 'assistant', content: '', tool_calls: scripted.map((call, i) => ({ id: call.id || `call-${seq}-${i}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) }
      : body.tools && !body.response_format ? { role: 'assistant', content: 'mock 工具会话回复' } : { role: 'assistant', content: JSON.stringify(answer(body)) }
    if (url.pathname.endsWith('/responses')) {
      // OpenAI Responses protocol: input items in, output items out; usage uses input_tokens/output_tokens(+_details)
      const ru = usage ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens,
        ...(usage.prompt_tokens_details ? { input_tokens_details: usage.prompt_tokens_details } : {}),
        ...(usage.completion_tokens_details ? { output_tokens_details: usage.completion_tokens_details } : {}) } : undefined
      const output = scripted ? scripted.map((call, i) => ({ type: 'function_call', call_id: call.id || `call-${seq}-${i}`, name: call.name, arguments: JSON.stringify(call.args ?? {}) }))
        : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: typeof message.content === 'string' ? message.content : '' }] }]
      return send(200, { id: `mock-${seq}`, status: 'completed', output, output_text: scripted ? '' : (message.content || ''), ...(ru ? { usage: ru } : {}) })
    }
    send(200, { id: `mock-${seq}`, choices: [{ message, finish_reason: scripted ? 'tool_calls' : 'stop' }], ...(usage ? { usage } : {}) })
  })
}).listen(port, '127.0.0.1', () => console.log(`mock upstream http://127.0.0.1:${port} log=${logFile}`))
