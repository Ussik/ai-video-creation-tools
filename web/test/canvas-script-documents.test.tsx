import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import { scriptArtifactLabels, scriptStageArtifacts, type StageArtifactType } from '@video-studio/shared/script/script-stage-content'
import type { ScriptArtifact, ScriptGenerationProgress } from '../src/shared/api/api'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'DOMParser']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
const { createRoot } = await import('react-dom/client')
const { default: CanvasScriptDocuments } = await import('../src/features/canvas/CanvasScriptDocuments')
after(() => dom.window.close())

type Props = React.ComponentProps<typeof CanvasScriptDocuments>
const column = (type: StageArtifactType, content = `${type}完整正文`) => ({ artifact_type: type, title: `${scriptArtifactLabels[type]}标题`, content, episode_number: 0 })
const progress = (...types: StageArtifactType[]): ScriptGenerationProgress => ({ updated_at: '2026-11-09T14:00:00Z', documents: types.map(type => column(type)) })
const accepted = (type: StageArtifactType, content = `${type}正式正文`): ScriptArtifact => ({ ...column(type, content), id: `${type}-saved`, project_id: 'project', status: 'ready', position: 0,
  created_at: '2026-11-09T12:00:00Z', updated_at: '2026-11-09T12:00:00Z' })
async function mount(initial: Partial<Props> = {}) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  let props: Props = { section: 'outline', onOpenDirector() {}, ...initial }
  async function update(next: Partial<Props> = {}) {
    props = { ...props, ...next }
    await act(() => root.render(<MantineProvider env="test"><CanvasScriptDocuments {...props} /></MantineProvider>))
  }
  await update()
  return { container, update, async destroy() { await act(() => root.unmount()); container.remove() } }
}
test('a completed overview is readable before any sibling column or stage confirmation exists', async () => {
  const view = await mount({ progress: progress('outline') })
  try {
    assert.match(view.container.textContent!, /outline完整正文/)
    assert.match(view.container.textContent!, /已保存草稿 · 待确认/)
    assert.doesNotMatch(view.container.textContent!, /暂无故事大纲/)
    assert.equal(view.container.querySelectorAll('.pc-script-document-reader').length, 1)
    assert.equal(view.container.querySelector('.pc-script-document-list'), null)
    assert.equal(view.container.querySelector('button'), null)
    await view.update({ progress: structuredClone(progress('outline')) })
    assert.match(view.container.textContent!, /outline完整正文/, 'rereading saved progress after a failed sibling retains the document')
  } finally { await view.destroy() }
})

test('outline columns display their complete text in order without a selector grid', async () => {
  const value = progress(...scriptStageArtifacts.outline), view = await mount({ progress: value })
  try {
    assert.equal(view.container.querySelector('.pc-script-document-list'), null)
    const readers = [...view.container.querySelectorAll('.pc-script-document-reader')]
    assert.equal(readers.length, 9)
    assert.deepEqual(readers.map(reader => reader.querySelector('.pc-rich-text-preview')!.textContent),
      scriptStageArtifacts.outline.map(type => `${type}完整正文`))
    await view.update({ progress: { ...structuredClone(value), updated_at: '2026-11-09T14:05:00Z' } })
    assert.equal(view.container.querySelectorAll('.pc-rich-text-preview').length, 9)
    assert.match(view.container.querySelector('.pc-script-document-reader:last-child')!.textContent!, /episode_outline完整正文/, 'progress refresh retains the final column')
  } finally { await view.destroy() }
})

test('character, location and prop tabs expose their associated columns independently', async () => {
  for (const section of ['characters', 'locations', 'props'] as const) {
    const types = scriptStageArtifacts[section]
    const view = await mount({ section, progress: progress('outline', ...types) })
    try {
      assert.equal(view.container.querySelectorAll('.pc-script-document-reader').length, types.length)
      assert.equal(view.container.querySelector('[aria-label="概要设计正文"]'), null)
      for (const type of types) {
        const reader = view.container.querySelector(`[aria-label="${scriptArtifactLabels[type]}正文"]`)
        assert.ok(reader)
        assert.match(reader.textContent!, new RegExp(`${type}完整正文`))
      }
    } finally { await view.destroy() }
  }
})

test('a regenerated column keeps both candidate and accepted original accessible without mutation', async () => {
  const saved = accepted('outline'), before = structuredClone(saved), opened: ScriptArtifact[] = []
  const view = await mount({ artifacts: [saved], progress: progress('outline'), onOpenDocument: item => opened.push(item) })
  try {
    assert.match(view.container.textContent!, /outline完整正文/)
    assert.match(view.container.textContent!, /outline正式正文/)
    const readers = [...view.container.querySelectorAll('.pc-script-document-reader')]
    assert.equal(readers.length, 2)
    assert.match(readers[0]!.textContent!, /已保存草稿 · 待确认/)
    assert.equal(readers[0]!.querySelector('button'), null, 'pending prose does not expose the accepted editor')
    assert.doesNotMatch(readers[1]!.textContent!, /已保存草稿/)
    const edit = readers[1]!.querySelector<HTMLButtonElement>('button')!
    assert.ok(edit); await act(() => edit.click())
    assert.deepEqual(opened, [saved]); assert.deepEqual(saved, before)
    await view.update({ progress: null })
    assert.equal(view.container.querySelectorAll('.pc-script-document-reader').length, 1)
    assert.match(view.container.textContent!, /outline正式正文/, 'discard returns the reading surface to the accepted original')
    assert.doesNotMatch(view.container.textContent!, /outline完整正文/)
  } finally { await view.destroy() }
})

test('confirmation displays the accepted document even if an old progress response overlaps the refresh', async () => {
  const value = progress('outline'), view = await mount({ progress: value })
  try {
    const saved = { ...accepted('outline'), ...value.documents[0]! }
    await view.update({ artifacts: [saved] })
    assert.equal(view.container.querySelectorAll('.pc-script-document-reader').length, 1)
    assert.doesNotMatch(view.container.textContent!, /已保存草稿/)
    assert.match(view.container.textContent!, /已保存文档/)
    await view.update({ progress: null })
    assert.match(view.container.textContent!, /outline完整正文/)
  } finally { await view.destroy() }
})

test('legacy outline and character text remains readable alongside completed related columns', async () => {
  const view = await mount({ outline: '旧大纲正文', progress: progress('synopsis') })
  try {
    assert.match(view.container.textContent!, /旧大纲正文/)
    assert.match(view.container.textContent!, /synopsis完整正文/)
    await view.update({ section: 'characters', outline: '', characters: '旧人物正文', progress: progress('relationships') })
    assert.match(view.container.textContent!, /旧人物正文/)
    assert.match(view.container.textContent!, /relationships完整正文/)
  } finally { await view.destroy() }
})

test('episode cards still open saved scripts and pending episode text stays visibly unconfirmed', async () => {
  const saved = { ...accepted('episode_script'), episode_number: 2 }, opened: ScriptArtifact[] = []
  const view = await mount({ section: 'episodes', artifacts: [saved], onOpenDocument: item => opened.push(item) })
  try {
    const savedButton = view.container.querySelector<HTMLButtonElement>('.pc-script-episodes button')!
    assert.ok(savedButton); await act(() => savedButton.click())
    assert.deepEqual(opened, [saved])
    await view.update({ progress: { ...progress('episode_script'), documents: [{ ...column('episode_script'), episode_number: 3 }] } })
    assert.equal(view.container.querySelectorAll('.pc-script-document-reader').length, 2)
    assert.match(view.container.textContent!, /episode_script正式正文/)
    assert.match(view.container.textContent!, /episode_script完整正文/)
    assert.match(view.container.textContent!, /已保存草稿 · 待确认/)
    assert.deepEqual(opened, [saved], 'reading a draft does not invoke the formal screenplay editor')
  } finally { await view.destroy() }
})
