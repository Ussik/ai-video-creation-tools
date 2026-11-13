import assert from 'node:assert/strict'
import { test } from 'node:test'
import { streamText, type GenerationModel, type TextRequestMetrics } from '../src/infrastructure/providers/providers.js'
import { TextOutputLimitError, TextToolOutputLimitError, TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { textToolSession } from '../src/infrastructure/providers/text-tools.js'

const model: GenerationModel = { id: 'body-error', remote_id: 'fixture', modality: 'text', protocol: 'responses',
  settings: { request_path: 'responses', request_template: { model: '{{model}}', input: '{{prompt}}' } } }
const provider = { adapter: 'http' as const, base_url: 'https://fixture.invalid/v1' }
const privateText = 'private original screenplay fragment must remain hidden'
const usage = { input_tokens: 117, output_tokens: 213, output_tokens_details: { reasoning_tokens: 89 } }
const payload = { status: 'failed', error: { code: 'bad_response_body', message: privateText }, usage,
  output: [{ type: 'function_call', call_id: 'never-run', name: 'save_document', arguments: '{}' }] }

for (const mode of ['json', 'sse', 'http'] as const) for (const tools of [false, true]) {
  test(`${mode} ${tools ? 'tool' : 'text'} body errors retain diagnostic metrics and remain distinct from output limits`, async t => {
    let requests = 0, metrics: TextRequestMetrics | undefined
    t.mock.method(globalThis, 'fetch', async () => {
      requests++
      const headers = { 'Content-Type': mode === 'sse' ? 'text/event-stream' : 'application/json', 'x-request-id': 'body-error-request' }
      return mode === 'sse'
        ? new Response(`data: ${JSON.stringify({ type: 'response.failed', response: payload })}\n\n`, { headers })
        : Response.json(payload, { status: mode === 'http' ? 502 : 200, headers })
    })
    const result = tools
      ? textToolSession(model, provider, privateText, [], () => '', undefined, undefined, value => { metrics = value })()
      : streamText(model, provider, { prompt: privateText }, undefined, undefined, undefined, value => { metrics = value })
    await assert.rejects(result, issue => {
      assert.ok(issue instanceof TextProviderError)
      assert.ok(!(issue instanceof TextOutputLimitError))
      assert.ok(!(issue instanceof TextToolOutputLimitError))
      assert.equal(issue.upstreamCode, 'bad_response_body')
      assert.equal(issue.retryable, false)
      assert.match(issue.message, /上游未能返回有效的模型响应体（bad_response_body）/)
      assert.ok(!issue.message.includes(privateText))
      return true
    })
    assert.equal(requests, 1, 'a malformed response must not cause an automatic decision replay')
    assert.equal(metrics?.input_tokens, 117)
    assert.equal(metrics?.output_tokens, 213)
    assert.equal(metrics?.reasoning_tokens, 89)
    assert.equal(metrics?.http_status, mode === 'http' ? 502 : 200)
    assert.equal(metrics?.upstream_request_id, 'body-error-request')
    assert.equal(metrics?.output_limit_reason, undefined)
    assert.equal(metrics?.output_limit_kind, undefined)
  })
}
