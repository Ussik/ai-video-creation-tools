import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toggleVisualBindingScope, visualBindingScopeEnabled } from '../src/features/visuals/visual-binding-scope'
import type { VisualBindingUsage } from '@video-studio/shared/visuals/visual-binding-usage'

test('changing image or video use always preserves the other output choice, including legacy bindings', () => {
  const values = ['both', 'image', 'video', 'none', undefined] as const
  for (const scope of ['image', 'video'] as const) for (const usage of values) for (const checked of [true, false]) {
    const other = scope === 'image' ? 'video' : 'image'
    const before = { usage }
    const after = { usage: toggleVisualBindingScope(usage, scope, checked) }
    assert.equal(visualBindingScopeEnabled(after, scope), checked, `${scope}/${usage}/${checked}`)
    assert.equal(visualBindingScopeEnabled(after, other), visualBindingScopeEnabled(before, other), 'the other output keeps its explicit saved use')
  }
  const expected: Array<[VisualBindingUsage, 'image' | 'video', boolean, VisualBindingUsage]> = [
    ['both', 'image', false, 'video'], ['image', 'image', false, 'none'],
    ['video', 'image', true, 'both'], ['none', 'image', true, 'image'],
    ['both', 'video', false, 'image'], ['video', 'video', false, 'none'],
    ['image', 'video', true, 'both'], ['none', 'video', true, 'video'],
  ]
  for (const [usage, scope, checked, result] of expected) assert.equal(toggleVisualBindingScope(usage, scope, checked), result)
})

test('unbound candidates and none usage are never selected in an output scope', () => {
  for (const scope of ['image', 'video'] as const) {
    assert.equal(visualBindingScopeEnabled(undefined, scope), false)
    assert.equal(visualBindingScopeEnabled({ usage: 'none' }, scope), false)
    assert.equal(visualBindingScopeEnabled({}, scope), true, 'a saved legacy binding retains both output uses')
  }
  assert.equal(visualBindingScopeEnabled(undefined), false)
  assert.equal(visualBindingScopeEnabled({ usage: 'none' }), true, 'the unscoped management view retains the association')
})
