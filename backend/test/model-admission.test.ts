import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withModelAdmission } from '../src/modules/generation/model-admission.js'

test('same resource serializes; unrelated tasks run independently; queued cancel cannot release owner', async () => {
  const events: string[] = [], controller = new AbortController()
  let release!: () => void
  const first = withModelAdmission('doc', undefined, async () => { events.push('first'); await new Promise<void>(r => { release = r }); events.push('end') })
  const second = withModelAdmission('doc', controller.signal, async () => { events.push('wrong') })
  const rejected = assert.rejects(second)
  const third = withModelAdmission('doc', undefined, async () => { events.push('third') })
  await withModelAdmission('other', undefined, async () => { events.push('other') })
  controller.abort(); await rejected
  assert.deepEqual(events, ['first','other'])
  release(); await Promise.all([first,third]); assert.deepEqual(events, ['first','other','end','third'])
})
