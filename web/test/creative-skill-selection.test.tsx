import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import { skillStageOptions, type SkillPolicy, type SkillStage, type SkillTaskContext, type SkillSelections } from '../src/shared/api/skills-api'
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver']) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: Selector } = await import('../src/features/skills/CreativeSkillSelector')
const { default: Settings } = await import('../src/features/skills/SkillDefaultSettings')
const { useCreativeSkills } = await import('../src/features/skills/useCreativeSkills')
const { notifySkillsLibraryChanged } = await import('../src/features/skills/skills-library-events')
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
  const skills = useCreativeSkills(projectId, true, { automatic: false })
  return <><Selector stage="script" projectId={projectId} policies={skills.policies} ids={skills.ids('script')} onChange={ids => skills.change('script', ids)}
    loading={skills.loading} error={skills.error} onDefaultsChanged={() => skills.reload('script')} /><button onClick={() => skills.change('image_prompt', ['image_prompt-b'])}>临时切换图片</button>
    <output>{JSON.stringify(Object.fromEntries(skills.policies.map(policy => [policy.stage, skills.ids(policy.stage)])))}</output></>
}
function RememberedHarness({ projectId = 'one', stage = 'video_prompt', active = true }: { projectId?: string; stage?: SkillStage; active?: boolean }) {
  const skills = useCreativeSkills(projectId, active, { rememberSelections: true, automatic: false })
  return <><Selector stage={stage} projectId={projectId} policies={skills.policies} ids={skills.ids(stage)} onChange={ids => skills.change(stage, ids)} appearance="prompt"
    loading={skills.loading} error={skills.error} onDefaultsChanged={() => skills.reload(stage)} onRetry={() => skills.reload(stage, { keepSelection: true })} />
    <output>{JSON.stringify(Object.fromEntries(skills.policies.map(policy => [policy.stage, skills.ids(policy.stage)])))}</output></>
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

test('library sync refreshes available skill versions without resetting manual or remembered choices', async t => {
  dom.window.localStorage.clear()
  let fetches = 0, current = policies()
  t.mock.method(globalThis, 'fetch', async () => { fetches++; return Response.json({ policies: current }) })
  function LibraryHarness() {
    const skills = useCreativeSkills('one', true, { rememberSelections: true })
    return <><button onClick={() => skills.change('script', ['script-b', 'script-a'])}>手选剧本技能</button>
      <output>{JSON.stringify({ selections: skills.selections, policies: skills.policies })}</output></>
  }
  const view = await mount(<LibraryHarness />)
  try {
    await act(() => button('手选剧本技能').click())
    const remembered = dom.window.localStorage.getItem('creative-prompt-skills:one')
    current = policies().map(policy => ({ ...policy, primary_id: `${policy.stage}-c`, skills: [
      ...policy.skills.map(item => ({ ...item, name: `${item.name}已更新`, revision: 'b'.repeat(40) })),
      { id: `${policy.stage}-new`, name: '新安装技能', description: '新增方法', revision: 'c'.repeat(40) },
    ] }))
    await act(() => notifySkillsLibraryChanged())
    const result = selections()
    assert.equal(fetches, 2)
    assert.deepEqual(result.selections.script, ['script-b', 'script-a'])
    assert.equal(Object.hasOwn(result.selections, 'image_prompt'), false, 'unmodified stages remain available for model selection')
    assert.equal(result.policies[0].skills[0].revision, 'b'.repeat(40))
    assert.equal(result.policies[0].skills.at(-1).name, '新安装技能')
    assert.equal(dom.window.localStorage.getItem('creative-prompt-skills:one'), remembered)
  } finally { await view.destroy(); dom.window.localStorage.clear() }
  await act(() => notifySkillsLibraryChanged())
  assert.equal(fetches, 2, 'unmounted selectors unsubscribe from library changes')
})

test('library sync defers refreshing closed prompt editors until reopened and keeps their remembered selection', async t => {
  dom.window.localStorage.clear()
  dom.window.localStorage.setItem('creative-prompt-skills:one', JSON.stringify({ video_prompt: ['video_prompt-b'] }))
  let fetches = 0
  t.mock.method(globalThis, 'fetch', async () => { fetches++; return Response.json({ policies: policies() }) })
  const view = await mount(<RememberedHarness active={false} />)
  try {
    await act(() => notifySkillsLibraryChanged())
    assert.equal(fetches, 0)
    await view.render(<RememberedHarness active />)
    assert.equal(fetches, 1)
    assert.deepEqual(selections().video_prompt, ['video_prompt-b'])
  } finally { await view.destroy(); dom.window.localStorage.clear() }
})

function automaticPolicies(): SkillPolicy[] {
  return policies().map(policy => policy.stage !== 'script' ? policy : {
    ...policy, primary_id: 'write', skills: [
      { id: 'write', name: 'short-drama-write', description: '单集剧本', revision: 'a'.repeat(40) },
      { id: 'develop', name: 'short-drama-develop', description: '故事开发与分集规划', revision: 'a'.repeat(40) },
      { id: 'review', name: 'short-drama-review', description: '独立审查', revision: 'a'.repeat(40) },
    ],
  })
}
function AutomaticHarness({ task, remember = false, automatic, projectId = 'automatic-one' }: { task: SkillTaskContext; remember?: boolean; automatic?: boolean; projectId?: string }) {
  const skills = useCreativeSkills(projectId, true, { task, automatic, rememberSelections: remember })
  const [captured, setCaptured] = React.useState<SkillSelections | null>(null)
  const selected = skills.selection('script')
  return <><Selector stage="script" projectId={projectId} policies={skills.policies} ids={selected.ids} selection={selected}
    onChange={ids => skills.change('script', ids)} onUseAutomatic={() => skills.useAutomatic('script')} appearance="chat"
    loading={skills.loading} error={skills.error} onDefaultsChanged={() => skills.reload('script')} />
    <button onClick={() => setCaptured(skills.snapshot())}>冻结审查请求</button>
    <output>{JSON.stringify({ selected, selections: skills.selections, captured })}</output></>
}

test('automatic mode waits for model selection and typing tasks makes no model or policy write request', async t => {
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.ok(!init?.method || init.method === 'GET')
    calls.push(String(url))
    return Response.json({ policies: automaticPolicies() })
  })
  const view = await mount(<AutomaticHarness task={{ workflow_stage: 'outline' }} />)
  try {
    assert.deepEqual(selections().selected.ids, [])
    assert.deepEqual(selections().selections, {})
    assert.equal(selections().selected.source, 'automatic')
    await act(() => button('剧本创作技能选择').click())
    assert.match(document.querySelector('.creative-skill-popover header')!.textContent!, /模型自动选择/)
    assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="script主技能"]')!.value, '模型自动选择')
    assert.equal(button('设为项目默认').disabled, true, 'automatic mode cannot accidentally save an empty manual default')
    const reason = document.querySelector('[aria-label="技能分配依据"]')
    assert.ok(reason?.textContent?.trim())
    assert.ok(selections().selected.reason)
    await view.render(<AutomaticHarness task={{ workflow_stage: 'episode' }} />)
    assert.deepEqual(selections().selected.ids, [])
    await view.render(<AutomaticHarness task={{ operation: 'review' }} />)
    assert.deepEqual(selections().selected.ids, [])
    assert.equal(calls.length, 1, 'changing a task performs no recommendation API call')
    assert.equal(dom.window.localStorage.getItem('creative-prompt-skills:automatic-one'), null)
  } finally { await view.destroy() }
})

test('manual base rules remain an explicit empty override until model automatic selection is restored', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ policies: automaticPolicies() }))
  const view = await mount(<AutomaticHarness task={{ workflow_stage: 'outline' }} />)
  try {
    await act(() => button('剧本创作技能选择').click())
    await choose('script主技能', '__base__')
    assert.deepEqual(selections().selected.ids, [])
    assert.equal(selections().selected.source, 'manual')
    assert.deepEqual(selections().selections, { script: [] })
    await view.render(<AutomaticHarness task={{ operation: 'review' }} />)
    assert.deepEqual(selections().selected.ids, [])
    await act(() => button('恢复模型自动选择').click())
    assert.deepEqual(selections().selected.ids, [])
    assert.equal(selections().selected.source, 'automatic')
    assert.deepEqual(selections().selections, {})
  } finally { await view.destroy() }
})

test('remembered manual choices override automatic tasks and restoring one stage preserves the other remembered stages', async t => {
  dom.window.localStorage.clear()
  const key = 'creative-prompt-skills:automatic-one'
  dom.window.localStorage.setItem(key, JSON.stringify({ script: ['write'], video_prompt: [] }))
  let fetches = 0
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.ok(!init?.method || init.method === 'GET')
    fetches++
    return Response.json({ policies: automaticPolicies() })
  })
  const view = await mount(<AutomaticHarness task={{ workflow_stage: 'outline' }} remember />)
  try {
    assert.deepEqual(selections().selected.ids, ['write'])
    assert.equal(selections().selected.source, 'manual')
    await act(() => button('剧本创作技能选择').click())
    await act(() => button('恢复模型自动选择').click())
    assert.deepEqual(selections().selected.ids, [])
    assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(key)!), { video_prompt: [] })
    assert.deepEqual(selections().selections.video_prompt, [])
    assert.equal(fetches, 1, 'restoring automatic selection does not reload or write policies')
    await view.render(<AutomaticHarness key="next-node" task={{ operation: 'review' }} remember />)
    assert.deepEqual(selections().selected.ids, [])
    assert.equal(selections().selected.source, 'automatic')
  } finally { await view.destroy(); dom.window.localStorage.clear() }
})

test('request snapshots contain only explicit overrides and stay frozen while tasks and manual choices change', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ policies: automaticPolicies() }))
  const view = await mount(<AutomaticHarness task={{ workflow_stage: 'outline' }} />)
  try {
    await act(() => button('冻结审查请求').click())
    assert.deepEqual(selections().captured, {})
    assert.deepEqual(selections().selected.ids, [])
    await view.render(<AutomaticHarness task={{ workflow_stage: 'episode' }} />)
    assert.deepEqual(selections().captured, {})
    assert.deepEqual(selections().selected.ids, [])
    await act(() => button('剧本创作技能选择').click())
    await choose('script主技能', 'develop')
    await act(() => button('冻结审查请求').click())
    assert.deepEqual(selections().captured.script, ['develop'], 'direct action snapshots also preserve explicit manual choices')
    await choose('script主技能', '__base__')
    assert.deepEqual(selections().captured, { script: ['develop'] })
    assert.deepEqual(selections().selections, { script: [] })
  } finally { await view.destroy() }
})

test('default editing can disable model selection while late policy loads never predict a skill', async t => {
  let release!: (response: Response) => void
  t.mock.method(globalThis, 'fetch', async () => new Promise<Response>(resolve => { release = resolve }))
  const view = await mount(<AutomaticHarness task={{ workflow_stage: 'outline' }} />)
  try {
    await view.render(<AutomaticHarness task={{ operation: 'review' }} />)
    await act(() => release(Response.json({ policies: automaticPolicies() })))
    assert.deepEqual(selections().selected.ids, [])
    assert.equal(selections().selected.source, 'automatic')
    await view.render(<AutomaticHarness task={{ operation: 'review' }} automatic={false} />)
    assert.deepEqual(selections().selected.ids, ['write'])
    assert.equal(selections().selected.source, 'default')
  } finally { await view.destroy() }
})
