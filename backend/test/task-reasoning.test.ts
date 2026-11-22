import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { resolveTextApiSettings, type TextApiProtocol } from '@video-studio/shared/models/text-api-settings'
import { resolveTaskReasoning, taskReasoningOptions } from '@video-studio/shared/models/task-reasoning'

const directory = await mkdtemp(join(tmpdir(), 'task-reasoning-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { bindTaskReasoning, textGenerationOptionsInput } = await import('../src/infrastructure/providers/task-reasoning.js')
const { streamText } = await import('../src/infrastructure/providers/providers.js')
after(() => rm(directory, { recursive: true, force: true }))

const provider = { adapter: 'http' as const, base_url: 'https://fixture.invalid/v1' }
const settings = { text_api: { mode: 'standard', max_output_tokens: 4096,
  reasoning: { enabled: true, mode: 'effort', default_level: 'medium', levels: [
    { level: 'medium', api_value: 'medium' }, { level: 'high', api_value: 'high' }, { level: 'off', api_value: '' },
  ] } } }
const model = { id: 'fixture', modality: 'text' as const, remote_id: 'fixture', settings }

function effort(body: Record<string, any>, protocol: TextApiProtocol) {
  if (protocol === 'responses') return body.reasoning?.effort
  if (protocol === 'anthropic_messages') return body.output_config?.effort
  return body.reasoning_effort
}

for (const protocol of ['responses', 'chat_completions', 'anthropic_messages'] as const) {
  test(`${protocol} uses task high for each dispatch and keeps the model default outside the task`, async context => {
    const bodies: Record<string, any>[] = []
    context.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return Response.json(protocol === 'responses' ? { status: 'completed', output_text: 'ok' }
        : protocol === 'anthropic_messages' ? { type: 'message', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }
          : { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
    })
    const selected = { ...model, protocol }
    const execute = bindTaskReasoning(selected, provider, { reasoning: 'high' })
    const run = () => streamText(selected, provider, { prompt: 'synthetic fixture' })
    await Promise.all([execute(run), run()])
    await execute(run)
    assert.deepEqual(bodies.slice(0, 2).map(body => effort(body, protocol)).sort(), ['high', 'medium'])
    assert.equal(effort(bodies[2]!, protocol), 'high')
    assert.ok(bodies.every(body => !('text_generation_options' in body)))
    const off = resolveTextApiSettings(resolveTaskReasoning(settings, protocol, 'off').settings, protocol).request_template as Record<string, any>
    if (protocol === 'anthropic_messages') assert.deepEqual(off.thinking, { type: 'disabled' })
    else assert.equal(effort(off, protocol), 'none')
  })
}

test('fixed budget is a declared preset and stays in budget_tokens', () => {
  const fixed = { text_api: { ...settings.text_api, reasoning: { ...settings.text_api.reasoning, mode: 'fixed', budget_tokens: 2048 } } }
  const choice = resolveTaskReasoning(fixed, 'anthropic_messages', 'fixed')
  assert.deepEqual(resolveTextApiSettings(choice.settings, 'anthropic_messages').request_template, {
    model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }], max_tokens: 4096,
    thinking: { type: 'enabled', budget_tokens: 2048 },
  })
  assert.throws(() => resolveTaskReasoning(fixed, 'anthropic_messages', 'high'), { statusCode: 422 })
})

test('legacy, auto, unsupported model swaps and malformed requests', () => {
  assert.equal(resolveTaskReasoning(settings, 'responses').effective, 'medium')
  assert.equal(resolveTaskReasoning(settings, 'responses', 'auto').effective, 'medium')
  assert.equal(resolveTaskReasoning({}, 'responses', 'inherit').source, 'upstream')
  assert.deepEqual(taskReasoningOptions({}, 'responses'), [])
  assert.throws(() => resolveTaskReasoning({}, 'responses', 'high'), { statusCode: 422 })
  const medium = structuredClone(settings)
  medium.text_api.reasoning.levels = [{ level: 'medium', api_value: 'medium' }]
  assert.throws(() => resolveTaskReasoning(medium, 'responses', 'high'), { statusCode: 422 })
  assert.equal(textGenerationOptionsInput.safeParse({ reasoning_effort: 'high' }).success, false)
  assert.equal(textGenerationOptionsInput.safeParse({ reasoning: 'ultra' }).success, false)
})

test('official DeepSeek recovery overrides task high and emits only normalized reasoning metadata', async context => {
  const target = { ...provider, base_url: 'https://api.deepseek.com/v1' }
  const selected = { ...model, protocol: 'chat_completions' as const, remote_id: 'deepseek-v4-pro' }
  context.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(JSON.parse(String(init.body)).reasoning_effort, 'none')
    return Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
  })
  await bindTaskReasoning(selected, target, { reasoning: 'high' })(() => streamText(selected, target, {
    prompt: 'synthetic fixture', structured_output: { name: 'script_review', schema: { type: 'object' }, request_policy: 'script_review_answer' },
  }, undefined, undefined, undefined, undefined, metrics => {
    assert.equal(Reflect.get(metrics, 'reasoning_requested'), 'high')
    assert.equal(Reflect.get(metrics, 'reasoning_effective'), 'off')
    assert.equal(Reflect.get(metrics, 'reasoning_source'), 'policy')
  }))
})
