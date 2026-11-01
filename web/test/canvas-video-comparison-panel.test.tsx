import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { register } from 'node:module'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { MantineProvider } from '@mantine/core'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window','document','navigator','Node','HTMLElement','Element','Event','MouseEvent','HTMLTextAreaElement','ShadowRoot','Document']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as unknown as Record<string, unknown>)[key] })
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.defineProperty(dom.window.document, 'fonts', { value: { addEventListener() {}, removeEventListener() {} } })
const { createRoot } = await import('react-dom/client')
const { default: Panel } = await import('../src/features/canvas/CanvasVideoComparisonPanel')
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch; dom.window.close() })

const asset = { id:'baseline',project_id:'project',shot_id:'shot',kind:'video',source:'generated',prompt:'原片动作',url:'/baseline.mp4' } as any
const record = { id:'comparison',project_id:'project',shot_id:'shot',shot_title:'反应',label:'动作对照',baseline_job_id:'baseline-job',baseline_asset_id:'baseline',
  baseline_url:'/baseline.mp4',baseline_prompt:'原片动作',candidate_prompt:'笑容消失，右手抬起',candidate_job_id:null,candidate_asset_id:null,candidate_url:null,
  status:'prepared',error:null,model_id:'model',model_name:'固定 Fast 模型',parameters:{reference_asset_ids:['a','b'],ratio:'16:9',resolution:'480p'},
  generation_duration_ms:4000,edit_duration_ms:2000,trim_target_ms:2000,seed_locked:false,changed_fields:['prompt'],stale:false,stale_reasons:[],created_at:'2026-10-26T00:00:00Z',started_at:null }
async function mount(onReviewCandidate?: (asset: any) => void) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<MantineProvider env="test"><Panel projectId="project" asset={asset} onClose={() => {}} onReviewCandidate={onReviewCandidate} /></MantineProvider>))
  const button = (label: string) => {
    const target = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label)
    assert.ok(target, `Missing button ${label}`); return target
  }
  return { container,button,destroy:async()=>{ await act(()=>root.unmount());container.remove() } }
}

test('preparing a comparison does not generate, and running uses the frozen record', async () => {
  const requests: { url:string;method:string;body?:any }[] = []
  globalThis.fetch = (async (input, init) => {
    const url = String(input), method = init?.method || 'GET'
    requests.push({url,method,body:typeof init?.body==='string'?JSON.parse(init.body):undefined})
    return new Response(JSON.stringify(method==='GET'?{comparisons:[]}:url.endsWith('/start')?{...record,status:'queued',candidate_job_id:'candidate-job'}:record),{status:200,headers:{'Content-Type':'application/json'}})
  }) as typeof fetch
  const view = await mount()
  try {
    assert.equal(requests.length,1)
    assert.equal(view.button('开始对照生成').disabled,true)
    const field = view.container.querySelector('textarea')!
    await act(()=>{
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value')!.set!.call(field,record.candidate_prompt)
      field.dispatchEvent(new dom.window.Event('input',{bubbles:true}))
    })
    await act(async()=>view.button('准备对照').click())
    assert.deepEqual(requests[1]?.body,{baseline_asset_id:'baseline',candidate_prompt:record.candidate_prompt,label:'动作提示词对照'})
    assert.equal(requests.some(request=>request.url.endsWith('/start')),false)
    assert.match(view.container.textContent!,/生成请求时长4 秒/)
    assert.match(view.container.textContent!,/计划入片时长2 秒/)
    assert.match(view.container.textContent!,/不会自动裁剪或修改时间线/)
    assert.equal(view.button('开始对照生成').disabled,false)
    await act(async()=>view.button('开始对照生成').click())
    assert.ok(requests[2]?.url.endsWith('/comparison/start'))
    assert.equal(view.button('开始对照生成').disabled,true)
  } finally { await view.destroy() }
})

test('stale inputs disable submission while preserving candidate text for a fresh preparation', async () => {
  globalThis.fetch = (async()=>new Response(JSON.stringify({comparisons:[{...record,stale:true,stale_reasons:['参考图片内容已变化']}]}),{status:200})) as typeof fetch
  const view = await mount()
  try {
    assert.equal(view.button('开始对照生成').disabled,true)
    assert.match(view.container.textContent!,/参考图片内容已变化/)
    assert.equal(view.container.querySelector('textarea')!.value,record.candidate_prompt)
    assert.equal(view.button('准备对照').disabled,false)
  } finally { await view.destroy() }
})

test('a completed candidate can be opened for review using its actual asset identity', async () => {
  const candidateAsset = { ...asset, id: 'candidate-asset', filename: 'candidate.mp4', url: '/candidate.mp4', prompt: record.candidate_prompt }
  const reviewed: any[] = []
  globalThis.fetch = (async()=>new Response(JSON.stringify({comparisons:[{...record,status:'succeeded',candidate_url:'/candidate.mp4',candidate_asset:candidateAsset}]}),{status:200})) as typeof fetch
  const view = await mount(asset => reviewed.push(asset))
  try {
    await act(()=>view.button('复核对照候选').click())
    assert.deepEqual(reviewed,[candidateAsset])
    assert.equal(view.container.querySelector('video')?.getAttribute('src'),'/candidate.mp4')
  } finally { await view.destroy() }
})
