import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import { skillStageOptions, type SkillPolicy, type SkillStage } from '../src/skills-api'
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: Selector } = await import('../src/CreativeSkillSelector')
const { default: Settings } = await import('../src/SkillDefaultSettings')
const { useCreativeSkills } = await import('../src/useCreativeSkills')
after(() => dom.window.close())
const policies = (): SkillPolicy[] => skillStageOptions.map(({ value: stage, label }) => ({ stage, label, primary_id: `${stage}-a`, auxiliary_ids: [], source: 'global', warning: '',
  skills: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(name => ({ id: `${stage}-${name}`, name: `${stage}技能${name}`, description: '测试创作方法', revision: 'a'.repeat(40) })) }))
async function mount(element: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const render = (value: React.ReactNode) => act(async () => root.render(<MantineProvider env="test">{value}</MantineProvider>))
  await render(element)
  return { render, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
function button(label: string) { const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label); assert.ok(node, label); return node }
async function choose(label: string, id: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!; assert.ok(input, label)
  await act(() => input.click())
  const listbox = document.getElementById(input.getAttribute('aria-controls') || '')
  assert.ok(listbox, input.outerHTML)
  const option = listbox.querySelector<HTMLElement>(`[role="option"][value="${id}"]`); assert.ok(option, id); await act(() => option.click())
}
function Harness({ projectId = 'one' }: { projectId?: string }) {
  const skills = useCreativeSkills(projectId)
  return <><Selector stage="script" projectId={projectId} policies={skills.policies} ids={skills.ids('script')} onChange={ids => skills.change('script', ids)}
    loading={skills.loading} error={skills.error} onDefaultsChanged={() => skills.reload('script')} /><button onClick={() => skills.change('image_prompt', ['image_prompt-b'])}>临时切换图片</button>
    <output>{JSON.stringify(skills.selections)}</output></>
}
function RememberedHarness({ projectId = 'one', stage = 'video_prompt', active = true }: { projectId?: string; stage?: SkillStage; active?: boolean }) {
  const skills = useCreativeSkills(projectId, active, { rememberSelections: true })
  return <><Selector stage={stage} projectId={projectId} policies={skills.policies} ids={skills.ids(stage)} onChange={ids => skills.change(stage, ids)} appearance="prompt"
    loading={skills.loading} error={skills.error} onDefaultsChanged={() => skills.reload(stage)} onRetry={() => skills.reload(stage, { keepSelection: true })} />
    <output>{JSON.stringify(skills.selections)}</output></>
}
const selections = () => JSON.parse(document.querySelector('output')!.textContent!)

test('all five stages show defaults; changing a primary is temporary until explicitly saved', async t => {
  const writes: Array<{ url: string; body: any }> = []; const defaults = policies()
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init?.method === 'PUT') { const body = JSON.parse(String(init.body)); writes.push({ url: String(url), body }); Object.assign(defaults[0], body) }
    return Response.json({ policies: defaults })
  })
  const settings = await mount(<Settings projectId="one" projectName="项目一" />)
  assert.equal(document.querySelectorAll('.creative-skill-default-row').length, 5)
  await settings.destroy()
  const view = await mount(<Harness />)
  try {
    await act(() => button('临时切换图片').click())
    await act(() => button('剧本创作技能选择').click())
    await choose('script主技能', 'script-b')
    assert.deepEqual(JSON.parse(document.querySelector('output')!.textContent!).script, ['script-b'])
    assert.equal(writes.length, 0)
    await choose('script辅助技能', 'script-a')
    assert.deepEqual(JSON.parse(document.querySelector('output')!.textContent!).script, ['script-b', 'script-a'])
    await act(() => button('设为项目默认').click())
    assert.deepEqual(writes, [{ url: '/api/projects/one/skills/defaults/script', body: { primary_id: 'script-b', auxiliary_ids: ['script-a'] } }])
    assert.deepEqual(JSON.parse(document.querySelector('output')!.textContent!).image_prompt, ['image_prompt-b'])
    await choose('script主技能', '__base__')
    assert.deepEqual(JSON.parse(document.querySelector('output')!.textContent!).script, [])
    assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="script辅助技能"]')!.disabled, true)
  } finally { await view.destroy() }
})

test('selector allows five auxiliaries, blocks a sixth and saves all five without truncating', async t => {
  const defaults = policies(), writes: any[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (init?.method === 'PUT') { const body = JSON.parse(String(init.body)); writes.push(body); Object.assign(defaults[0], body) }
    return Response.json({ policies: defaults })
  })
  const view = await mount(<Harness />)
  try {
    await act(() => button('剧本创作技能选择').click())
    assert.match(document.body.textContent!, /辅助技能 · 可选，最多 5 个/)
    for (const suffix of ['b', 'c', 'd', 'e', 'f']) await choose('script辅助技能', `script-${suffix}`)
    const expected = ['script-a', 'script-b', 'script-c', 'script-d', 'script-e', 'script-f']
    assert.deepEqual(JSON.parse(document.querySelector('output')!.textContent!).script, expected)
    await choose('script辅助技能', 'script-g')
    assert.deepEqual(JSON.parse(document.querySelector('output')!.textContent!).script, expected)
    await act(() => button('设为项目默认').click())
    assert.deepEqual(writes, [{ primary_id: 'script-a', auxiliary_ids: expected.slice(1) }])
    assert.deepEqual(JSON.parse(document.querySelector('output')!.textContent!).script, expected)
  } finally { await view.destroy() }
})

test('late defaults from a previous project cannot replace the active project selection', async t => {
  let release!: (value: Response) => void
  t.mock.method(globalThis, 'fetch', async url => String(url).includes('/one/') ? new Promise<Response>(resolve => { release = resolve }) : Response.json({ policies: policies().map(item => ({ ...item, primary_id: `${item.stage}-b`, source: 'project' })) }))
  const view = await mount(<Harness />)
  try {
    await view.render(<Harness projectId="two" />)
    assert.deepEqual(JSON.parse(document.querySelector('output')!.textContent!).script, ['script-b'])
    await act(async () => release(Response.json({ policies: policies() })))
    assert.deepEqual(JSON.parse(document.querySelector('output')!.textContent!).script, ['script-b'])
  } finally { await view.destroy() }
})

test('a defaults fetch failure is visible and can be retried without silently choosing base rules', async t => {
  let failed = true
  t.mock.method(globalThis, 'fetch', async () => failed ? Response.json({ detail: '读取配置失败' }, { status: 500 }) : Response.json({ policies: policies() }))
  const view = await mount(<Harness />)
  try {
    assert.match(button('剧本创作技能选择').textContent!, /技能配置未读取/)
    await act(() => button('剧本创作技能选择').click())
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /读取配置失败/)
    failed = false
    await act(() => button('重新读取配置').click())
    assert.deepEqual(JSON.parse(document.querySelector('output')!.textContent!).script, ['script-a'])
  } finally { await view.destroy() }
})

test('remembered prompt skills survive closing and next-node remounts while projects and stages stay independent', async t => {
  dom.window.localStorage.clear()
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.ok(!init?.method || init.method === 'GET', 'remembering does not write server defaults')
    return Response.json({ policies: policies() })
  })
  const view = await mount(<RememberedHarness />)
  try {
    await act(() => button('视频提示词技能选择').click())
    await choose('video_prompt主技能', 'video_prompt-b')
    await choose('video_prompt辅助技能', 'video_prompt-a')
    const expectedVideo = ['video_prompt-b', 'video_prompt-a']
    await view.render(<RememberedHarness active={false} />)
    await view.render(<RememberedHarness active />)
    assert.deepEqual(selections().video_prompt, expectedVideo)
    await view.render(<RememberedHarness key="next-video-node" />)
    assert.deepEqual(selections().video_prompt, expectedVideo)
    await view.render(<RememberedHarness key="image-node" stage="image_prompt" />)
    assert.deepEqual(selections().image_prompt, ['image_prompt-a'])
    await act(() => button('图片提示词技能选择').click())
    await choose('image_prompt主技能', 'image_prompt-c')
    await choose('image_prompt辅助技能', 'image_prompt-d')
    await view.render(<RememberedHarness key="other-project" projectId="two" />)
    assert.deepEqual(selections().video_prompt, ['video_prompt-a'])
    assert.deepEqual(selections().image_prompt, ['image_prompt-a'])
    await view.render(<RememberedHarness key="return-project" />)
    assert.deepEqual(selections().video_prompt, expectedVideo)
    assert.deepEqual(selections().image_prompt, ['image_prompt-c', 'image_prompt-d'])
  } finally { await view.destroy() }
  const refreshed = await mount(<RememberedHarness />)
  try {
    assert.deepEqual(selections().video_prompt, ['video_prompt-b', 'video_prompt-a'])
    assert.deepEqual(selections().image_prompt, ['image_prompt-c', 'image_prompt-d'])
  } finally { await refreshed.destroy(); dom.window.localStorage.clear() }
})

test('remembered base rules stay selected and restoring defaults resets only the active prompt stage', async t => {
  dom.window.localStorage.clear()
  const writes: string[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init?.method === 'DELETE') writes.push(String(url))
    return Response.json({ policies: policies() })
  })
  const view = await mount(<RememberedHarness stage="image_prompt" />)
  try {
    await act(() => button('图片提示词技能选择').click())
    await choose('image_prompt辅助技能', 'image_prompt-b')
    await view.render(<RememberedHarness key="video-node" />)
    await act(() => button('视频提示词技能选择').click())
    await choose('video_prompt主技能', '__base__')
    await view.render(<RememberedHarness key="next-video-node" />)
    assert.deepEqual(selections().video_prompt, [], 'an explicitly empty selection must not fall back to the default primary')
    await act(() => button('视频提示词技能选择').click())
    await act(() => (document.querySelector('.creative-skill-more-config .workspace-disclosure-control') as HTMLElement).click())
    await act(() => button('恢复全局默认').click())
    assert.deepEqual(writes, ['/api/projects/one/skills/defaults/video_prompt'])
    assert.deepEqual(selections().video_prompt, ['video_prompt-a'])
    await view.render(<RememberedHarness key="after-reset" />)
    assert.deepEqual(selections().video_prompt, ['video_prompt-a'])
    assert.deepEqual(selections().image_prompt, ['image_prompt-a', 'image_prompt-b'])
  } finally { await view.destroy(); dom.window.localStorage.clear() }
})

test('retrying a failed policy fetch preserves remembered prompt choices', async t => {
  dom.window.localStorage.clear()
  let failed = false
  t.mock.method(globalThis, 'fetch', async () => failed ? Response.json({ detail: '读取配置失败' }, { status: 500 }) : Response.json({ policies: policies() }))
  const view = await mount(<RememberedHarness />)
  try {
    await act(() => button('视频提示词技能选择').click())
    await choose('video_prompt辅助技能', 'video_prompt-b')
    failed = true
    await view.render(<RememberedHarness key="next-node" />)
    await act(() => button('视频提示词技能选择').click())
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /读取配置失败/)
    failed = false
    await act(() => button('重新读取配置').click())
    assert.deepEqual(selections().video_prompt, ['video_prompt-a', 'video_prompt-b'])
  } finally { await view.destroy(); dom.window.localStorage.clear() }
})
