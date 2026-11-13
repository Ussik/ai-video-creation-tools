import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ModelCatalogConfig } from '../src/infrastructure/providers/model-catalog.js'
import type { Provider } from '../src/infrastructure/database/db.js'
import { discoverCatalogCapabilities, type CatalogCapabilityContext } from '../src/infrastructure/providers/model-catalog-capabilities.js'

const testData = await mkdtemp(join(tmpdir(), 'catalog-capabilities-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { parseCatalog, fetchModelCatalog } = await import('../src/infrastructure/providers/model-catalog.js')
const { db, one, all } = await import('../src/infrastructure/database/db.js')
const { buildApp } = await import('../src/app.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

const config: ModelCatalogConfig = { path: 'models', list_path: 'data', id_path: 'id', name_path: 'name', modality_path: '' }
const channel: CatalogCapabilityContext = { base_url: 'https://gateway.invalid/v1/', protocol: 'chat_completions', fetched_at: '2026-11-10T01:00:00.000Z' }

test('plain OpenAI catalogs retain IDs without inventing limits from model names', () => {
  const models = parseCatalog({ data: [{ id: 'gemini-3.8-flash' }, { id: 'claude-large' }, { id: ' gemini-3.8-flash ' }] }, config, channel)
  assert.deepEqual(models, [
    { remote_id: 'gemini-3.8-flash', name: 'gemini-3.8-flash', modality_hint: null },
    { remote_id: 'claude-large', name: 'claude-large', modality_hint: null },
  ])
})

test('official OpenRouter metadata discovers the actual channel limits and a shared window', () => {
  const scope = { ...channel, base_url: 'https://openrouter.ai/api/v1/' }
  const [model] = parseCatalog({ data: [{ id: 'vendor/text', context_length: 1_000_000,
    top_provider: { context_length: 200_000, max_completion_tokens: 32_768 } }] }, config, scope)
  assert.deepEqual(model?.capabilities, {
    limits: { budget_mode: 'shared', context_tokens: 200_000, output_tokens: 32_768 },
    source: 'provider', fetched_at: channel.fetched_at,
    scope: { base_url: 'https://openrouter.ai/api/v1', protocol: 'chat_completions', remote_id: 'vendor/text' },
  })
})

test('OpenRouter-shaped gateways provide numeric evidence without inheriting official budget semantics', () => {
  const capabilities = discoverCatalogCapabilities({ context_length: 200_000, top_provider: { max_completion_tokens: 32_768 } }, 'alias', channel)
  assert.deepEqual(capabilities?.limits, { budget_mode: 'unknown', context_tokens: 200_000, output_tokens: 32_768 })
  for (const base_url of ['https://openrouter.ai.attacker.invalid/api/v1', 'http://openrouter.ai/api/v1', 'https://openrouter.ai/custom']) {
    assert.equal(discoverCatalogCapabilities({ context_length: 200_000 }, 'alias', { ...channel, base_url })?.limits.budget_mode, 'unknown')
  }
})

test('explicit separate input and output caps are preserved without turning input into a shared context', () => {
  const capabilities = discoverCatalogCapabilities({ capabilities: { limits: {
    budget_mode: 'separate', input_tokens: 1_000_000, output_tokens: 65_536, output_includes_reasoning: true,
  } } }, 'model', channel)
  assert.deepEqual(capabilities?.limits, { budget_mode: 'separate', input_tokens: 1_000_000, output_tokens: 65_536, output_includes_reasoning: true })
  assert.equal(capabilities?.scope.base_url, 'https://gateway.invalid/v1')
  assert.deepEqual(discoverCatalogCapabilities({ budget_mode: 'separate', input_tokens: 100_000, output_tokens: 32_768 }, 'model', channel)?.limits,
    { budget_mode: 'separate', input_tokens: 100_000, output_tokens: 32_768 })
})

test('native Anthropic metadata keeps maximum input and output distinct', () => {
  const capabilities = discoverCatalogCapabilities({ max_input_tokens: 200_000, max_tokens: 64_000 }, 'claude', {
    ...channel, base_url: 'https://api.anthropic.com/v1', protocol: 'anthropic_messages',
  })
  assert.deepEqual(capabilities?.limits, { budget_mode: 'unknown', input_tokens: 200_000, output_tokens: 64_000 })
  assert.equal(capabilities?.limits.context_tokens, undefined)
  assert.equal(discoverCatalogCapabilities({ max_tokens: 64_000 }, 'alias', channel), undefined, 'generic max_tokens may be a default rather than an output capability')
})

test('catalogs ignore unsafe, fractional, string and nonpositive token limits', () => {
  for (const value of [0, -1, 1.5, '32768', Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
    assert.equal(discoverCatalogCapabilities({ context_length: value, max_input_tokens: value, max_output_tokens: value }, 'model', channel), undefined)
  }
  const capabilities = discoverCatalogCapabilities({ budget_mode: 'other', context_length: 200_000, max_output_tokens: '65536', output_includes_reasoning: 'true' }, 'model', channel)
  assert.deepEqual(capabilities?.limits, { budget_mode: 'unknown', context_tokens: 200_000 })
})

test('text capabilities are not attached to explicitly image or video models and remain optional for old parser callers', () => {
  const models = parseCatalog({ data: [{ id: 'image', modalities: ['image'], context_length: 200_000 },
    { id: 'video', type: 'video', max_output_tokens: 100 }, { id: 'text', output_modalities: ['text'], max_output_tokens: 100 }] }, config, channel)
  assert.equal(models[0]?.capabilities, undefined)
  assert.equal(models[1]?.capabilities, undefined)
  assert.equal(models[2]?.capabilities?.limits.output_tokens, 100)
  assert.equal(parseCatalog({ data: [{ id: 'text', context_length: 200_000 }] }, config)[0]?.capabilities, undefined)
})

test('draft catalog preview returns scoped capability evidence without saving provider or model changes', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/providers/configuration', payload: {
    provider: { name: '能力目录', base_url: 'https://saved.invalid/v1', protocol: 'responses', api_key: 'saved-key' },
    models: [{ name: 'existing', remote_id: 'existing', modality: 'text', protocol: 'responses',
      settings: { text_api: { mode: 'standard', max_output_tokens: 16_000 } } }],
  } })
  assert.equal(created.statusCode, 200, created.body)
  const saved = created.json()
  const snapshot = () => ({ provider: one('SELECT * FROM providers WHERE id=?', saved.provider.id),
    models: all('SELECT * FROM models WHERE provider_id=? ORDER BY id', saved.provider.id) })
  const before = snapshot()
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; authorization: string | null; redirect: RequestRedirect | undefined }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get('Authorization'), redirect: init?.redirect })
    return Response.json({ data: [{ id: 'existing', context_length: 128_000, top_provider: { max_completion_tokens: 65_536 } }, { id: 'new-without-metadata' }] })
  }
  try {
    const preview = await app.inject({ method: 'POST', url: '/api/providers/model-catalog/preview', payload: {
      provider_id: saved.provider.id, base_url: 'https://draft.invalid/custom/', protocol: 'chat_completions', api_key: 'draft-key',
    } })
    assert.equal(preview.statusCode, 200, preview.body)
    const body = preview.json()
    assert.equal(body.models[0].existing, true)
    assert.deepEqual(body.models[0].capabilities.limits, { budget_mode: 'unknown', context_tokens: 128_000, output_tokens: 65_536 })
    assert.deepEqual(body.models[0].capabilities.scope, { base_url: 'https://draft.invalid/custom', protocol: 'chat_completions', remote_id: 'existing' })
    assert.equal(body.models[0].capabilities.source, 'provider')
    assert.ok(Number.isFinite(Date.parse(body.models[0].capabilities.fetched_at)))
    assert.equal(body.models[1].capabilities, undefined)
    assert.deepEqual(requests, [{ url: 'https://draft.invalid/custom/models', authorization: 'Bearer draft-key', redirect: 'manual' }])
    assert.deepEqual(snapshot(), before)
    assert.ok(!preview.body.includes('draft-key'))
    assert.ok(!preview.body.includes('saved-key'))
  } finally { globalThis.fetch = originalFetch }
})

test('capability discovery keeps catalog redirects and response-size protections', async () => {
  const provider: Provider = { id: 'fixture', name: 'fixture', adapter: 'http', base_url: channel.base_url, protocol: 'chat_completions',
    auth_header: 'Authorization', auth_prefix: 'Bearer ', key_ciphertext: null, model_catalog: JSON.stringify(config), created_at: '', enabled: 1, archived: 0 }
  const originalFetch = globalThis.fetch
  try {
    let requests = 0
    globalThis.fetch = async () => { requests++; return new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid/models' } }) }
    await assert.rejects(fetchModelCatalog(provider, config, 'fixture-key'), /跳转/)
    assert.equal(requests, 1)
    globalThis.fetch = async () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } })
    await assert.rejects(fetchModelCatalog(provider, config, 'fixture-key'), /超过 2 MB/)
    globalThis.fetch = async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))
    await assert.rejects(fetchModelCatalog(provider, config, 'fixture-key'), /超过 2 MB/)
  } finally { globalThis.fetch = originalFetch }
})
