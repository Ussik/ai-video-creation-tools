import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { register } from 'node:module'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import { parsePromptSectionDocument, resolvePromptSectionSource } from '@video-studio/shared/visuals/prompt-section-document'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'MutationObserver', 'Event', 'MouseEvent', 'KeyboardEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
const { createRoot } = await import('react-dom/client')
const { default: Status } = await import('../src/features/canvas/CanvasPromptDocumentStatus')
after(() => dom.window.close())

test('removed requirements have a visible recovery action outside the collapsed source panel', async () => {
  const source = '【项目画风约束】\n手绘纸张纹理\n【项目画风约束结束】'
  const sections = parsePromptSectionDocument(source, { sourceText: source })
  const block = sections.blocks.find(block => block.kind === 'managed')!
  block.deleted = true; block.text = ''
  const before = structuredClone(sections), decisions: Array<[string, string]> = []
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(() => root.render(<MantineProvider env="test"><Status document={sections} references={[]} disabled={false}
      onResolve={(id, choice) => { decisions.push([id, choice]) }} /></MantineProvider>))
    const removed = container.querySelector('[aria-label="已移除的提示词区块"]')!
    assert.ok(removed)
    assert.equal(removed.closest('.workspace-disclosure'), null)
    assert.match(removed.textContent!, /生成时不会发送/)
    const restore = removed.querySelector<HTMLButtonElement>('[aria-label="恢复来源内容：项目画风约束"]')!
    assert.ok(restore)
    await act(() => restore.click())
    assert.deepEqual(decisions, [[block.id, 'follow_source']])
    assert.deepEqual(sections, before, 'viewing and invoking the callback do not mutate the supplied document')
  } finally { await act(() => root.unmount()); container.remove() }
})

test('a removed requirement with pending source is excluded from confirmations and restores the latest source', async () => {
  const source = '【项目画风约束】\n旧画风\n【项目画风约束结束】'
  const sections = parsePromptSectionDocument(source, { sourceText: source })
  const block = sections.blocks.find(block => block.kind === 'managed')!
  block.deleted = true; block.text = ''; block.pendingSourceText = source.replace('旧画风', '最新画风')
  block.mergeBaseText = source; block.sourceStatus = 'source_changed'
  const before = structuredClone(sections), restored: string[] = []
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(() => root.render(<MantineProvider env="test"><Status document={sections} references={[]} disabled={false}
      onResolve={(id, choice) => { restored.push(resolvePromptSectionSource(sections, id, choice).blocks.find(block => block.id === id)!.text) }} /></MantineProvider>))
    assert.doesNotMatch(container.querySelector('.pc-prompt-document-status')!.textContent!, /项待确认|保留本节点修改/)
    assert.equal(container.querySelector('.pc-prompt-source-row .mantine-Badge-label')?.textContent, '已移除')
    const restore = container.querySelector<HTMLButtonElement>('[aria-label="恢复来源内容：项目画风约束"]')!
    assert.ok(restore)
    await act(() => restore.click())
    assert.deepEqual(restored, [block.pendingSourceText])
    assert.deepEqual(sections, before)
  } finally { await act(() => root.unmount()); container.remove() }
})

test('source labels describe node parameters and disabled comparison actions cannot resolve pending content', async () => {
  const source = '【视频生成要求】\n视频时长：5 秒\n【视频生成要求结束】'
  const sections = parsePromptSectionDocument(source, { sourceText: source })
  const block = sections.blocks.find(block => block.kind === 'managed')!
  block.text = source.replace('5 秒', '8 秒'); block.pendingSourceText = source.replace('5 秒', '10 秒')
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container), decisions: string[] = []
  try {
    await act(() => root.render(<MantineProvider env="test"><Status document={sections} references={[]} disabled
      onResolve={id => { decisions.push(id) }} /></MantineProvider>))
    assert.match(container.textContent!, /来源：本节点视频参数/)
    assert.doesNotMatch(container.textContent!, /跟随项目|当前项目提供/)
    const compare = container.querySelector<HTMLButtonElement>('[aria-label="查看区块差异：视频生成要求"]')!
    await act(() => compare.click())
    const dialog = document.querySelector('[role="dialog"]')!
    assert.ok(dialog.querySelector('[aria-label="本节点内容变化"] [data-change="removed"]'))
    assert.match(dialog.querySelector('[aria-label="来源更新"] [data-change="added"]')!.textContent!, /10 秒/)
    const resolve = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '使用来源更新')!
    assert.equal(resolve.disabled, true)
    await act(() => resolve.click())
    assert.deepEqual(decisions, [])
  } finally { await act(() => root.unmount()); container.remove() }
})

test('source history stays collapsed and prioritizes pending decisions without duplicating removed recovery actions', async () => {
  const main = '【设定图固定要求】\n人物三视图。\n【设定图固定要求结束】'
  const style = '【项目画风约束】\n木刻。\n【项目画风约束结束】'
  const parameters = '【图片生成要求】\n画面比例：16:9\n【图片生成要求结束】'
  const sections = parsePromptSectionDocument(`${main}\n\n${style}\n\n${parameters}`, { sourceText: `${main}\n\n${style}\n\n${parameters}` })
  const removed = sections.blocks.find(block => block.name === '设定图固定要求')!
  removed.text = ''; removed.deleted = true
  const pending = sections.blocks.find(block => block.name === '图片生成要求')!
  pending.pendingSourceText = parameters.replace('16:9', '9:16'); pending.sourceStatus = 'source_changed'
  const before = structuredClone(sections), decisions: Array<[string, string]> = []
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(() => root.render(<MantineProvider env="test"><Status document={sections} references={[]} disabled={false}
      onResolve={(id, choice) => { decisions.push([id, choice]) }} /></MantineProvider>))
    const history = container.querySelector('.pc-prompt-document-status')!
    const toggle = history.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.match(toggle.textContent!, /来源与修改记录1 项待确认/)
    assert.match(container.querySelector('.pc-prompt-source-row')!.textContent!, /^图片生成要求待确认/)
    assert.match(history.textContent!, /来源：项目画风/)
    assert.match(history.textContent!, /来源：本节点图片参数/)
    assert.doesNotMatch(history.textContent!, /生成参数 · 来源：|画风 · 来源：/)
    assert.equal(container.querySelectorAll('[aria-label="恢复来源内容：主要创作内容"]').length, 1)
    assert.equal(history.querySelector('[aria-label="沿用来源内容：主要创作内容"]'), null)
    await act(() => toggle.click())
    await act(() => history.querySelector<HTMLButtonElement>('[aria-label="保留本节点修改：图片生成要求"]')!.click())
    await act(() => history.querySelector<HTMLButtonElement>('[aria-label="沿用来源内容：图片生成要求"]')!.click())
    assert.deepEqual(decisions, [[pending.id, 'keep_custom'], [pending.id, 'follow_source']])
    assert.deepEqual(sections, before)
  } finally { await act(() => root.unmount()); container.remove() }
})

test('disabled source history keeps comparison available and prevents every recovery or source decision', async () => {
  const source = '【设定图固定要求】\n原始三视图。\n【设定图固定要求结束】'
  const sections = parsePromptSectionDocument(source, { sourceText: source })
  const removed = sections.blocks.find(block => block.kind === 'managed')!
  removed.text = ''; removed.deleted = true
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container), decisions: string[] = []
  try {
    await act(() => root.render(<MantineProvider env="test"><Status document={sections} references={[]} disabled
      onResolve={id => { decisions.push(id) }} /></MantineProvider>))
    const recovery = container.querySelector<HTMLButtonElement>('[aria-label="恢复来源内容：主要创作内容"]')!
    assert.equal(recovery.disabled, true)
    await act(() => recovery.click())
    const compare = container.querySelector<HTMLButtonElement>('[aria-label="查看区块差异：主要创作内容"]')!
    assert.equal(compare.disabled, false)
    await act(() => compare.click())
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /此内容已移除/)
    assert.deepEqual(decisions, [])
  } finally { await act(() => root.unmount()); container.remove() }
})

test('dialog history keeps status counts visible and returns from comparison without changing source content', async () => {
  const style = '【项目画风约束】\n木刻。\n【项目画风约束结束】'
  const image = '【图片生成要求】\n画面比例：16:9\n【图片生成要求结束】'
  const sections = parsePromptSectionDocument(`${style}\n\n${image}`, { sourceText: `${style}\n\n${image}` })
  const removed = sections.blocks.find(block => block.name === '项目画风约束')!
  removed.deleted = true; removed.text = ''
  const pending = sections.blocks.find(block => block.name === '图片生成要求')!
  pending.pendingSourceText = image.replace('16:9', '9:16'); pending.sourceStatus = 'source_changed'
  const before = structuredClone(sections), decisions: string[] = []
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  try {
    await act(() => root.render(<MantineProvider env="test"><Status document={sections} references={[]} disabled presentation="dialog"
      onResolve={id => { decisions.push(id) }} /></MantineProvider>))
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="查看来源与修改记录"]')!
    assert.match(trigger.textContent!, /来源记录1 项待确认1 项已移除/)
    assert.equal(container.querySelector('.workspace-disclosure'), null)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    await act(() => trigger.click())
    let dialog = document.querySelector('[role="dialog"]')!
    assert.match(dialog.textContent!, /已移除 1 项要求，生成时不会发送/)
    assert.equal(dialog.querySelector<HTMLButtonElement>('[aria-label="恢复来源内容：项目画风约束"]')!.disabled, true)
    await act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="查看区块差异：图片生成要求"]')!.click())
    dialog = document.querySelector('[role="dialog"]')!
    assert.match(dialog.textContent!, /图片生成要求 · 内容对比/)
    assert.match(dialog.querySelector('[aria-label="来源更新"]')!.textContent!, /9:16/)
    await act(() => dialog.querySelector<HTMLButtonElement>('.mantine-Modal-close')!.click())
    dialog = document.querySelector('[role="dialog"]')!
    assert.match(dialog.textContent!, /来源与修改记录/)
    await act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="关闭来源与修改记录"]')!.click())
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.deepEqual(decisions, [])
    assert.deepEqual(sections, before)
  } finally { await act(() => root.unmount()); container.remove() }
})
