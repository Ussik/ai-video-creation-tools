import assert from 'node:assert/strict'
import { register } from 'node:module'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { MantineProvider } from '@mantine/core'
import { createScriptRequestUsage } from '@video-studio/shared/script/script-request-usage'
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context) }`)}`, import.meta.url)
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/',pretendToBeVisual:true})
for(const key of ['window','document','navigator','Node','Document','HTMLElement','Element','ShadowRoot','Event','MouseEvent','MutationObserver']) Object.defineProperty(globalThis,key,{configurable:true,value:(dom.window as unknown as Record<string,unknown>)[key]})
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}})
Object.defineProperty(dom.window,'matchMedia',{value:()=>({matches:false,addEventListener(){},removeEventListener(){}})})
const {createRoot}=await import('react-dom/client')
const {default:ModelTaskProgress}=await import('../src/features/jobs/ModelTaskProgress')
after(()=>dom.window.close())
test('progress shows unsettled usage and exact output cap; stop uses project API and never claims remote cancellation',async()=>{
 const requests:Array<{url:string;method?:string}>=[]
 const usage={...createScriptRequestUsage(),requests:1,estimated_input_tokens:30,estimated_output_tokens:65536,uncertain_requests:1}
 const rows=[{id:'task',label:'分镜规划',state:'running',owner:'request',can_cancel:true,created_at:'2026-11-10T00:00:00Z',progress:[{phase_id:'shots',label:'逐场分镜',completed_units:2,total_units:5},{phase_id:'review',label:'审读分页',completed_units:3,total_units:null}],usage,attempts:[{id:'request',state:'settled',metrics:{failure_reason:'output_limit',raw_reason:'length',output_limit:65536,request_purpose:'generation'}}]}]
 const originalFetch=globalThis.fetch
 globalThis.fetch=async(input,options)=>{requests.push({url:String(input),method:options?.method});return new Response(JSON.stringify(String(input).endsWith('/stop')?{stopped:true,remote_cancelled:false}:rows),{headers:{'content-type':'application/json'}})}
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container)
 try{
 await act(async()=>{root.render(<MantineProvider env="test"><ModelTaskProgress projectId="p"/></MantineProvider>);await new Promise(resolve=>setTimeout(resolve,10))})
 await act(()=>{container.querySelector<HTMLButtonElement>('.mantine-Accordion-control')!.click()})
 assert.match(container.textContent||'',/已保留 2 个完整单元，剩余 3 个/);assert.match(container.textContent||'',/剩余范围待核对/)
 assert.match(container.textContent||'',/用量待核对/);assert.match(container.textContent||'',/65,536/);assert.match(container.textContent||'',/单次输出达到额度/)
 const stop=[...container.querySelectorAll('button')].find(button=>button.textContent==='停止本地处理')!
 await act(async()=>{stop.click();await new Promise(resolve=>setTimeout(resolve,10))})
 assert.ok(requests.some(request=>request.url==='/api/projects/p/model-requests/task/stop'&&request.method==='POST'))
 assert.ok(requests.every(request=>!request.url.includes('/api/api/')))
 assert.ok(!container.textContent?.includes('厂商已取消'))
 }finally{await act(()=>root.unmount());container.remove();globalThis.fetch=originalFetch}
})
