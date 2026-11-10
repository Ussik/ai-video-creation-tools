import assert from 'node:assert/strict'
import test from 'node:test'
import { compactNativeToolHistory } from '../src/infrastructure/providers/text-tool-history.js'
const assistant = (id: string) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'read_document', input: { id: 'doc', version: '1' } }] })
const result = (id: string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'long content '.repeat(5000) }] })
test('native compaction removes only complete pure tool pairs and preserves latest exchange', () => {
 const initial = { role: 'user', content: 'immutable task' }, recent = assistant('b'), pending = assistant('c')
 const history = [initial, assistant('a'), result('a'), recent, result('b'), pending]
 const compacted = compactNativeToolHistory(history, 1, true)
 assert.equal(compacted[0], initial); assert.equal(compacted.at(-1), pending); assert.equal(compacted.at(-3), recent)
 assert.ok(JSON.stringify(compacted).length < JSON.stringify(history).length)
 assert.ok(!JSON.stringify(compacted[1]).includes('private')); assert.ok(!JSON.stringify(compacted[1]).includes('signed:a'))
 assert.deepEqual(history[1], assistant('a'))
})
test('unmatched and mixed native exchanges remain intact', () => {
 const history = [{ role: 'user', content: 'task' }, assistant('a'), result('other'), assistant('b')]
 assert.equal(compactNativeToolHistory(history, 1, true), history)
})

test('signed thinking or mixed assistant text prevents unsafe exchange rewriting', () => {
 const signed = {...assistant('a'), content:[{type:'thinking',thinking:'private',signature:'signed'}, ...assistant('a').content]}
 const history=[{role:'user',content:'task'}, signed,result('a'),assistant('b'),result('b'),assistant('c')]
 assert.equal(compactNativeToolHistory(history,1,true),history)
 const mixed=[{role:'user',content:'task'}, {...assistant('a'),content:[{type:'text',text:'prior answer'},...assistant('a').content]},result('a'),assistant('b'),result('b'),assistant('c')]
 assert.equal(compactNativeToolHistory(mixed,1,true),mixed)
})
