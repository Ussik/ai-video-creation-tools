import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import { handoffCountChoice, type HandoffConflict } from '@video-studio/shared/media/video-handoff-conflict'
import type { Job } from '../src/shared/api/api'
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'HTMLAnchorElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'CustomEvent']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}

const { default: ConflictDialog } = await import('../src/features/canvas/CanvasVideoConflictDialog')
const { default: PreparationStatus } = await import('../src/features/canvas/CanvasVideoPreparationStatus')
const { default: JobInformationPopover } = await import('../src/features/jobs/JobInformationPopover')
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())
const video = '灯管闪烁一次（亮-暗-亮）约0.3秒；所有灯管闪烁两次后稳定。', effect = '灯管闪烁两次的啪啪声'
const locations = ['灯管闪烁一次', '所有灯管闪烁两次'].map(quote => ({ field_path: 'video_prompt', quote, start: video.indexOf(quote), end: video.indexOf(quote) + quote.length }))
const conflict: HandoffConflict = { status: 'needs_confirmation', source_signature: '0123456789abcdef', candidate_version: 'a'.repeat(64), shot_version: 'b'.repeat(64), shot_id: 'shot', local_reuse: true, model_request_count: 0,
  conflicts: [{ message: '灯管动作次数与声音不一致', evidence: ['灯管闪烁一次', '所有灯管闪烁两次', effect], suggestion: '选择一次或两次并核对时序',
    locations: [...locations, { field_path: 'audio_plan.sound_effects.0', quote: effect, start: 0, end: effect.length }] }],
  sources: { video_prompt: video, image_body: '保留人物和构图', audio_plan: { version: 1, speech: [{ text: '谁在那里？', speaker: '人物', mode: 'dialogue', source_text: '谁在那里？', delivery: '警觉' }], sound_effects: [effect], music: '', silent: false,
    scene_sound: { ambience: ['通风声'], acoustics: '地下', music_policy: 'timeline' } } },
  candidate: { motion_prompt: '等待确认', audio_plan: { version: 1, speech: [], sound_effects: [], music: '', silent: false } } }
function button(label: string) { const el = [...document.querySelectorAll('button')].find(el => el.textContent === label || el.getAttribute('aria-label') === label); assert.ok(el, label); return el }
async function mount(element: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(<MantineProvider env="test">{element}</MantineProvider>))
  return async () => { await act(() => root.unmount()); container.remove() }
}
test('count preview edits only exact located action and event spans while preserving speech and the sound bed', () => {
  const before = structuredClone(conflict)
  for (const count of ['一', '两'] as const) {
    const result = handoffCountChoice(conflict, count)!
    assert.ok(result.video_prompt.includes(`闪烁${count}次`))
    assert.ok(result.audio_plan!.sound_effects[0]!.includes(`${count}次`))
    assert.deepEqual(result.audio_plan!.speech, conflict.sources.audio_plan!.speech)
    assert.deepEqual(result.audio_plan!.scene_sound, conflict.sources.audio_plan!.scene_sound)
    assert.ok(result.video_prompt.includes('约0.3秒'))
  }
  assert.deepEqual(conflict, before)
  const incomplete = structuredClone(conflict); incomplete.conflicts[0]!.locations = locations
  assert.equal(handoffCountChoice(incomplete, '两'), undefined)
})
test('dialog requires preview and explicit adoption before normal saving; a save failure retains the edited preview', async () => {
  let adopted: any, attempts = 0
  const destroy = await mount(<ConflictDialog conflict={conflict} busy={false} onClose={() => {}} onApply={async edit => { adopted = edit; if (++attempts === 1) throw new Error('来源已变化，当前编辑已保留') }} />)
  try {
    assert.ok(document.body.textContent?.includes('audio_plan.sound_effects.0'))
    assert.equal(button('预览修正').disabled, true)
    await act(() => button('统一为两次（预览）').click())
    assert.equal(attempts, 0)
    await act(() => button('预览修正').click())
    assert.equal(button('采用修正并继续').disabled, true)
    await act(() => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await act(async () => button('采用修正并继续').click())
    assert.equal(attempts, 1); assert.deepEqual(adopted.audio_plan.speech, conflict.sources.audio_plan!.speech)
    assert.ok(document.body.textContent?.includes('来源已变化，当前编辑已保留'))
    assert.ok([...document.querySelectorAll('textarea')].some(el => el.value.includes('所有灯管闪烁两次')))
  } finally { await destroy() }
})
test('retained conflicts offer evidence and source location instead of repeated model analysis', async () => {
  let resolved = 0, retried = 0
  const destroy = await mount(<PreparationStatus status={{ nodeId: 'image', sourceNodeId: 'image', title: '灯管', phase: 'needs_confirmation', conflict, startedAt: Date.now() }} onLocate={() => {}} onDismiss={() => {}} onRetry={() => { retried++ }} onResolve={() => { resolved++ }} />)
  try { assert.ok(!document.body.textContent?.includes('重新分析')); await act(() => button('查看证据并解决').click()); assert.equal(resolved, 1); assert.equal(retried, 0) } finally { await destroy() }
})
test('job info maps the actual content index to the rejected image, not reference list order, and offers the canvas', async t => {
  let opened = 0
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), '/api/jobs/job/provider-inputs')
    return Response.json({ manifest: { entries: [] }, rejection: { upstream_code: 'PrivacyInformation', provider_request_id: 'request-123', mapping_status: 'matched', content_indices: [3], inputs: [{ field_path: 'content[3].image_url.url', content_index: 3, asset_ids: ['b'] }] }, source_nodes: [{ id: 'source-b', title: '被拒来源节点', asset_id: 'b' }] })
  })
  const destroy = await mount(<JobInformationPopover job={{ id: 'job', request: JSON.stringify({ reference_asset_ids: ['b', 'a'] }), status: 'failed', job_type: 'generate', created_at: '2026-11-18', error: 'rejected' } as Job}
    projectName="项目" assets={[{ id: 'a', kind: 'image', filename: '另一张.png', url: '/a.png' }, { id: 'b', kind: 'image', filename: '被拒图.png', url: '/b.png' }] as any} onOpenCanvas={() => { opened++ }} />)
  try {
    await act(async () => button('查看任务信息').click())
    assert.ok(document.body.textContent?.includes('content[3]')); assert.ok(document.body.textContent?.includes('request-123'))
    const section = [...document.querySelectorAll('section')].find(el => el.textContent?.includes('上游拒绝的输入'))!
    assert.ok(section.textContent?.includes('被拒图.png')); assert.ok(!section.textContent?.includes('另一张.png'))
    assert.ok(section.textContent?.includes('被拒来源节点'))
    await act(() => button('返回画布检查或替换参考图').click()); assert.equal(opened, 1)
  } finally { await destroy() }
})
