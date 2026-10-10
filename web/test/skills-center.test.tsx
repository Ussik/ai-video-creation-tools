import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import type { Model } from '../src/api'
import type { InstalledSkill, SkillDetail } from '../src/skills-api'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) {
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)
}`)}`, import.meta.url)
const { default: SkillsCenter } = await import('../src/SkillsCenter')
const { default: PromptSkillAction } = await import('../src/PromptSkillAction')
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
    assert.deepEqual(requests[0], { stage: 'image_prompt', skill_ids: ['skill'], model_id: 'text', prompt: '人物信息图', target_model_id: 'image', shot_id: 'shot', ratio: '9:16', duration: 5, mode: 'reference', reference_asset_ids: ['frame'] })
    await view.render(component('人物信息图', 'other-shot'))
    assert.equal(button('应用提示词').disabled, true)
    assert.equal(applied.length, 0)
    await view.render(component('人物信息图，新服装'))
    assert.equal(button('应用提示词').disabled, true)
    assert.ok(document.body.textContent?.includes('当前节点内容或生成配置已变化'))
    await act(() => button('重新整理').click())
    assert.equal(button('应用提示词').disabled, false)
    await act(() => button('应用提示词').click())
    assert.deepEqual(applied, ['9:16 人物三视图，保持身份和服装一致'])
  } finally { await view.destroy() }
})
