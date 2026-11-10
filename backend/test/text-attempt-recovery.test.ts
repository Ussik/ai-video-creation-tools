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
