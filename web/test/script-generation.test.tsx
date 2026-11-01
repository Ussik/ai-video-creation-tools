import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test, type TestContext } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Editor } from '@tiptap/core'
import type { Model, ProjectDetail, Provider } from '../src/shared/api/api'
import type { ScriptEditorProps } from '../src/features/script/ScriptEditor'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'MutationObserver', 'DOMParser', 'Event', 'MouseEvent', 'KeyboardEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window.document, 'fonts', { value: new dom.window.EventTarget() })
dom.window.HTMLElement.prototype.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { default: ScriptEditor } = await import('../src/features/script/ScriptEditor')
const { createRoot } = await import('react-dom/client')
after(() => dom.window.close())

const project = { id: 'generation-test', name: '山海经', brief: '', ratio: '9:16', script: {
  outline: '保留已确认的大纲', characters: '已确认人物', scenes: [], generation_options: {},
}, shots: [], assets: [], jobs: [], asset_tasks: [] } as unknown as ProjectDetail
const model = { id: 'text', provider_id: 'provider', name: '文本模型', modality: 'text', enabled: true } as Model
const provider = { id: 'provider', name: '提供商', adapter: 'http', enabled: true } as Provider

function button(label: string, scope: ParentNode = document) {
  const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label)
  assert.ok(result, label)
  return result
}
async function settle() { await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)) }) }
async function mount(t: TestContext, detail = project, extraProps: Partial<Pick<ScriptEditorProps, 'onSupplementStage' | 'busy'>> = {}) {
  let openedCanvas = 0
  const requests: Array<{ path: string; method: string; body: Record<string, unknown> }> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url), body = JSON.parse(String(init?.body || '{}'))
    requests.push({ path, body, method: init?.method || 'GET' })
    if (path.endsWith('/script/commit')) return Response.json(body)
    throw new Error(`Unexpected request: ${path}`)
  })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(() => root.render(<MantineProvider env="test"><ScriptEditor detail={detail} models={[model]} providers={[provider]}
    onRefresh={async () => detail} onOpenModels={() => {}} onOpenCanvas={() => { openedCanvas++ }} onNotice={() => {}} {...extraProps} /></MantineProvider>))
  await settle()
  return { container, requests, openedCanvas: () => openedCanvas, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}

test('editor keeps saved documents and canvas navigation without a complete-script generation entry', async t => {
  const view = await mount(t)
  try {
    assert.ok(![...view.container.querySelectorAll('button')].some(node => ['生成剧本', '查看生成结果'].includes(node.textContent || '')))
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.match(view.container.querySelector('[data-script-section="outline"]')!.textContent!, /保留已确认的大纲/)
    assert.equal(button('保存').disabled, true)
    assert.ok(button('全文搜索'))
    assert.ok(button('加入画布'))
    await act(() => button('返回画布').click())
    assert.equal(view.openedCanvas(), 1)
    assert.deepEqual(view.requests, [], 'opening the editor never requests generation prompts or drafts')
  } finally { await view.destroy() }
})

test('manual document edits still support undo, redo and saving through the original contract', async t => {
  const view = await mount(t)
  try {
    const element = view.container.querySelector('[data-script-section="outline"] [contenteditable]') as HTMLElement & { editor: Editor }
    assert.ok(element.editor)
    await act(() => { element.editor.commands.setContent('<p>手动细化的全剧大纲</p>') })
    assert.equal(button('保存').disabled, false)
    await act(() => button('撤销').click())
    assert.match(view.container.querySelector('[data-script-section="outline"]')!.textContent!, /保留已确认的大纲/)
    await act(() => button('重做').click())
    assert.match(view.container.querySelector('[data-script-section="outline"]')!.textContent!, /手动细化的全剧大纲/)
    await act(async () => button('保存').click()); await settle()
    assert.equal(view.requests.length, 1)
    assert.ok(view.requests[0].path.endsWith('/script/commit'))
    assert.equal(view.requests[0].method, 'PUT')
    assert.equal(view.requests[0].body.outline, '手动细化的全剧大纲')
    assert.equal(view.requests[0].body.characters, project.script.characters)
    assert.deepEqual(view.requests[0].body.scenes, project.script.scenes)
    assert.equal(button('保存').disabled, true)
  } finally { await view.destroy() }
})

test('design groups expose four editable sections and preserve historical model titles and bodies when saving', async t => {
  const legacy = [
    { id: 'saved-location', artifact_type: 'locations', title: '场景设计', content: '# 原有场景标题\n旧车站原文', position: 0, status: 'ready' },
    { id: 'saved-prop', artifact_type: 'props', title: '道具设计', content: '# 原有道具标题\n怀表原文', position: 1, status: 'ready' },
    { id: 'custom-atmosphere', artifact_type: 'location_atmosphere', title: '车站 · 冷暖光线', content: '夕阳透过候车厅', position: 2, status: 'ready' },
  ]
  const detail = { ...project, script: { ...project.script, artifacts: legacy } } as unknown as ProjectDetail
  const view = await mount(t, detail)
  try {
    for (const stage of ['locations', 'props'] as const) {
      const group = view.container.querySelector(`[data-script-stage="${stage}"]`)!
      assert.deepEqual([...group.querySelectorAll('.script-document-nav-item')].map(item => item.textContent), scriptStageArtifacts[stage].map(type => scriptArtifactLabels[type]))
      await act(() => button(stage === 'locations' ? '场景设计' : '道具设计', group).click()); await settle()
      assert.equal(view.container.querySelector('.script-long-document-cover h1')!.textContent, stage === 'locations' ? '场景设计' : '道具设计')
      assert.equal(view.container.querySelectorAll('[data-script-section]').length, 4)
      assert.equal(view.container.querySelector(`[data-script-section="${stage}"] h2`)!.textContent, scriptArtifactLabels[stage])
      assert.match(view.container.querySelector(`[data-script-section="${stage}"] [contenteditable]`)!.textContent!, /原有.*标题/)
      for (const type of scriptStageArtifacts[stage]) {
        const section = view.container.querySelector(`[data-script-section="${type}"]`)!
        assert.ok(section.querySelector('[contenteditable]') || section.querySelector('[aria-label^="手动填写"]'))
      }
      if (stage === 'locations') assert.equal(view.container.querySelector('[data-script-section="location_atmosphere"] h2')!.textContent, '车站 · 冷暖光线')
    }
    await act(() => button('手动填写外观与辨识').click()); await settle()
    const element = view.container.querySelector('[data-script-section="prop_visuals"] [contenteditable]') as HTMLElement & { editor: Editor }
    await act(() => element.editor.commands.setContent('<p>银制怀表，表盖有缺口。</p>'))
    await act(async () => button('保存').click()); await settle()
    const saved = view.requests[0].body.artifacts as Array<{ artifact_type: string; title: string; content: string }>
    for (const original of legacy) {
      const result = saved.find(doc => doc.artifact_type === original.artifact_type)!
      assert.equal(result.title, original.title)
      assert.equal(result.content, original.content)
    }
    assert.equal(saved.find(doc => doc.artifact_type === 'prop_visuals')!.content, '银制怀表，表盖有缺口。')
    assert.equal(view.requests.length, 1)
  } finally { await view.destroy() }
})

test('missing chapters stay explicit and do not copy legacy outline, scene bodies or generation settings', async t => {
  const detail = { ...project, script: { ...project.script, generation_options: { era: '旧时小城', visual_style: '水墨', core_hook: '配置中的悬念' }, scenes: [
    { id: 'scene-1', position: 0, heading: '巷口', location: '旧街', time_of_day: '夜', characters: '主角', action: '分场里的动作', dialogue: '', narration: '', duration: 5 },
  ] } } as unknown as ProjectDetail
  const view = await mount(t, detail)
  try {
    assert.match(view.container.querySelector('.script-stage-completeness')!.textContent!, /已填写 1\/9 项，8 项未生成/)
    assert.match(view.container.querySelector('[data-script-section="outline"]')!.textContent!, /保留已确认的大纲/)
    for (const type of ['synopsis', 'world', 'structure', 'hooks', 'foreshadowing', 'reversals', 'constraints', 'episode_outline']) {
      const section = view.container.querySelector(`[data-script-section="${type}"]`)!
      assert.match(section.querySelector('.script-section-empty')!.textContent!, /未生成/)
      assert.equal(section.querySelector('[contenteditable]'), null)
      assert.doesNotMatch(section.textContent!, /保留已确认的大纲|分场里的动作|旧时小城|配置中的悬念/)
    }
    assert.equal(button('保存').disabled, true)
    assert.deepEqual(view.requests, [], 'viewing missing chapters performs no writes or generation')
  } finally { await view.destroy() }
})

test('stage supplement buttons open the requested missing scope and wait for saved edits', async t => {
  const stages: string[] = []
  const detail = { ...project, script: { ...project.script, artifacts: [
    { id: 'locations', artifact_type: 'locations', title: '场景清单', content: '旧街', position: 0, status: 'ready' },
    { id: 'props', artifact_type: 'props', title: '道具清单', content: '怀表', position: 1, status: 'ready' },
  ] } } as unknown as ProjectDetail
  const view = await mount(t, detail, { onSupplementStage: stage => stages.push(stage) })
  try {
    for (const [stage, title] of [['outline', '故事大纲'], ['characters', '人物设定'], ['locations', '场景设计'], ['props', '道具设计']] as const) {
      const group = view.container.querySelector(`[data-script-stage="${stage}"]`)!
      await act(() => button(title, group).click())
      await act(() => button(`补齐${title}缺项`).click())
    }
    assert.deepEqual(stages, ['outline', 'characters', 'locations', 'props'])
    assert.deepEqual(view.requests, [], 'opening supplement settings does not invoke a model')
    await act(() => button('故事大纲').click())
    const element = view.container.querySelector('[data-script-section="outline"] [contenteditable]') as HTMLElement & { editor: Editor }
    await act(() => element.editor.commands.insertContent('手动修改'))
    assert.equal(button('补齐故事大纲缺项').disabled, true)
    await act(() => button('补齐故事大纲缺项').click())
    assert.equal(stages.length, 4)
  } finally { await view.destroy() }
})

test('stages without a saved primary document keep manual entry and do not offer unsupported supplement requests', async t => {
  const detail = { ...project, script: { ...project.script, artifacts: [
    { id: 'atmosphere', artifact_type: 'location_atmosphere', title: '视觉与氛围', content: '薄雾', position: 0, status: 'ready' },
  ] } } as unknown as ProjectDetail
  const view = await mount(t, detail, { onSupplementStage: () => assert.fail('unavailable stage supplement') })
  try {
    for (const title of ['场景设计', '道具设计']) {
      await act(() => button(title).click())
      assert.ok(![...view.container.querySelectorAll('button')].some(node => node.textContent === `补齐${title}缺项`))
      assert.ok(view.container.querySelector('.script-section-empty [aria-label^="手动填写"]'))
      assert.doesNotMatch(view.container.querySelector('.script-section-empty')!.textContent!, /通过上方入口/)
    }
    assert.deepEqual(view.requests, [])
  } finally { await view.destroy() }
})

test('busy editors disable supplement and manual creation without issuing requests', async t => {
  const stages: string[] = []
  const view = await mount(t, project, { busy: true, onSupplementStage: stage => stages.push(stage) })
  try {
    assert.equal(button('补齐故事大纲缺项').disabled, true)
    assert.equal(button('手动填写钩子预设').disabled, true)
    await act(() => button('补齐故事大纲缺项').click())
    assert.deepEqual(stages, [])
    assert.deepEqual(view.requests, [])
  } finally { await view.destroy() }
})

test('saving a manual edit omits uncreated placeholders and preserves saved empty chapters', async t => {
  const generationOptions = { era: '古代', core_hook: '旧设置', episode_count: 12 }
  const detail = { ...project, script: { ...project.script, generation_options: generationOptions, artifacts: [
    { id: 'saved-outline', artifact_type: 'outline', title: '概要设计', content: project.script.outline, position: 0, status: 'ready' },
    { id: 'saved-hooks', artifact_type: 'hooks', title: '旧版钩子预设', content: '', position: 1, status: 'edited' },
  ] } } as unknown as ProjectDetail
  const view = await mount(t, detail)
  try {
    const element = view.container.querySelector('[data-script-section="outline"] [contenteditable]') as HTMLElement & { editor: Editor }
    await act(() => element.editor.commands.insertContent('新增细节'))
    await act(async () => button('保存').click()); await settle()
    const saved = view.requests[0].body.artifacts as Array<{ id?: string; artifact_type: string; content: string }>
    assert.deepEqual(saved.map(artifact => artifact.artifact_type).sort(), ['characters', 'hooks', 'outline'])
    assert.equal(saved.find(artifact => artifact.id === 'saved-hooks')?.content, '')
    assert.equal(saved.find(artifact => artifact.artifact_type === 'characters')?.content, project.script.characters)
    for (const [key, value] of Object.entries(generationOptions)) assert.equal((view.requests[0].body.generation_options as Record<string, unknown>)[key], value)
    assert.deepEqual(view.requests[0].body.scenes, project.script.scenes)
  } finally { await view.destroy() }
})
