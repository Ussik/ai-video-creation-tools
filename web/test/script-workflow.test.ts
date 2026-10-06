import assert from 'node:assert/strict'
import { test } from 'node:test'
import { artifactKey } from '../src/script-workflow.ts'

test('episode document keys keep separate episodes and project-level outlines distinct', () => {
  const keys = [1, 2, 20].map(episode_number => artifactKey({ artifact_type: 'episode_script', episode_number }))
  assert.equal(new Set(keys).size, 3)
  assert.notEqual(keys[0], artifactKey({ artifact_type: 'episode_outline', episode_number: 1 }))
  assert.equal(artifactKey({ artifact_type: 'outline' }), 'outline:0')
})
