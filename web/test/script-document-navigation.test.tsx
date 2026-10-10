import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { useScriptDocumentNavigation } from '../src/useScriptDocumentNavigation'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'KeyboardEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())

type Section = 'outline' | 'synopsis' | 'world' | 'relationships' | 'characters' | 'episode-1'
const offsets: Record<Section, number> = { outline: 200, synopsis: 800, world: 1800, relationships: 2400, characters: 200, 'episode-1': 200 }
const storySections: Section[] = ['outline', 'synopsis', 'world', 'relationships']

async function mount(initialSection?: Section, scrollHeight = 3000) {
  const container = document.createElement('div')
  document.body.append(container)
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  dom.window.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId }
  dom.window.cancelAnimationFrame = id => { frames.delete(id) }
  const root = createRoot(container)
  const scrollCalls: ScrollToOptions[] = []
  function Harness({ initial }: { initial?: Section }) {
    const { activeSection, editorRef, selectSection } = useScriptDocumentNavigation<Section>({
      documentId: 'test-script', initialSection: initial, defaultSection: 'outline',
    })
    const sections = activeSection === 'characters' || activeSection === 'episode-1' ? [activeSection] : storySections
    return <>
      <nav>{(Object.keys(offsets) as Section[]).map(section => <button key={section} aria-current={activeSection === section ? 'true' : undefined} onClick={() => selectSection(section)}>{section}</button>)}</nav>
      <button onClick={() => selectSection('outline', true)}>story</button>
      <button onClick={() => selectSection('characters', false, '[data-search-match]')}>find-character</button>
      <article ref={editorRef} style={{ overflowY: 'auto' }}>{sections.map(section => <section key={section} data-script-section={section} ref={element => {
        if (element) element.getBoundingClientRect = () => ({ top: 52 + offsets[section] - element.parentElement!.scrollTop } as DOMRect)
      }}><span data-search-match ref={element => {
        if (element) element.getBoundingClientRect = () => ({ top: 52 + offsets[section] + 900 - editorRef.current!.scrollTop } as DOMRect)
      }} /></section>)}</article>
    </>
  }
  await act(() => root.render(<Harness initial={initialSection} />))
  const editor = container.querySelector('article')!
  Object.defineProperties(editor, { scrollHeight: { value: scrollHeight }, clientHeight: { value: 600 } })
  editor.getBoundingClientRect = () => ({ top: 52 } as DOMRect)
  editor.scrollTo = options => { scrollCalls.push(options as ScrollToOptions) }
  const flushFrames = async () => {
    await act(() => {
      const batch = Array.from(frames.values())
      frames.clear()
      batch.forEach(callback => callback(0))
    })
  }
  return {
    editor, scrollCalls, frames, flushFrames,
    active: () => container.querySelector('button[aria-current="true"]')?.textContent,
    click: async (section: Section | 'story' | 'find-character') => {
      const button = Array.from(container.querySelectorAll('button')).find(element => element.textContent === section)!
      await act(() => button.click())
    },
    scroll: async (top: number) => {
      await act(() => { editor.scrollTop = top; editor.dispatchEvent(new dom.window.Event('scroll')) })
      await flushFrames()
    },
    initial: async (section: Section) => { await act(() => root.render(<Harness initial={section} />)) },
    destroy: async () => { await act(() => root.unmount()); container.remove() },
  }
}

test('one click stays selected while smooth scrolling crosses previous sections and settles', async () => {
  const view = await mount()
  try {
    await view.click('world')
    assert.equal(view.active(), 'world')
    await view.flushFrames()
    assert.deepEqual(view.scrollCalls, [{ top: 1784, behavior: 'smooth' }])
    await view.scroll(700)
    await view.scroll(1000)
    await view.scroll(1784)
    assert.equal(view.active(), 'world')
    await view.scroll(1000)
    assert.equal(view.active(), 'synopsis', 'manual scrolling resumes directory tracking')
  } finally { await view.destroy() }
})

test('manual scrolling follows the heading even when the previous long section is visible', async () => {
  const view = await mount()
  try {
    await view.scroll(1784)
    assert.equal(view.active(), 'world')
    await view.scroll(1700)
    assert.equal(view.active(), 'synopsis')
    await view.scroll(2400)
    assert.equal(view.active(), 'relationships', 'the final section is selected at the document bottom')
  } finally { await view.destroy() }
})

test('quick consecutive clicks cancel obsolete positioning and keep the last selection', async () => {
  const view = await mount()
  try {
    await view.click('synopsis')
    await view.click('world')
    await view.flushFrames()
    assert.deepEqual(view.scrollCalls, [{ top: 1784, behavior: 'smooth' }])
    await view.scroll(1000)
    await view.click('relationships')
    await view.flushFrames()
    await view.scroll(1784)
    assert.equal(view.active(), 'relationships')
    await view.scroll(2384)
    assert.equal(view.active(), 'relationships')
  } finally { await view.destroy() }
})

test('user scrolling interrupts navigation and restores the current reading position', async () => {
  const view = await mount()
  try {
    await view.click('world')
    await view.flushFrames()
    await view.scroll(1000)
    await act(() => view.editor.dispatchEvent(new dom.window.Event('wheel')))
    await view.flushFrames()
    assert.equal(view.active(), 'synopsis')
    assert.deepEqual(view.scrollCalls.at(-1), { top: 1000, behavior: 'instant' })
    await view.scroll(1800)
    assert.equal(view.active(), 'world')
  } finally { await view.destroy() }
})

test('a section near the document end remains selected when its scroll destination is clamped', async () => {
  const view = await mount(undefined, 2700)
  try {
    await view.click('relationships')
    await view.flushFrames()
    assert.deepEqual(view.scrollCalls.at(-1), { top: 2100, behavior: 'smooth' })
    await view.scroll(1900)
    await view.scroll(2100)
    assert.equal(view.active(), 'relationships')
    await view.scroll(2000)
    assert.equal(view.active(), 'world')
  } finally { await view.destroy() }
})

test('manual input before the next frame cancels scheduled navigation', async () => {
  const view = await mount()
  try {
    await view.click('world')
    await act(() => view.editor.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'PageDown' })))
    await view.flushFrames()
    assert.deepEqual(view.scrollCalls, [{ top: 0, behavior: 'instant' }])
    assert.equal(view.active(), 'outline')
    await view.scroll(1000)
    assert.equal(view.active(), 'synopsis')
  } finally { await view.destroy() }
})

test('standalone and episode views reset their scroll and can return to a story section', async () => {
  const view = await mount()
  try {
    await view.scroll(1000)
    for (const section of ['characters', 'episode-1'] as Section[]) {
      await view.click(section)
      await view.flushFrames()
      assert.deepEqual(view.scrollCalls.at(-1), { top: 0, behavior: 'smooth' })
      await view.scroll(0)
      assert.equal(view.active(), section)
    }
    await view.click('world')
    await view.flushFrames()
    await view.scroll(1784)
    assert.equal(view.active(), 'world')
    await view.click('story')
    await view.flushFrames()
    assert.deepEqual(view.scrollCalls.at(-1), { top: 0, behavior: 'smooth' })
    await view.scroll(0)
    assert.equal(view.active(), 'outline')
  } finally { await view.destroy() }
})

test('initial section changes locate the requested document and unmount cancels pending work', async () => {
  const view = await mount('world')
  await view.flushFrames()
  assert.deepEqual(view.scrollCalls.at(-1), { top: 1784, behavior: 'smooth' })
  await view.scroll(1784)
  assert.equal(view.active(), 'world')
  await view.initial('characters')
  await view.flushFrames()
  assert.deepEqual(view.scrollCalls.at(-1), { top: 0, behavior: 'smooth' })
  assert.equal(view.active(), 'characters')
  await view.click('world')
  assert.equal(view.frames.size, 1)
  await view.destroy()
  assert.equal(view.frames.size, 0)
})

test('a search result in a standalone document scrolls to the match and keeps its directory selected', async () => {
  const view = await mount()
  try {
    await view.scroll(1000)
    await view.click('find-character')
    await view.flushFrames()
    assert.deepEqual(view.scrollCalls.at(-1), { top: 800, behavior: 'smooth' })
    await view.scroll(400)
    await view.scroll(800)
    assert.equal(view.active(), 'characters')
  } finally { await view.destroy() }
})

test('a search result scrolls the page when the mobile document has no independent scroll container', async () => {
  const view = await mount()
  try {
    view.editor.style.overflowY = 'visible'
    let scrolled = false
    dom.window.HTMLElement.prototype.scrollIntoView = options => { scrolled = (options as ScrollIntoViewOptions).block === 'center' }
    await view.click('find-character')
    await view.flushFrames()
    assert.equal(scrolled, true)
    assert.equal(view.active(), 'characters')
  } finally { await view.destroy() }
})
