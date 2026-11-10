import assert from 'node:assert/strict'
import test from 'node:test'
import { createSourceWorkset, createModelResultResources } from '../src/modules/generation/model-source-workset.js'
test('a locator or last page does not claim full source coverage; immutable pages preserve all text', () => {
 const work = createSourceWorkset('source', 'abcdefghij')
 assert.deepEqual(work.snapshot().read_receipts, [])
 assert.equal(work.read(work.version, 8, 2).complete_source, false)
 const first = work.read(work.version,0,8)
 assert.equal(first.text, 'abcdefgh'); assert.equal(first.complete_source, true)
 assert.throws(()=>work.read('old',0,2), /版本/)
})
test('oversized state catalog is losslessly available through paged resource reads', () => {
 const resources = createModelResultResources(), value = { items: ['中文'.repeat(30000)] }
 const locator = resources.externalize(value) as { resource_id:string;version:string;total_length:number;complete_source:boolean }
 assert.equal(locator.complete_source,false)
 let text = ''
 for (let offset=0;offset<locator.total_length;offset+=16000) text += resources.read(locator.resource_id,locator.version,offset,16000).text
 assert.deepEqual(JSON.parse(text),value)
 assert.throws(()=>createModelResultResources().read(locator.resource_id,locator.version,0,100), /失效/)
})
