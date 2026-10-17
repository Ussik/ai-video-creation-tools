import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model } from '../src/shared/api/api'
import type { InstalledSkill, SkillDetail } from '../src/shared/api/skills-api'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) {
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)
}`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'Document', 'HTMLElement', 'Element', 'ShadowRoot', 'Event', 'MouseEvent', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window.document, 'fonts', { value: { addEventListener() {}, removeEventListener() {} } })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const { createRoot } = await import('react-dom/client')
const { default: SkillsCenter } = await import('../src/features/skills/SkillsCenter')
const { default: PromptSkillAction } = await import('../src/features/skills/PromptSkillAction')
after(() => dom.window.close())
const reply = (body: unknown) => new Response(JSON.stringify(body))
const skill: InstalledSkill = {
  id: 'skill', name: 'short-drama-image-prompts', description: '图片创作规则', repo: 'zenstory-ai/drama-skills', path: 'skills/short-drama-image-prompts',
  revision: 'a'.repeat(40), license: 'MIT', tool_requirements: [], suggested_stages: ['image_prompt'], stages: [], enabled: false,
  installed_at: '', updated_at: '', url: 'https://github.com/zenstory-ai/drama-skills',
}
const detail = (value = skill): SkillDetail => ({ ...value, files: [{ path: `${skill.path}/SKILL.md`, content: '---\nname: short-drama-image-prompts\ndescription: 图片创作规则\n---\n# 人物信息图\n\n保持**身份一致**。' }] })
async function mount(content: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const render = async (next = content) => {
    try { await act(() => root.render(<MantineProvider env="test">{next}</MantineProvider>)) }
    catch (issue) { throw issue instanceof AggregateError ? issue.errors[0] : issue }
  }
  await render()
  return { render, destroy: async () => { await act(() => root.unmount()); container.remove() } }
}
function button(text: string, root: ParentNode = document) {
  const element = [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)
  assert.ok(element, text); return element
}
function textarea(label: string) {
  const element = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)
  assert.ok(element, label); return element
}
async function fill(label: string, value: string) {
  const element = textarea(label)
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!
  await act(() => { setter.call(element, value); element.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
}
async function choose(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  assert.ok(input, label)
  await act(() => input.click())
  const option = document.querySelector<HTMLElement>(`[role="option"][value="${value}"]`)
  assert.ok(option, value)
  await act(() => option.click())
}
const models = [{ id: 'text', name: '创作模型', modality: 'text', enabled: true }] as Model[]
function defaults() {
  return reply({ policies: ['image_prompt', 'video_prompt'].map(stage => ({ stage, label: '提示词', primary_id: skill.id,
    auxiliary_ids: [], source: 'global', warning: '', skills: [skill] })) })
}
function promptAction(props: Partial<React.ComponentProps<typeof PromptSkillAction>> = {}) {
  return <PromptSkillAction projectId="project" nodeId="node" modality="image" prompt="人物在雨中回头" models={models} disabled={false}
    targetModelId="image" shotId="shot" ratio="9:16" duration={5} mode="reference" referenceAssetIds={['frame']} onApply={() => {}} {...props} />
}
async function openPromptAction() {
  const opener = document.querySelector<HTMLButtonElement>('[aria-label="使用技能整理提示词"]')!
  assert.ok(opener)
  await act(() => opener.click())
}

test('installing a recommended skill opens readable details and does not enable it until the stage configuration is saved', async t => {
  const original = globalThis.fetch, writes: Array<{ path: string; body: unknown }> = []
  let local: InstalledSkill[] = []
  globalThis.fetch = async (url, init) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : null
    if (init?.method && init.method !== 'GET') writes.push({ path, body })
    if (path === '/api/skills') return reply({ skills: local })
    if (path === '/api/skills/repositories') return reply([])
    if (path === '/api/skills/install') { local = [skill]; return reply(skill) }
    if (path === '/api/skills/skill' && init?.method === 'PATCH') { local = [{ ...skill, ...body }]; return reply(local[0]) }
    if (path === '/api/skills/skill') return reply(detail())
    throw new Error(`unexpected ${path}`)
  }
  t.after(() => { globalThis.fetch = original })
  const view = await mount(<SkillsCenter />)
  try {
    const card = [...document.querySelectorAll('.skill-card')].find(item => item.textContent?.includes(skill.name))!
    await act(() => button('安装', card).click())
    assert.equal(writes.length, 1); assert.equal(local[0]?.enabled, false)
    assert.equal(document.querySelector('.skills-document h2')?.textContent, '人物信息图')
    assert.equal(document.querySelector('.skills-document strong')?.textContent, '身份一致')
    const toggle = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await act(() => toggle.click())
    await act(() => button('保存配置').click())
    assert.deepEqual(writes[1], { path: '/api/skills/skill', body: { enabled: true, stages: ['image_prompt'] } })
    assert.equal(local[0]?.enabled, true)
  } finally { await view.destroy() }
})

test('prompt refinement stays a draft, blocks stale application and applies only after the creator clicks apply', async t => {
  const original = globalThis.fetch, applied: string[] = [], requests: unknown[] = []
  globalThis.fetch = async (url, init) => {
    if (url === '/api/projects/project/skills/defaults') return reply({ policies: [{ stage: 'image_prompt', label: '图片提示词', primary_id: skill.id, auxiliary_ids: [], source: 'global', warning: '', skills: [skill] }] })
    if (String(url).endsWith('/refine-prompt')) {
      requests.push(JSON.parse(String(init!.body)))
      return reply({ prompt: '9:16 人物三视图，保持身份和服装一致', skills: [{ name: skill.name }] })
    }
    throw new Error(`unexpected ${url}`)
  }
  t.after(() => { globalThis.fetch = original })
  const models = [{ id: 'text', name: '创作模型', modality: 'text', enabled: true }] as Model[]
  const component = (prompt: string, shotId = 'shot') => <PromptSkillAction projectId="project" nodeId="node" modality="image" prompt={prompt} models={models} disabled={false}
    targetModelId="image" shotId={shotId} ratio="9:16" duration={5} mode="reference" referenceAssetIds={['frame']} onApply={value => applied.push(value)} />
  const view = await mount(component('人物信息图'))
  try {
    await act(() => document.querySelector<HTMLButtonElement>('[aria-label="使用技能整理提示词"]')!.click())
    await act(() => button('整理提示词', document.querySelector('[role="dialog"]')!).click())
    assert.equal(applied.length, 0)
    assert.deepEqual(requests[0], { stage: 'image_prompt', skill_ids: ['skill'], model_id: 'text', prompt: '人物信息图', adjustment_request: '', target_model_id: 'image', shot_id: 'shot', ratio: '9:16', duration: 5, mode: 'reference', reference_asset_ids: ['frame'] })
    await view.render(component('人物信息图', 'other-shot'))
    assert.equal(button('应用提示词').disabled, true)
    assert.equal(applied.length, 0)
    await view.render(component('人物信息图，新服装'))
    assert.equal(button('应用提示词').disabled, true)
    assert.ok(document.body.textContent?.includes('当前节点内容或生成配置已变化'))
    await act(() => button('重新整理').click())
    assert.equal((requests[1] as { prompt: string }).prompt, '人物信息图，新服装', 'changed node context starts from its current source, not the obsolete result')
    assert.equal(button('应用提示词').disabled, false)
    await act(() => button('应用提示词').click())
    assert.deepEqual(applied, ['9:16 人物三视图，保持身份和服装一致'])
  } finally { await view.destroy() }
})

test('creator adjustment requests are trimmed and remain drafts until explicitly applied', async t => {
  const applied: string[] = [], requests: Array<Record<string, unknown>> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/skills/defaults')) return defaults()
    if (String(url).endsWith('/refine-prompt')) {
      requests.push(JSON.parse(String(init!.body)))
      return reply({ prompt: '人物在雨中回头，面部近景，背景虚化', skills: [] })
    }
    throw new Error(`unexpected ${url}`)
  })
  const view = await mount(promptAction({ onApply: prompt => applied.push(prompt) }))
  try {
    await openPromptAction()
    assert.equal(textarea('本次调整要求').maxLength, 4000)
    await fill('本次调整要求', '  保留人物动作，改成近景\n背景简化。  ')
    await act(() => button('整理提示词', document.querySelector('[role="dialog"]')!).click())
    assert.equal(requests[0]?.prompt, '人物在雨中回头')
    assert.equal(requests[0]?.adjustment_request, '保留人物动作，改成近景\n背景简化。')
    assert.equal(applied.length, 0)
    await act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭整理提示词"]')!.click())
    assert.equal(applied.length, 0, 'closing a preview must never overwrite the node')
    await openPromptAction()
    assert.equal(textarea('本次调整要求').value, '', 'another editing session starts with no leftover instructions')
    assert.equal(document.querySelector('textarea[aria-label="整理后的完整提示词"]'), null)
    await act(() => button('整理提示词', document.querySelector('[role="dialog"]')!).click())
    assert.equal(requests[1]?.adjustment_request, '')
    await act(() => button('应用提示词').click())
    assert.deepEqual(applied, ['人物在雨中回头，面部近景，背景虚化'])
  } finally { await view.destroy() }
})

test('successive adjustments use the edited candidate and preserve it through a failed retry without accumulating history', async t => {
  const requests: Array<Record<string, unknown>> = [], applied: string[] = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/skills/defaults')) return defaults()
    if (String(url).endsWith('/refine-prompt')) {
      requests.push(JSON.parse(String(init!.body)))
      if (requests.length === 2) return new Response(JSON.stringify({ message: '模型暂时不可用' }), { status: 503 })
      return reply({ prompt: requests.length === 1 ? '雨中人物近景' : '雨中人物近景，红色围巾，情绪克制', skills: [] })
    }
    throw new Error(`unexpected ${url}`)
  })
  const view = await mount(promptAction({ onApply: prompt => applied.push(prompt) }))
  try {
    await openPromptAction()
    await fill('本次调整要求', '改成近景')
    await act(() => button('整理提示词', document.querySelector('[role="dialog"]')!).click())
    assert.equal(button('应用提示词').disabled, false)
    await fill('整理后的完整提示词', '雨中人物近景，红色围巾')
    await fill('本次调整要求', ' 情绪克制，不改变围巾 ')
    assert.equal(textarea('整理后的完整提示词').value, '雨中人物近景，红色围巾')
    assert.equal(button('应用提示词').disabled, true, 'new instructions must be processed before applying the older candidate')
    await act(() => button('继续调整').click())
    assert.equal(textarea('整理后的完整提示词').value, '雨中人物近景，红色围巾', 'a failed request retains the last editable candidate')
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /模型暂时不可用/)
    assert.equal(applied.length, 0)
    await act(() => button('继续调整').click())
    assert.equal(requests[1]?.prompt, '雨中人物近景，红色围巾')
    assert.deepEqual(requests[2], requests[1], 'retry sends the same candidate and current instructions only')
    assert.equal(requests[2]?.adjustment_request, '情绪克制，不改变围巾')
    assert.equal(Object.hasOwn(requests[2]!, 'messages'), false)
    assert.equal(button('应用提示词').disabled, false)
    await act(() => button('应用提示词').click())
    assert.deepEqual(applied, ['雨中人物近景，红色围巾，情绪克制'])
  } finally { await view.destroy() }
})

test('image, video and visual profile shortcuts append editable directions appropriate to the node', async t => {
  const requests: Array<Record<string, unknown>> = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/skills/defaults')) return defaults()
    if (String(url).endsWith('/refine-prompt')) {
      requests.push(JSON.parse(String(init!.body)))
      return reply({ prompt: '整理结果', skills: [] })
    }
    throw new Error(`unexpected ${url}`)
  })
  const cases = [
    { props: {}, labels: ['加强构图', '突出情绪', '精简描述'], absent: '优化运镜', stage: 'image_prompt' },
    { props: { modality: 'video' as const, targetModelId: 'video' }, labels: ['细化动作', '优化运镜', '精简描述'], absent: '加强构图', stage: 'video_prompt' },
    { props: { profileId: 'character', shotId: null }, labels: ['细化材质', '补充视图', '精简描述'], absent: '突出情绪', stage: 'image_prompt' },
  ]
  for (const entry of cases) {
    const view = await mount(promptAction(entry.props))
    try {
      await openPromptAction()
      const dialog = document.querySelector('[role="dialog"]')!
      for (const label of entry.labels) assert.ok(button(label, dialog))
      assert.equal([...dialog.querySelectorAll('button')].some(node => node.textContent === entry.absent), false)
      await fill('本次调整要求', '保留人物身份。')
      await act(() => button(entry.labels[0]!, dialog).click())
      const withShortcut = textarea('本次调整要求').value
      assert.ok(withShortcut.startsWith('保留人物身份。'))
      assert.ok(withShortcut.length > '保留人物身份。'.length, 'a shortcut appends a concrete direction without replacing the creator request')
      await fill('本次调整要求', `${withShortcut}\n避免新增人物。`)
      await act(() => button('整理提示词', dialog).click())
      const request = requests.at(-1)!
      assert.equal(request.stage, entry.stage)
      assert.equal(request.adjustment_request, `${withShortcut}\n避免新增人物。`.trim())
      if ('profileId' in entry.props) assert.equal(request.profile_id, 'character')
    } finally { await view.destroy() }
  }
})

test('changing only the refinement model or skill retains manual candidate edits for the next adjustment', async t => {
  const requests: Array<Record<string, unknown>> = [], applied: string[] = []
  const alternateSkill = { ...skill, id: 'alternate-skill', name: 'alternate-image-prompts' }
  const selectionKey = 'creative-prompt-skills:project', previousSelection = dom.window.localStorage.getItem(selectionKey)
  t.after(() => {
    if (previousSelection === null) dom.window.localStorage.removeItem(selectionKey)
    else dom.window.localStorage.setItem(selectionKey, previousSelection)
  })
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/skills/defaults')) return reply({ policies: [{ stage: 'image_prompt', label: '图片提示词', primary_id: skill.id,
      auxiliary_ids: [], source: 'global', warning: '', skills: [skill, alternateSkill] }] })
    if (String(url).endsWith('/refine-prompt')) {
      requests.push(JSON.parse(String(init!.body)))
      return reply({ prompt: ['首轮候选', '更换模型后的候选', '更换技能后的候选'][requests.length - 1], skills: [] })
    }
    throw new Error(`unexpected ${url}`)
  })
  const view = await mount(promptAction({ models: [...models, { ...models[0]!, id: 'text-other', name: '另一创作模型' }],
    onApply: prompt => applied.push(prompt) }))
  try {
    await openPromptAction()
    await act(() => button('整理提示词', document.querySelector('[role="dialog"]')!).click())
    await fill('整理后的完整提示词', '首轮候选，用户手动加入红色围巾')
    await choose('整理提示词的文本模型', 'text-other')
    assert.equal(textarea('整理后的完整提示词').value, '首轮候选，用户手动加入红色围巾')
    assert.equal(button('应用提示词').disabled, true, 'an older policy result cannot be applied before the requested adjustment')
    await act(() => button('继续调整').click())
    assert.equal(requests[1]?.prompt, '首轮候选，用户手动加入红色围巾', 'changing a text model must retain the edited candidate instead of reverting to the node source')
    assert.equal(requests[1]?.model_id, 'text-other')
    assert.equal(button('应用提示词').disabled, false)

    await fill('整理后的完整提示词', '更换模型后的候选，继续保留手动服装细节')
    await act(() => button('更换').click())
    await choose('image_prompt主技能', 'alternate-skill')
    await act(() => button('更换').click())
    assert.equal(textarea('整理后的完整提示词').value, '更换模型后的候选，继续保留手动服装细节')
    assert.equal(button('应用提示词').disabled, true)
    await act(() => button('继续调整').click())
    assert.equal(requests[2]?.prompt, '更换模型后的候选，继续保留手动服装细节', 'changing a skill also retains all manual candidate edits')
    assert.equal(requests[2]?.model_id, 'text-other')
    assert.deepEqual(requests[2]?.skill_ids, ['alternate-skill'])
    assert.equal(applied.length, 0)
    await act(() => button('应用提示词').click())
    assert.deepEqual(applied, ['更换技能后的候选'])
  } finally { await view.destroy() }
})
