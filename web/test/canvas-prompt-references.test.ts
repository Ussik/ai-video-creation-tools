import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolvePromptReferences } from '@video-studio/shared/visuals/prompt-references'
import { replacePromptReference, disconnectedPromptReferenceIds, disconnectRemovedPromptReplacements } from '../src/features/canvas/canvas-prompt-references'
import type { CanvasGraph } from '../src/features/canvas/ProjectCanvas'

test('stable references replace actual inputs, deduplicate, remove, and compile final positions', () => {
  const input = { prompt: '[[ref:old]]跟随[[ref:extra]]', referenceAssetIds: ['old', 'keep'], overrides: { old: 'new' } }
  const result = resolvePromptReferences(input)
  assert.deepEqual(result.referenceAssetIds, ['new', 'keep', 'extra'])
  assert.equal(result.prompt, '参考图 1跟随参考图 3')
  assert.deepEqual(resolvePromptReferences({ ...input, prompt: result.prompt, referenceAssetIds: result.referenceAssetIds }), result)
  const removed = resolvePromptReferences({ ...input, overrides: { old: null } })
  assert.deepEqual(removed.referenceAssetIds, ['keep', 'extra'])
  assert.equal(removed.prompt, '跟随参考图 2')
})
test('override chains are stable while cycles, malformed tokens and base removal are rejected', () => {
  assert.deepEqual(resolvePromptReferences({ prompt: '[[ref:a]]', referenceAssetIds: ['a'], overrides: { a: 'b', b: 'c' } }).referenceAssetIds, ['c'])
  assert.throws(() => resolvePromptReferences({ prompt: '', referenceAssetIds: ['a'], overrides: { a: 'b', b: 'a' } }), /循环/)
  assert.throws(() => resolvePromptReferences({ prompt: '[[ref:broken', referenceAssetIds: [] }), /无效/)
  assert.throws(() => resolvePromptReferences({ prompt: '', referenceAssetIds: ['a'], requiredAssetIds: ['a'], overrides: { a: null } }), /必须保留/)
  assert.deepEqual(replacePromptReference({ a: 'b' }, 'b', 'c'), { a: 'c', b: 'c' })
})

test('mentions cannot resurrect disconnected or explicitly removed references', () => {
  assert.deepEqual(disconnectedPromptReferenceIds('[[ref:old]] [[ref:keep]]', ['keep']), ['old'])
  assert.deepEqual(disconnectedPromptReferenceIds('[[ref:old]]', ['old'], { old: null }), ['old'])
  assert.deepEqual(disconnectedPromptReferenceIds('[[ref:old]]', ['old'], { old: 'new' }), [])
})

test('disconnecting a replacement clears its binding override without losing prose or unrelated inputs', () => {
  const target = { id: 'target', text: '[[ref:new]]行走', settings: { prompt_reference_overrides: { old: 'new', keep: 'extra' } } }
  const previous = { nodes: [target], edges: [{ id: 'replacement', source: 'image', target: 'target', reference_asset_id: 'new' }] } as unknown as CanvasGraph
  const next = { ...previous, edges: [] }
  const disconnected = disconnectRemovedPromptReplacements(previous, next)
  assert.deepEqual(disconnected.nodes[0].settings.prompt_reference_overrides, { old: null, keep: 'extra' })
  assert.equal(disconnected.nodes[0].text, target.text)
  assert.deepEqual(disconnectedPromptReferenceIds(target.text, ['old'], disconnected.nodes[0].settings.prompt_reference_overrides), ['new'])
  // Replacing again in one graph transaction is not a disconnection.
  const replaced = { ...next, nodes: [{ ...target, settings: { prompt_reference_overrides: { old: 'third' } } }] } as unknown as CanvasGraph
  assert.deepEqual(disconnectRemovedPromptReplacements(previous, replaced).nodes[0].settings.prompt_reference_overrides, { old: 'third' })
})
