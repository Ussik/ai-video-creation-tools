import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useAssetDownload } from '../src/features/assets/useAssetDownload'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
after(() => dom.window.close())
function Harness({ ids }: { ids: string[] }) {
  const [notice, setNotice] = useState(''), control = useAssetDownload(setNotice)
  return <><button disabled={control.downloading} onClick={() => void control.download('project', ids)}>{control.downloading ? '准备下载' : '下载'}</button><output>{notice}</output></>
}
async function mount(ids: string[]) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(() => root.render(<Harness ids={ids} />))
  return { container, button: container.querySelector('button')!, async close() { await act(() => root.unmount()); container.remove() } }
}

test('eight assets trigger exactly one native download and pending duplicate clicks do not create another request', async t => {
  const ids = Array.from({ length: 8 }, (_, index) => `video-${index}`), clicks: Array<{ href: string; filename: string; target: string }> = []
  let resolve!: (response: Response) => void, requests = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    requests++; assert.equal(url, '/api/projects/project/asset-downloads'); assert.equal(init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(init?.body)), { asset_ids: ids })
    return new Promise<Response>(done => { resolve = done })
  })
  t.mock.method(dom.window.HTMLAnchorElement.prototype, 'click', function (this: HTMLAnchorElement) { clicks.push({ href: this.getAttribute('href')!, filename: this.download, target: this.target }) })
  const view = await mount(ids)
  try {
    // Two clicks in the same event turn must be guarded before React rerenders.
    await act(() => { view.button.click(); view.button.click() })
    assert.equal(requests, 1); assert.equal(view.button.disabled, true); assert.equal(view.button.textContent, '准备下载')
    assert.equal(clicks.length, 0)
    await act(async () => { resolve(Response.json({ url: '/api/projects/project/asset-downloads/ready', filename: '项目-素材-8.zip', count: 8 })) })
    assert.deepEqual(clicks, [{ href: '/api/projects/project/asset-downloads/ready', filename: '项目-素材-8.zip', target: '' }])
    assert.match(view.container.querySelector('output')!.textContent!, /包含 8 个素材/)
    assert.equal(view.button.disabled, false)
    assert.equal(document.querySelectorAll('a').length, 0)
  } finally { await view.close() }
})

test('failed preparation starts no download, reports the file error and permits retry', async t => {
  let failed = true, clicks = 0
  t.mock.method(globalThis, 'fetch', async () => failed ? Response.json({ detail: '素材文件不存在或无法读取：丢失.mp4' }, { status: 404 })
    : Response.json({ url: '/api/projects/project/asset-downloads/retry', filename: '镜头.mp4', count: 1 }))
  t.mock.method(dom.window.HTMLAnchorElement.prototype, 'click', () => { clicks++ })
  const view = await mount(['video'])
  try {
    await act(async () => view.button.click())
    assert.equal(clicks, 0); assert.equal(view.button.disabled, false)
    assert.match(view.container.querySelector('output')!.textContent!, /丢失\.mp4/)
    assert.doesNotMatch(view.container.querySelector('output')!.textContent!, /已开始下载/)
    failed = false
    await act(async () => view.button.click())
    assert.equal(clicks, 1); assert.match(view.container.querySelector('output')!.textContent!, /已开始下载素材/)
  } finally { await view.close() }
})

test('one asset downloads its original filename and format', async t => {
  const clicks: string[] = []
  t.mock.method(globalThis, 'fetch', async () => Response.json({ url: '/api/projects/project/asset-downloads/single', filename: '雨夜.mp4', count: 1 }))
  t.mock.method(dom.window.HTMLAnchorElement.prototype, 'click', function (this: HTMLAnchorElement) { clicks.push(this.download) })
  const view = await mount(['video'])
  try { await act(async () => view.button.click()); assert.deepEqual(clicks, ['雨夜.mp4']) }
  finally { await view.close() }
})
