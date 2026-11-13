import assert from 'node:assert/strict'
import test from 'node:test'
import { retryReadOnlyRequest } from '../src/modules/generation/read-only-retry.js'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'
test('partial output and input overflow never replay the same unchanged request',async()=>{
 for(const kind of ['partial','context'] as const){
 let calls=0
 const issue=new TextProviderError('failed',true,kind==='context'?'context_length_exceeded':'stream_disconnected')
 if(kind==='partial'){issue.partialText='{"complete_unit":1}';issue.outputStarted=true}
 await assert.rejects(retryReadOnlyRequest(async()=>{calls++;throw issue},{wait:async()=>{}}),error=>error===issue)
 assert.equal(calls,1)
 }
})
test('a long Retry-After becomes explicit resumable wait without early retry',async()=>{
 let calls=0, waits=0
 const issue=new TextProviderError('rate limit',true,'rate_limit',429,undefined,120000)
 await assert.rejects(retryReadOnlyRequest(async()=>{calls++;throw issue},{wait:async()=>{waits++}}),error=>error===issue)
 assert.equal(calls,1);assert.equal(waits,0)
 assert.ok((issue as TextProviderError & {retryAt:number}).retryAt>Date.now()+100000)
})


test('validated atomic read-only output can explicitly discard one transient incomplete response', async () => {
 let calls = 0
 const issue = new TextProviderError('disconnected', true, 'stream_disconnected')
 issue.partialText = '{"answer":"partial'; issue.outputStarted = true
 const result = await retryReadOnlyRequest(async () => {
  calls++
  if (calls === 1) throw issue
  return '{"answer":"complete"}'
 }, { discardIncompleteOutput: true, wait: async () => {} })
 assert.equal(result, '{"answer":"complete"}'); assert.equal(calls, 2)
})

test('discarding an incomplete draft never retries output limits, context rejection or invalid tool arguments', async () => {
 for (const code of ['max_tokens', 'context_length_exceeded', 'invalid_tool_call']) {
  let calls = 0
  const issue = new TextProviderError('failed', true, code)
  issue.partialText = 'incomplete'; issue.outputStarted = true
  await assert.rejects(retryReadOnlyRequest(async () => { calls++; throw issue },
   { discardIncompleteOutput: true, wait: async () => {} }), error => error === issue)
  assert.equal(calls, 1)
 }
})
