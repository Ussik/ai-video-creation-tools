import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { parseThemeVisuals, themeVisualPrompt } from '../src/modules/script/script-theme-visuals.js'
import { scriptThemeCategories } from '@video-studio/shared/script/script-theme-catalog'

const dataDir = await mkdtemp(join(tmpdir(), 'studio-theme-'))
process.env.VIDEO_STUDIO_DATA_DIR = dataDir
const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(dataDir, { recursive: true, force: true }) })
const match = (primary: string | null, fusion: string | null, confidence = .95) => JSON.stringify({
  primary: { category: primary, confidence }, fusion: { category: fusion, confidence },
})

test('semantic presentation mapping accepts only catalog categories, preserves exact identities and declines uncertain matches', () => {
  const names = { genre: '悬疑恐怖', genre_fusion: '民俗恐怖' }
  assert.deepEqual(parseThemeVisuals(match('悬疑推理', '惊悚怪谈'), names), { primary: '悬疑推理', fusion: '惊悚怪谈' })
  assert.deepEqual(parseThemeVisuals(match('悬疑推理', '惊悚怪谈', .4), names), { primary: null, fusion: null })
  assert.deepEqual(parseThemeVisuals(match('惊悚怪谈', '惊悚怪谈'), { genre: '喜剧', genre_fusion: '' }), { primary: '喜剧', fusion: null })
  assert.throws(() => parseThemeVisuals(match('新建悬疑类型', '惊悚怪谈'), names))
  assert.throws(() => parseThemeVisuals('not json', names))
  const prompt = themeVisualPrompt(names)
  assert.ok(prompt.includes('不改变故事设定'))
  assert.ok(prompt.includes(JSON.stringify(scriptThemeCategories)))
  assert.ok(prompt.includes(JSON.stringify(names)))
})

test('custom genres use an isolated model call without editing project settings, documents or conversations', async t => {
  const inject = async (method: 'POST' | 'PUT' | 'GET', url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, ...(payload ? { payload } : {}) })
    assert.equal(response.statusCode, 200, response.body)
    return response.json()
  }
  const provider = await inject('POST', '/api/providers', { name: '封面测试', base_url: 'https://theme.example/v1' })
  const model = await inject('POST', '/api/models', { provider_id: provider.id, name: '测试文本', remote_id: 'test', modality: 'text', protocol: 'chat_completions', settings: {
    text_api: { mode: 'standard', output_mode: 'fixed', max_output_tokens: 4096 },
  } })
  const project = await inject('POST', '/api/projects', { name: '自定义题材测试' })
  await inject('PUT', `/api/projects/${project.id}/script`, { outline: '已有故事', characters: '已有角色', generation_options: { genre: '悬疑恐怖', genre_fusion: '民俗恐怖' } })
  const before = await inject('GET', `/api/projects/${project.id}`)
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    calls++
    const prompt = JSON.parse(String(init?.body)).messages[0].content
    assert.ok(prompt.includes('悬疑恐怖'))
    assert.ok(!prompt.includes('已有故事'), 'matching must not receive the writer conversation or full project documents')
    return new Response(JSON.stringify({ choices: [{ message: { content: match('悬疑推理', '惊悚怪谈') } }] }), { headers: { 'Content-Type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  assert.deepEqual(await inject('POST', `/api/projects/${project.id}/script/themes/visuals`, {
    model_id: model.id, genre: '悬疑恐怖', genre_fusion: '民俗恐怖',
  }), { primary: '悬疑推理', fusion: '惊悚怪谈' })
  assert.equal(calls, 1)
  assert.deepEqual(await inject('GET', `/api/projects/${project.id}`), before)
  assert.deepEqual(await inject('POST', `/api/projects/${project.id}/script/themes/visuals`, {
    model_id: model.id, genre: '都市现实', genre_fusion: '',
  }), { primary: '都市现实', fusion: null })
  assert.equal(calls, 1, 'existing catalog identities never require a model call')
})
