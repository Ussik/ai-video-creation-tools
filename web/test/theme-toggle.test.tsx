import assert from 'node:assert/strict'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act, useEffect } from 'react'
import { MantineProvider, Portal, TextInput } from '@mantine/core'
import ThemeToggle from '../src/shared/ui/ThemeToggle'
import { theme } from '../src/shared/ui/theme'

const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] })
}
Object.defineProperty(dom.window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
})
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())

async function mount(children: React.ReactNode) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(() => root.render(<MantineProvider theme={theme} defaultColorScheme="dark">{children}</MantineProvider>))
  return { container, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

function stubViewTransition(t: TestContext, start: (callback: () => void) => unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(document, 'startViewTransition')
  Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start })
  t.after(() => {
    if (descriptor) Object.defineProperty(document, 'startViewTransition', descriptor)
    else Reflect.deleteProperty(document, 'startViewTransition')
  })
}

test('switching updates every theme control and the portal scheme without remounting the workspace draft', async () => {
  dom.window.localStorage.clear()
  let mounts = 0
  function Draft() {
    useEffect(() => { mounts++ }, [])
    return <TextInput aria-label="未保存内容" defaultValue="原稿" />
  }
  const view = await mount(<><ThemeToggle /><Draft /><Portal><div data-theme-portal><ThemeToggle /></div></Portal></>)
  try {
    const input = view.container.querySelector<HTMLInputElement>('input')!
    input.value = '未保存的修改'
    const switchToLight = view.container.querySelector<HTMLButtonElement>('button[aria-label="切换到浅色模式"]')!
    assert.ok(switchToLight)
    await act(() => switchToLight.click())
    assert.equal(document.documentElement.dataset.mantineColorScheme, 'light')
    assert.equal(dom.window.localStorage.getItem('mantine-color-scheme-value'), 'light')
    assert.equal(document.querySelectorAll('button[aria-label="切换到深色模式"]').length, 2)
    assert.ok(document.querySelector('[data-theme-portal]')?.closest('body'))
    assert.equal(view.container.querySelector('input'), input)
    assert.equal(input.value, '未保存的修改')
    assert.equal(mounts, 1)
    await act(() => document.querySelector<HTMLButtonElement>('[data-theme-portal] button')!.click())
    assert.equal(document.documentElement.dataset.mantineColorScheme, 'dark')
    assert.equal(document.querySelectorAll('button[aria-label="切换到浅色模式"]').length, 2)
    assert.equal(mounts, 1)
  } finally { await view.destroy() }
})

test('a saved light preference survives a fresh provider and switching back saves dark', async () => {
  dom.window.localStorage.setItem('mantine-color-scheme-value', 'light')
  const view = await mount(<ThemeToggle />)
  try {
    const switchToDark = view.container.querySelector<HTMLButtonElement>('button[aria-label="切换到深色模式"]')!
    assert.ok(switchToDark)
    assert.equal(document.documentElement.dataset.mantineColorScheme, 'light')
    await act(() => switchToDark.click())
    assert.equal(dom.window.localStorage.getItem('mantine-color-scheme-value'), 'dark')
  } finally { await view.destroy() }
  const reopened = await mount(<ThemeToggle />)
  try {
    assert.ok(reopened.container.querySelector('button[aria-label="切换到浅色模式"]'))
    assert.equal(document.documentElement.dataset.mantineColorScheme, 'dark')
  } finally { await reopened.destroy() }
})

test('animated switching originates at the pressed control, covers the viewport and preserves drafts in both directions', async t => {
  dom.window.localStorage.clear()
  let transitions = 0
  let finish!: () => void
  let mounts = 0
  stubViewTransition(t, callback => {
    transitions++
    callback()
    return { ready: Promise.resolve(), finished: new Promise<void>(resolve => { finish = resolve }) }
  })
  function Draft() {
    useEffect(() => { mounts++ }, [])
    return <TextInput aria-label="未保存内容" defaultValue="原稿" />
  }
  const view = await mount(<><ThemeToggle /><Draft /><Portal><div data-theme-portal><ThemeToggle /></div></Portal></>)
  const root = document.documentElement
  try {
    const input = view.container.querySelector<HTMLInputElement>('input')!
    input.value = '动画期间的未保存内容'
    const button = view.container.querySelector<HTMLButtonElement>('button')!
    t.mock.method(button, 'getBoundingClientRect', () => ({ left: 940, top: 24, width: 32, height: 32 }) as DOMRect)
    await act(() => button.click())
    assert.equal(root.dataset.mantineColorScheme, 'light')
    assert.equal(dom.window.localStorage.getItem('mantine-color-scheme-value'), 'light')
    assert.equal(root.style.getPropertyValue('--theme-reveal-x'), '956px')
    assert.equal(root.style.getPropertyValue('--theme-reveal-y'), '40px')
    const radius = parseFloat(root.style.getPropertyValue('--theme-reveal-radius'))
    for (const x of [0, dom.window.innerWidth]) for (const y of [0, dom.window.innerHeight]) {
      assert.ok(radius >= Math.hypot(x - 956, y - 40), 'reveal reaches every viewport corner')
    }
    assert.equal(root.getAttribute('data-theme-transition'), 'expand')
    const portalButton = document.querySelector<HTMLButtonElement>('[data-theme-portal] button')!
    await act(() => portalButton.click())
    assert.equal(transitions, 1, 'concurrent controls cannot start overlapping transitions')
    assert.equal(root.dataset.mantineColorScheme, 'light')
    await act(async () => finish())
    assert.equal(root.hasAttribute('data-theme-transition'), false)
    assert.equal(root.style.getPropertyValue('--theme-reveal-radius'), '')

    t.mock.method(portalButton, 'getBoundingClientRect', () => ({ left: 24, top: 600, width: 32, height: 32 }) as DOMRect)
    await act(() => portalButton.click())
    assert.equal(transitions, 2)
    assert.equal(root.dataset.mantineColorScheme, 'dark')
    assert.equal(root.getAttribute('data-theme-transition'), 'contract')
    assert.equal(root.style.getPropertyValue('--theme-reveal-x'), '40px')
    assert.equal(root.style.getPropertyValue('--theme-reveal-y'), '616px')
    await act(async () => finish())
    assert.equal(root.hasAttribute('data-theme-transition'), false)
    assert.equal(dom.window.localStorage.getItem('mantine-color-scheme-value'), 'dark')
    assert.equal(view.container.querySelector('input'), input)
    assert.equal(input.value, '动画期间的未保存内容')
    assert.equal(mounts, 1)
  } finally { await act(async () => finish()); await view.destroy() }
})

test('reduced motion skips animation and failed transition startup still switches theme', async t => {
  dom.window.localStorage.clear()
  let transitions = 0
  let reducedMotion = true
  t.mock.method(dom.window, 'matchMedia', query => ({ matches: query === '(prefers-reduced-motion: reduce)' && reducedMotion,
    addEventListener() {}, removeEventListener() {} }) as MediaQueryList)
  stubViewTransition(t, () => { transitions++; throw new Error('View transition unavailable') })
  const view = await mount(<ThemeToggle />)
  try {
    await act(() => view.container.querySelector<HTMLButtonElement>('button')!.click())
    assert.equal(transitions, 0)
    assert.equal(document.documentElement.dataset.mantineColorScheme, 'light')
    reducedMotion = false
    await act(() => view.container.querySelector<HTMLButtonElement>('button')!.click())
    assert.equal(transitions, 1)
    assert.equal(document.documentElement.dataset.mantineColorScheme, 'dark')
    assert.equal(document.documentElement.hasAttribute('data-theme-transition'), false)
    assert.equal(document.documentElement.style.getPropertyValue('--theme-reveal-x'), '')
  } finally { await view.destroy() }
})

test('a skipped snapshot releases the transition guard so the theme can be switched again', async t => {
  dom.window.localStorage.clear()
  let transitions = 0
  stubViewTransition(t, callback => {
    transitions++
    callback()
    return { ready: Promise.reject(new Error('Document became hidden')), finished: Promise.resolve() }
  })
  const view = await mount(<ThemeToggle />)
  try {
    await act(() => view.container.querySelector<HTMLButtonElement>('button')!.click())
    assert.equal(document.documentElement.dataset.mantineColorScheme, 'light')
    assert.equal(document.documentElement.hasAttribute('data-theme-transition'), false)
    await act(() => view.container.querySelector<HTMLButtonElement>('button')!.click())
    assert.equal(document.documentElement.dataset.mantineColorScheme, 'dark')
    assert.equal(transitions, 2)
  } finally { await view.destroy() }
})
