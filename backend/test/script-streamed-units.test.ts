import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBlockStreamReader, createWorkflowStreamReader, recoverBlockStream, recoverWorkflowStream } from '../src/modules/script/script-streamed-units.js'

const artifact = { artifact_type: 'outline', title: '故乡', content: '林舟说："回家"。路径 C:\\剧本\\原稿，下一行\n🌙。' }
const scene = { heading: '第一场', action: '伙伴归来', meta: { list: [true, false, null, -1.25e3, { content: '闭合 } ] 不是边界' }] } }
const emptyWorkflow = { artifacts: [], scenes: [] }

test('recovers complete workflow objects in order from direct and result-wrapped roots', () => {
  const value = { artifacts: [artifact, { title: '结局', content: '归还钥匙' }], scenes: [scene, { heading: '终场' }] }
  assert.deepEqual(recoverWorkflowStream(JSON.stringify(value)), value)
  assert.deepEqual(recoverWorkflowStream(` \n\t${JSON.stringify({ meta: '兼容包装', result: value })}`), value)
  assert.deepEqual(recoverWorkflowStream('{"result":{"artifacts":[{},{}],"scenes":[{}]'), { artifacts: [{}, {}], scenes: [{}] })
})

test('every truncated prefix retains exactly the objects already fully closed', () => {
  const first = JSON.stringify(artifact), second = JSON.stringify(scene)
  const raw = `{"artifacts":[${first}],"scenes":[${second}]}`
  const firstEnd = raw.indexOf(first) + first.length, secondEnd = raw.indexOf(second) + second.length
  for (let cut = 0; cut <= raw.length; cut++) {
    assert.deepEqual(recoverWorkflowStream(raw.slice(0, cut)), {
      artifacts: cut >= firstEnd ? [artifact] : [], scenes: cut >= secondEnd ? [scene] : [],
    }, `wrong recovery at UTF-16 offset ${cut}`)
  }
})

test('does not decode or retain an unfinished object, string or escaped code point', () => {
  const prefix = `{"artifacts":[${JSON.stringify(artifact)},`
  for (const tail of ['{', '{"content":', '{"content":"half', '{"content":"half\\', '{"content":"\\u4', '{"content":"\\u4f60"', '{"nested":{"done":true}']) {
    assert.deepEqual(recoverWorkflowStream(prefix + tail), { artifacts: [artifact], scenes: [] }, tail)
  }
  assert.deepEqual(recoverWorkflowStream('{"artifacts":[{"content":"\\u4f60\\u597d\\ud83c\\udf19\\t\\/"}]'), { artifacts: [{ content: '你好🌙\t/' }], scenes: [] })
  assert.deepEqual(recoverWorkflowStream('{"\\u0061rtifacts":[{"ok":true}]'), { artifacts: [{ ok: true }], scenes: [] })
})

test('ignores pseudo fields in content, nested objects, arrays and nested result wrappers', () => {
  const fake = '{"artifacts":[{"content":"fake"}],"scenes":[{"heading":"fake"}]}'
  const real = { ...artifact, content: `原稿示例：${fake}，转义 \\" 与括号 } ]` }
  const raw = JSON.stringify({ text: fake, metadata: { artifacts: [{ fake: true }], result: { scenes: [{ fake: true }] } },
    rows: [{ scenes: [{ fake: true }] }], artifacts: [real], result: { result: { artifacts: [{ fake: true }] } }, scenes: [scene] })
  assert.deepEqual(recoverWorkflowStream(raw), { artifacts: [real], scenes: [scene] })
  assert.deepEqual(recoverWorkflowStream(JSON.stringify({ artifacts: [{ nested: { scenes: [scene] } }] })), { artifacts: [{ nested: { scenes: [scene] } }], scenes: [] })
})

test('stops at invalid syntax instead of searching later text for plausible array members', () => {
  const prefix = `{"artifacts":[${JSON.stringify(artifact)}`
  for (const tail of [
    ',{"content":"bad\\q"},{"fake":true}],"scenes":[{"fake":true}]}',
    ',{"content":"bad\nnewline"},{"fake":true}],"scenes":[{"fake":true}]}',
    ',{"content":"bad\\u00zz"},{"fake":true}],"scenes":[{"fake":true}]}',
    ',{"value":01},{"fake":true}],"scenes":[{"fake":true}]}',
    ',{"value":true garbage},{"fake":true}],"scenes":[{"fake":true}]}',
    ',{"value":1,},{"fake":true}],"scenes":[{"fake":true}]}',
    ',broken,{"fake":true}],"scenes":[{"fake":true}]}',
    ',,{"fake":true}],"scenes":[{"fake":true}]}',
    ' {"fake":true}],"scenes":[{"fake":true}]}',
    ',],"scenes":[{"fake":true}]}',
  ]) assert.deepEqual(recoverWorkflowStream(prefix + tail), { artifacts: [artifact], scenes: [] }, tail)
  assert.deepEqual(recoverWorkflowStream('{"text":broken,"artifacts":[{"fake":true}]}'), emptyWorkflow)
})

test('does not search prefixes, quoted roots or trailing material for another workflow', () => {
  const raw = JSON.stringify({ artifacts: [artifact], scenes: [scene] })
  for (const prefix of ['plain text ', '```json\n', '<think>example</think>', '[', 'null ', '"']) {
    assert.deepEqual(recoverWorkflowStream(prefix + raw), emptyWorkflow)
  }
  assert.deepEqual(recoverWorkflowStream(`{} ${raw}`), emptyWorkflow)
  assert.deepEqual(recoverWorkflowStream(`{"result":null,"metadata":${raw}}`), emptyWorkflow)
  assert.deepEqual(recoverWorkflowStream(`{"result":[${raw}]}`), emptyWorkflow)
})

test('keeps closed units when only the enclosing array, root or trailing metadata is unfinished', () => {
  const raw = `{"artifacts":[${JSON.stringify(artifact)}],"scenes":[${JSON.stringify(scene)}]`
  for (const tail of ['', ',"meta":', ',"meta":"unfinished', ',invalid', '} malformed tail']) {
    assert.deepEqual(recoverWorkflowStream(raw + tail), { artifacts: [artifact], scenes: [scene] })
  }
})

test('retains only direct object members without applying business field validation', () => {
  const raw = JSON.stringify({ artifacts: [null, true, 'text', 2, [{ nested: true }], {}, { unexpected: ['anything'] }], scenes: [false, { arbitrary: 1 }] })
  assert.deepEqual(recoverWorkflowStream(raw), { artifacts: [{}, { unexpected: ['anything'] }], scenes: [{ arbitrary: 1 }] })
})

test('block recovery uses the same strict boundaries, escaping and result wrapping', () => {
  const blocks = [{ kind: 'paragraph', content: '第一段："你好"。\\路径\n' }, { kind: 'scene', content: JSON.stringify({ blocks: [{ fake: true }] }) }]
  const first = JSON.stringify(blocks[0]), second = JSON.stringify(blocks[1])
  const raw = `{"result":{"blocks":[${first},${second}]}}`
  const firstEnd = raw.indexOf(first) + first.length, secondEnd = raw.indexOf(second) + second.length
  for (let cut = 0; cut <= raw.length; cut++) assert.deepEqual(recoverBlockStream(raw.slice(0, cut)), { blocks: cut >= secondEnd ? blocks : cut >= firstEnd ? [blocks[0]] : [] }, `wrong block recovery at ${cut}`)
  assert.deepEqual(recoverBlockStream('{"metadata":{"blocks":[{"fake":true}]},"blocks":[{"text":"done"},{"text":"partial'), { blocks: [{ text: 'done' }] })
  assert.deepEqual(recoverBlockStream('{"blocks":[{"text":"done"},oops,{"fake":true}]}'), { blocks: [{ text: 'done' }] })
  assert.deepEqual(recoverWorkflowStream('{"blocks":[{}]}'), emptyWorkflow)
  assert.deepEqual(recoverBlockStream('{"artifacts":[{}],"scenes":[{}]}'), { blocks: [] })
})

test('deep or malformed nesting stops safely without scanning an embedded fake root', () => {
  const raw = `{"artifacts":[${JSON.stringify(artifact)},${'['.repeat(1000)}{"artifacts":[{"fake":true}]}`
  assert.deepEqual(recoverWorkflowStream(raw), { artifacts: [artifact], scenes: [] })
})

test('incremental workflow reader matches strict recovery at every prefix and emits each completed unit once', () => {
  const value = { result: { artifacts: [artifact, { title: '正文中的伪字段', content: '{"scenes":[{}]}' }], scenes: [scene] } }
  const raw = JSON.stringify(value), reader = createWorkflowStreamReader()
  let completedChanges = 0
  for (let cut = 0; cut <= raw.length; cut++) {
    const result = reader.read(raw.slice(0, cut)), expected = recoverWorkflowStream(raw.slice(0, cut))
    assert.deepEqual({ artifacts: result.artifacts, scenes: result.scenes }, expected, `wrong reader state at ${cut}`)
    assert.equal(result.reset, false)
    if (result.changed) completedChanges++
  }
  assert.equal(completedChanges, 3)
  assert.equal(reader.read(raw).changed, false, 'replaying the same cumulative snapshot must not emit units twice')
})

test('incremental reader does not reparse completed units while receiving a long unfinished string', () => {
  const reader = createWorkflowStreamReader()
  const prefix = `{"artifacts":[${JSON.stringify(artifact)},{"content":"`
  const complete = reader.read(prefix)
  assert.equal(complete.changed, true)
  for (let size = 1; size <= 100000; size += 100) {
    const next = reader.read(prefix + '长'.repeat(size))
    assert.equal(next.artifacts, complete.artifacts, 'unfinished text must retain the cached array rather than parse the full prefix again')
    assert.equal(next.changed, false)
    assert.equal(next.reset, false)
  }
})

test('incremental reader resets when a retry replaces its response, including same-length content changes', () => {
  const reader = createWorkflowStreamReader()
  const first = '{"artifacts":[{"content":"first"}]}'
  const second = '{"artifacts":[{"content":"other"}]}'
  assert.deepEqual(reader.read(first), { artifacts: [{ content: 'first' }], scenes: [], changed: true, reset: false })
  assert.deepEqual(reader.read(second), { artifacts: [{ content: 'other' }], scenes: [], changed: true, reset: true })
  assert.deepEqual(reader.read('{"artifacts":[{"content":"partial'), { ...emptyWorkflow, changed: true, reset: true })
  assert.deepEqual(reader.read('{"artifacts":[{"content":"partial"}'), { artifacts: [{ content: 'partial' }], scenes: [], changed: true, reset: false })
  assert.deepEqual(reader.read(''), { ...emptyWorkflow, changed: true, reset: true })
})

test('incremental block reader preserves escape state across every split and never accepts objects after invalid syntax', () => {
  const block = { id: 'b1', content: '转义引号 " 与反斜线 \\，以及🌙', scenes: [] }
  const raw = `{"blocks":[${JSON.stringify(block)},{"content":"bad\\q"},{"id":"fake"}]}`
  const reader = createBlockStreamReader()
  let changes = 0
  for (let cut = 0; cut <= raw.length; cut++) {
    const result = reader.read(raw.slice(0, cut))
    assert.deepEqual(result.blocks, recoverBlockStream(raw.slice(0, cut)).blocks)
    if (result.changed) changes++
  }
  assert.equal(changes, 1)
  assert.deepEqual(reader.read('{"result":{"blocks":[{"id":"real"}'), { blocks: [{ id: 'real' }], changed: true, reset: true })
})
