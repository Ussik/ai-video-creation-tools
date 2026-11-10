import assert from 'node:assert/strict'
import test from 'node:test'
import { executeModelToolBatch } from '../src/modules/generation/model-tool-batch.js'
test('independent reads run with a bound; the first write is a barrier and later calls never execute',async()=>{
 const calls=[{id:1,key:'a',read:true},{id:2,key:'b',read:true},{id:3,key:'a',read:true},{id:4,key:'c',read:true},{id:5,key:'d',read:false},{id:6,key:'e',read:true}]
 const started:number[]=[],ended:number[]=[],deferred:number[]=[];let running=0,max=0
 await executeModelToolBatch(calls,{read:call=>call.read,resource:call=>call.key,stopped:()=>false,
 execute:async call=>{started.push(call.id);max=Math.max(max,++running);if(!call.read)assert.equal(running,1);await new Promise(resolve=>setImmediate(resolve));ended.push(call.id);running--},defer:call=>deferred.push(call.id)})
 assert.ok(max>1&&max<=3);assert.ok(ended.indexOf(1)<started.indexOf(3));assert.deepEqual(ended.slice(-1),[5]);assert.deepEqual(deferred,[6]);assert.ok(!started.includes(6))
})

test('overlapping multi-resource reads retain their order and failures settle before a write', async () => {
  const completed: number[] = [], started: number[] = []
  await executeModelToolBatch([{ id: 1, keys: ['a'] }, { id: 2, keys: ['a', 'b'] }, { id: 3, keys: ['b'] }], {
    read: () => true, resources: call => call.keys, stopped: () => false, defer: () => assert.fail('unexpected defer'),
    execute: async call => { started.push(call.id); await new Promise(resolve => setImmediate(resolve)); completed.push(call.id) },
  })
  assert.deepEqual(started, [1, 2, 3]); assert.deepEqual(completed, [1, 2, 3])
  const events: string[] = []
  await assert.rejects(executeModelToolBatch(['fail', 'wait', 'write'], { read: call => call !== 'write', resource: call => call,
    stopped: () => false, defer: () => {}, execute: async call => {
      if (call === 'fail') throw new Error('read failed')
      if (call === 'wait') { await new Promise(resolve => setImmediate(resolve)); events.push('settled') }
      else events.push('write')
    } }), /read failed/)
  assert.deepEqual(events, ['settled'])
})

test('queued waves and writes stop on cancellation', async () => {
  const controller = new AbortController(), executed: number[] = []
  await assert.rejects(executeModelToolBatch([1, 2, 3], { read: call => call < 3, resource: () => 'same', signal: controller.signal,
    stopped: () => false, defer: () => {}, execute: async call => { executed.push(call); controller.abort() } }), /abort/i)
  assert.deepEqual(executed, [1])
})

test('relayed read failures defer every remaining call while independent reads settle unchanged', async () => {
  const calls = [{ id: 1, key: 'a', read: true }, { id: 2, key: 'b', read: true }, { id: 3, key: 'a', read: true },
    { id: 4, key: 'write', read: false }, { id: 5, key: 'later', read: true }]
  const executed: number[] = [], deferred: Array<[number, string]> = []
  let failed = false
  await executeModelToolBatch(calls, { read: call => call.read, resource: call => call.key, stopped: () => false, readFailed: () => failed,
    execute: async call => { executed.push(call.id); if (call.id === 1) failed = true; await new Promise(resolve => setImmediate(resolve)) },
    defer: (call, reason) => deferred.push([call.id, reason]),
  })
  assert.deepEqual(executed, [1, 2])
  assert.deepEqual(deferred, [[3, 'read_failed'], [4, 'read_failed'], [5, 'read_failed']])
})
