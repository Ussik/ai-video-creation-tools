import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const directory = await mkdtemp(join(tmpdir(), 'visual-content-cache-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
process.env.LANGFUSE_TRACING = 'false'
const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/infrastructure/database/db.js')
const { visualProfileContent } = await import('../src/modules/visuals/visual-profile-content-cache.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

test('source updates reuse only complete content with exact object, fact, usage, model and contract identity', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '内容复用隔离测试' } })
  assert.equal(response.statusCode, 200)
  const projectId = response.json().id
  let requests = 0, validations = 0
  const original = { item: 'A', facts: 'scene-1', usage: 'shot-1', model: 'model-1', schema: 'v1', variant: 'default', base: 'base-1', skills: 'rules-1' }
  const run = (identity: unknown, reuse = true, fail = false) => visualProfileContent({ projectId, unitKey: 'A', identity, reuse,
    validate: value => { validations++; assert.deepEqual(value, { definition: '原始有效内容' }); return value },
    generate: async () => { requests++; if (fail) throw new Error('unknown response'); return { definition: '原始有效内容' } } })
  await run(original, false)
  await run(original)
  assert.equal(requests, 1); assert.equal(validations, 2, 'reuse still runs current validation')
  for (const key of Object.keys(original)) await run({ ...original, [key]: 'changed' })
  assert.equal(requests, 1 + Object.keys(original).length)
  await run(original, false)
  assert.equal(requests, 2 + Object.keys(original).length, 'explicit refresh bypasses cache')
  const failed = { ...original, item: 'unknown' }
  await assert.rejects(run(failed, false, true), /unknown response/)
  await run(failed)
  assert.equal(requests, 4 + Object.keys(original).length, 'an unknown response is never cached as completion')
  await assert.rejects(visualProfileContent({ projectId, unitKey: 'A', identity: original, reuse: true,
    validate: () => { throw new Error('current business conflict') }, generate: async () => { requests++; return {} } }), /current business conflict/)
  assert.equal(requests, 4 + Object.keys(original).length, 'a validation conflict does not silently buy a replacement')
})
