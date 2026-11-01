import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { ScriptActivity } from '@video-studio/shared/script/script-activity-types'
import type { ScriptDraftResolution } from '@video-studio/shared/script/script-draft-resolution'
import { createScriptRequestUsage } from '@video-studio/shared/script/script-request-usage'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'HTMLTextAreaElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: DirectorActivity } = await import('../src/features/script/DirectorActivity')
const { default: DirectorCandidatePreview } = await import('../src/features/script/DirectorCandidatePreview')
const { default: DirectorDraftResolution } = await import('../src/features/script/DirectorDraftResolution')
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch; dom.window.close() })

async function mount(node: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const update = async (next: React.ReactNode) => { await act(() => root.render(<MantineProvider env="test">{next}</MantineProvider>)) }
  await update(node)
  return { container, update, async destroy() { await act(() => root.unmount()); container.remove() } }
}
function button(scope: ParentNode, label: string) {
  const node = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)
  assert.ok(node, label); return node
}
const resolution: ScriptDraftResolution = { id: 'candidate', version: 'candidate-v3', stage: 'outline', episode_number: 0, document_count: 1,
  findings: [{ source_key: 'world', kind: 'contradiction', quote: '必须先取得神位。', explanation: '人物身份冲突。', suggestion: '保留原稿。' }],
  run: { strategy: 'ai', status: 'running', completed: 1, total: 1 } }
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }) }
function payload(version = resolution.version, content = '候选正文，保留神位设定。') {
  return { id: resolution.id, version, draft: { stage: 'outline', episode_number: 0,
    artifacts: [{ artifact_type: 'world', title: '背景设定', content }], scenes: [] } }
}

test('creative task progress omits usage and capacity from current, historical and expanded call records', async () => {
  const current = { ...createScriptRequestUsage(), requests: 2, input_tokens: 100, output_tokens: 200, reasoning_tokens: 150,
    estimated_input_tokens: 20, estimated_output_tokens: 30, uncertain_requests: 1 }
  const cumulative = { ...createScriptRequestUsage(), requests: 91, input_tokens: 2000, output_tokens: 3000, reasoning_tokens: 1000 }
  const event: ScriptActivity = { id: 'task', kind: 'context', scope: 'task', status: 'running', label: '补齐候选草稿', summary: '正在复核人物与事件', started_at: 1,
    usage: { current, cumulative, limits: { max_requests: 20, max_tokens: 10000 } } }
  const records: ScriptActivity[] = [event, { ...event, id: 'ledger', label: '本轮模型用量', summary: '91 次请求 · 5,000 tokens', scope: 'notice', sequence: 9 },
    { ...event, id: 'child', parent_id: 'task', scope: 'step', sequence: 7, label: '核对人物身份' },
    { ...event, id: 'model', parent_id: 'child', kind: 'model', scope: 'step', label: '核对正文', name: 'review_candidate',
      input_tokens: 1100, output_tokens: 2200, reasoning_tokens: 3300, output_limit: 4400, estimated_input_tokens: 5500,
      context_window_tokens: 6600, reserved_output_tokens: 7700, request_bytes: 8800, response_chars: 9900,
      attempt: 12, round: 8, input: '已完成的人物设定', output: '当前身份一致。' }]
  const before = structuredClone(records)
  const view = await mount(<DirectorActivity activity={records} pending />)
  try {
    assert.match(view.container.querySelector('[aria-label="本轮任务清单"]')!.textContent!, /补齐候选草稿.*正在复核人物与事件/)
    await act(() => button(view.container, '查看执行步骤').click())
    assert.match(view.container.textContent!, /当前身份一致。/)
    assert.doesNotMatch(view.container.textContent!, /tokens|Token|容量预检|模型上下文容量|输入估算|输出预留|请求输出上限|本轮模型用量|次请求|发送.*字节|返回 9,900 字/)
    assert.equal(view.container.querySelector('.sd-request-usage'), null)
    assert.deepEqual(records, before, 'presentation does not erase persisted provider diagnostics')
    await view.update(<DirectorActivity activity={[{ id: 'legacy', kind: 'context', scope: 'task', label: '历史步骤', summary: '历史记录', status: 'succeeded', started_at: 1 }]} />)
    assert.match(view.container.querySelector('[aria-label="本轮任务清单"]')!.textContent!, /历史步骤.*已完成.*历史记录/)
    await view.update(<DirectorActivity activity={[records[1]!]} />)
    assert.equal(view.container.querySelector('.sd-activity'), null, 'a legacy usage ledger alone does not create a fake task')
  } finally { await view.destroy() }
})

test('task results remain readable during later work, update with their activity and never save or restart work', async () => {
  let stops = 0, continues = 0
  globalThis.fetch = async () => assert.fail('activity preview must use the retained result without another request')
  const tasks: ScriptActivity[] = [
    { id: 'root', kind: 'context', scope: 'task', status: 'running', label: '整理故事大纲', summary: '各项成果完成后统一核对', started_at: 1 },
    { id: 'synopsis', parent_id: 'root', kind: 'context', scope: 'task', status: 'succeeded', label: '故事简述', summary: '主线与结局已整理，可先阅读', started_at: 2,
      artifact_preview: { stage: 'outline', scope: 'project', episode_number: 0, artifacts: [{ artifact_type: 'synopsis', title: '故事简述', content: '第一版主线与结局。' }], scenes: [] } },
    { id: 'world', parent_id: 'root', kind: 'context', scope: 'task', status: 'running', label: '背景设定', summary: '正在整理世界规则', started_at: 3 },
  ]
  const callbacks = { onStop: () => { stops++ }, onContinue: () => { continues++ } }
  const view = await mount(<DirectorActivity activity={tasks} pending {...callbacks} />)
  try {
    const checklist = view.container.querySelector('[aria-label="本轮任务清单"]')!
    assert.match(checklist.textContent!, /故事简述已完成.*主线与结局已整理，可先阅读.*背景设定进行中.*正在整理世界规则/)
    assert.equal(view.container.querySelectorAll('.sd-activity-task').length, 3)
    assert.equal([...view.container.querySelectorAll('button')].some(node => node.textContent === '继续未完成步骤'), false)
    await act(() => button(view.container, '预览成果').click())
    const dialog = document.querySelector('[role="dialog"]')!
    assert.match(dialog.textContent!, /第一版主线与结局。/)
    assert.match(dialog.textContent!, /候选成果.*最终确认以本轮任务状态为准.*不会正式保存文档/)
    assert.equal(dialog.querySelector('textarea, [contenteditable="true"]'), null)
    assert.equal([...dialog.querySelectorAll('button')].some(node => /确认保存|编辑|重新生成/.test(node.textContent || '')), false)
    const updated = structuredClone(tasks)
    updated[1]!.artifact_preview!.artifacts[0]!.content = '当前更新后的完整主线。'
    await view.update(<DirectorActivity activity={updated} pending {...callbacks} />)
    assert.match(dialog.textContent!, /当前更新后的完整主线。/)
    assert.doesNotMatch(dialog.textContent!, /第一版主线与结局。/)
    await act(() => button(dialog, '关闭预览').click())
    await act(() => button(view.container, '停止任务').click())
    assert.equal(stops, 1); assert.equal(continues, 0)
    await view.update(<DirectorActivity activity={updated} failed {...callbacks} />)
    await act(() => button(view.container, '继续未完成步骤').click())
    assert.equal(continues, 1)
    assert.match(view.container.querySelector('[aria-label="本轮任务清单"]')!.textContent!, /背景设定未记录完成/)
    assert.equal(button(view.container, '预览成果').disabled, false)
  } finally { await view.destroy(); globalThis.fetch = originalFetch }
})

test('retained candidate preview stays available while repair is busy and never submits another repair', async () => {
  let previews = 0
  const view = await mount(<DirectorDraftResolution resolution={resolution} opened={false} busy onClose={() => {}} onOpen={() => {}}
    onPreview={() => previews++} onResolve={() => assert.fail('preview must not start a repair')} onDiscard={() => assert.fail('preview must preserve candidate')} />)
  try {
    assert.equal(button(view.container, '查看候选稿').disabled, false)
    assert.match(view.container.textContent!, /修订完成不等于复核通过/)
    await act(() => button(view.container, '查看候选稿').click())
    assert.equal(previews, 1)
  } finally { await view.destroy() }
})

test('candidate preview only reads the exact retained version and exposes no editing or save controls', async () => {
  const requests: Array<{ url: string; method: string }> = []
  globalThis.fetch = async (input, init) => { requests.push({ url: String(input), method: init?.method || 'GET' }); return response(payload()) }
  const view = await mount(<DirectorCandidatePreview projectId="project" resolution={resolution} opened onClose={() => {}} onRefresh={async () => {}} />)
  try {
    assert.deepEqual(requests, [{ url: '/api/projects/project/script/director/resolutions/candidate?version=candidate-v3', method: 'GET' }])
    const dialog = document.querySelector('[role="dialog"]')!
    assert.match(dialog.textContent!, /候选正文，保留神位设定/)
    assert.match(dialog.textContent!, /尚未通过最终复核，也未正式保存/)
    assert.equal(dialog.querySelector('textarea, [contenteditable="true"]'), null)
    assert.equal([...dialog.querySelectorAll('button')].some(node => /确认保存|编辑/.test(node.textContent || '')), false)
  } finally { await view.destroy(); globalThis.fetch = originalFetch }
})

test('a changed candidate version cannot display stale contents and provides state refresh', async () => {
  let refreshes = 0, requests = 0
  globalThis.fetch = async () => { requests++; return response({ detail: '版本不一致' }, 409) }
  const view = await mount(<DirectorCandidatePreview projectId="project" resolution={resolution} opened onClose={() => {}} onRefresh={async () => { refreshes++ }} />)
  try {
    const dialog = document.querySelector('[role="dialog"]')!
    assert.match(dialog.querySelector('[role="alert"]')!.textContent!, /状态已变化，请刷新候选状态/)
    await act(async () => button(dialog, '刷新候选状态').click())
    assert.equal(refreshes, 1); assert.equal(requests, 2)
    assert.equal(dialog.querySelector('.sd-document-page'), null)
  } finally { await view.destroy(); globalThis.fetch = originalFetch }
})

test('an obsolete in-flight preview cannot overwrite a newly retained candidate version', async () => {
  let finishFirst: (value: Response) => void = () => assert.fail('first request not started')
  globalThis.fetch = input => String(input).includes('version=candidate-v3')
    ? new Promise(resolve => { finishFirst = resolve }) : Promise.resolve(response(payload('candidate-v4', '最新候选正文。')))
  const view = await mount(<DirectorCandidatePreview projectId="project" resolution={resolution} opened onClose={() => {}} onRefresh={async () => {}} />)
  try {
    await view.update(<DirectorCandidatePreview projectId="project" resolution={{ ...resolution, version: 'candidate-v4' }} opened onClose={() => {}} onRefresh={async () => {}} />)
    await act(async () => { finishFirst(response(payload('candidate-v3', '已经过期的旧正文。'))) })
    const dialog = document.querySelector('[role="dialog"]')!
    assert.match(dialog.textContent!, /最新候选正文/)
    assert.doesNotMatch(dialog.textContent!, /已经过期的旧正文/)
  } finally { await view.destroy(); globalThis.fetch = originalFetch }
})
