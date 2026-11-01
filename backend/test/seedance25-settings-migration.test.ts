import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { upgradeLegacySeedance25Settings } from '../src/modules/models/legacy-seedance25-settings.js'

const starter = () => ({
  create_path: 'contents/generations/tasks', get_path: 'contents/generations/tasks/{id}',
  request_template: { model: '{{model}}', content: '{{content}}', duration: '{{duration}}', ratio: '{{ratio}}', resolution: '{{resolution}}' },
  content_template: [{ type: 'text', text: '{{prompt}}' }],
  id_path: 'id', status_path: 'status', result_path: 'content.video_url',
  ratios: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'],
  resolutions: ['480p', '720p', '1080p', '4k'], default_resolution: '480p',
})
const legacyModel = (settings: Record<string, unknown> = starter()) => ({
  remote_id: 'doubao-seedance-2-5-260628', modality: 'video', protocol: 'async_video', settings: JSON.stringify(settings),
})

test('known generic Seedance 2.5 starter is upgraded without changing pricing or API override', () => {
  const pricing = { currency: '¥', per_second: 0.12, per_second_by_resolution: { '480p': 0.1, '4k': 0.8 } }
  const model = legacyModel({ ...starter(), pricing, api_base_url: 'https://configured.example/api/v3' })
  const upgraded = upgradeLegacySeedance25Settings(model)
  assert.ok(upgraded)
  const settings = JSON.parse(upgraded)
  assert.equal(settings.video_reference_profile, 'seedance_2_5')
  assert.equal(settings.max_reference_images, 30)
  assert.deepEqual(settings.resolutions, ['480p', '720p', '1080p'])
  assert.equal(settings.default_resolution, '720p')
  assert.equal(settings.max_duration, 30)
  assert.deepEqual(settings.pricing, pricing)
  assert.equal(settings.api_base_url, 'https://configured.example/api/v3')
  assert.equal(upgradeLegacySeedance25Settings({ ...model, settings: upgraded }), null, 'upgraded settings are never reapplied')
})

test('migration skips custom model IDs, templates, profiles, settings and malformed JSON', () => {
  const model = legacyModel()
  for (const change of [
    { remote_id: 'ep-custom-seedance-2-5' }, { remote_id: 'doubao-seedance-2-0-260128' },
    { modality: 'image' }, { protocol: 'image_generations' }, { settings: 'broken JSON' },
    { settings: 'null' }, { settings: '[]' },
  ]) assert.equal(upgradeLegacySeedance25Settings({ ...model, ...change }), null)
  for (const changes of [
    { create_path: 'custom/tasks' }, { default_resolution: '1080p' },
    { request_template: { ...starter().request_template, watermark: false } },
    { content_template: [{ type: 'text', text: 'custom {{prompt}}' }] },
    { supported_modes: ['text'] }, { video_reference_profile: 'seedance_2_0' },
    { request_templates: { text: starter().request_template } }, { poll_seconds: 30 },
    { custom_flag: true },
  ]) assert.equal(upgradeLegacySeedance25Settings(legacyModel({ ...starter(), ...changes })), null)
  const missing = { ...starter() } as Record<string, unknown>
  delete missing.content_template
  assert.equal(upgradeLegacySeedance25Settings(legacyModel(missing)), null)
})

const directory = await mkdtemp(join(tmpdir(), 'seedance25-settings-migration-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, all, one, run } = await import('../src/infrastructure/database/db.js')
initDb()
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

test('startup migration only updates matching settings and preserves every connection and model field', () => {
  run(`INSERT INTO providers
    (id,name,adapter,base_url,auth_header,auth_prefix,key_ciphertext,model_catalog,created_at,enabled,archived)
    VALUES ('configured-provider','我的接入','http','https://configured.example/api/v3','X-Auth','Token ','fixture-encrypted','{"custom":true}','old-time',0,1)`)
  for (const [id, enabled, archived, settings] of [
    ['known-starter', 1, 0, { ...starter(), pricing: { per_second: 0.25 }, api_base_url: 'https://override.example/v3' }],
    ['archived-starter', 0, 1, starter()],
    ['custom-template', 1, 0, { ...starter(), content_template: [{ type: 'text', text: 'custom {{prompt}}' }] }],
  ] as const) {
    run(`INSERT INTO models (id,provider_id,name,remote_id,modality,protocol,settings,enabled,archived)
      VALUES (?,'configured-provider',?,'doubao-seedance-2-5-260628','video','async_video',?,?,?)`, id, `保留名称 ${id}`, JSON.stringify(settings), enabled, archived)
  }
  const provider = one('SELECT * FROM providers WHERE id=?', 'configured-provider')
  const before = all<Record<string, unknown>>('SELECT * FROM models ORDER BY id')
  // Simulate opening the preceding release's database; all data stays in this temporary directory.
  run('DELETE FROM studio_migrations WHERE id=?', 'seedance25-default-settings-v1')
  initDb()
  const afterModels = all<Record<string, unknown>>('SELECT * FROM models ORDER BY id')
  assert.deepEqual(one('SELECT * FROM providers WHERE id=?', 'configured-provider'), provider)
  for (const [index, model] of afterModels.entries()) {
    const { settings, ...metadata } = model
    const { settings: previousSettings, ...previousMetadata } = before[index]!
    assert.deepEqual(metadata, previousMetadata)
    if (model.id === 'custom-template') assert.equal(settings, previousSettings)
    else assert.equal(JSON.parse(settings as string).video_reference_profile, 'seedance_2_5')
  }
  assert.equal(all('SELECT * FROM studio_migrations WHERE id=?', 'seedance25-default-settings-v1').length, 1)
  initDb()
  assert.deepEqual(all('SELECT * FROM models ORDER BY id'), afterModels, 'a second startup preserves exact persisted settings')
  assert.deepEqual(all('PRAGMA foreign_key_check'), [])
})
