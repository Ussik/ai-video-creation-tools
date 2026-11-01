import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDocumentReadPage, documentReadPageLimit, type DocumentReadRequest } from '../src/modules/script/script-document-read-page.js'
import { documentParagraphs } from '../src/modules/script/script-revision.js'

const request: DocumentReadRequest = { source: 'draft', offset: 0, length: 20_000, scene_offset: 0, scene_limit: 10 }
const document = (id: string, content: string) => ({ id, title: `文档 ${id}`, version: `version-${id}`, artifact_type: 'characters', content })

test('automatically sizes eight 20k document pages against the entire serialized tool response', () => {
  const inputs = Array.from({ length: 8 }, (_, i) => ({ document: document(`${i}`, '一段带引号的原文："不可丢失"。\n\n'.repeat(1200)) }))
  const result = buildDocumentReadPage(inputs, request)
  assert.ok(JSON.stringify(result).length <= documentReadPageLimit)
  assert.equal(result.documents.length, 8)
  assert.deepEqual(result.deferred_document_ids, [])
  for (const page of result.documents) {
    assert.ok(page.next_offset > page.offset)
    assert.equal(page.content, inputs.find(input => input.document.id === page.id)!.document.content.slice(page.offset, page.next_offset))
    assert.equal(page.complete, false)
    assert.ok(page.paragraphs.every(paragraph => paragraph.start >= page.offset && paragraph.end <= page.next_offset))
    assert.ok(result.continuations.some(next => next.document_ids[0] === page.id && next.offset === page.next_offset))
  }
})

test('following automatic continuations reconstructs all documents exactly, including giant paragraphs and escaped text', () => {
  const inputs = [
    { document: document('long-paragraph', '巨型段落"\\\n'.repeat(5000)) },
    { document: document('anchors', Array.from({ length: 240 }, (_, i) => `第 ${i} 段："原文保留"\n同段下一行。`).join('\n\n')) },
  ]
  const collected = new Map(inputs.map(input => [input.document.id, '']))
  let pending = inputs.map(input => ({ ...request, document_ids: [input.document.id] }))
  let rounds = 0
  while (pending.length) {
    assert.ok(++rounds < 100)
    const next = pending.shift()!
    const input = inputs.find(input => input.document.id === next.document_ids[0])!
    const result = buildDocumentReadPage([input], next, { maxSerializedCharacters: 3500 })
    assert.ok(JSON.stringify(result).length <= 3500)
    const page = result.documents[0]!
    assert.equal(page.offset, collected.get(page.id)!.length)
    collected.set(page.id, collected.get(page.id)! + page.content)
    const originals = documentParagraphs(input.document.content, input.document.version)
    assert.deepEqual(page.paragraphs, originals.filter(paragraph => paragraph.start >= page.offset && paragraph.end <= page.next_offset))
    pending.push(...result.continuations)
  }
  for (const input of inputs) assert.equal(collected.get(input.document.id), input.document.content)
})

test('large scenes make bounded progress through versioned JSON fragments, and preserve every scene field', () => {
  const scenes = [
    { id: 'small', version: 'small-version', heading: '第一场', action: '人物走入。', dialogue: '你好。' },
    { id: 'giant', version: 'giant-version', heading: '第二场', action: '"\\\n动作。'.repeat(12_000), dialogue: '对白。'.repeat(10_000) },
    { id: 'tail', version: 'tail-version', heading: '第三场', action: '结尾。', dialogue: '' },
  ]
  const input = { document: document('episode', '完整分集原文。'.repeat(700)), scenes }
  const reconstructed = new Map<string, string>()
  const ordinary = new Map<string, typeof scenes[number]>()
  let next: DocumentReadRequest | undefined = request
  let content = '', rounds = 0
  while (next) {
    assert.ok(++rounds < 150)
    const result = buildDocumentReadPage([input], next, { maxSerializedCharacters: 6000 })
    assert.ok(JSON.stringify(result).length <= 6000)
    const page = result.documents[0]!
    assert.equal(page.offset, content.length)
    content += page.content
    for (const scene of page.scenes || []) ordinary.set(scene.id, scene)
    for (const fragment of page.scene_fragments || []) {
      const before = reconstructed.get(fragment.id) || ''
      assert.equal(fragment.offset, before.length)
      assert.ok(fragment.next_offset > fragment.offset)
      assert.equal(fragment.complete, fragment.next_offset === fragment.total_length)
      reconstructed.set(fragment.id, before + fragment.serialized_scene_fragment)
    }
    next = result.continuations[0]
    if (!next) assert.equal(page.scenes_complete, true)
  }
  assert.equal(content, input.document.content)
  for (const scene of scenes) assert.deepEqual(ordinary.get(scene.id) || JSON.parse(reconstructed.get(scene.id)!), scene)
  assert.ok(reconstructed.has('giant'), 'the giant scene must be fragmented, never silently omitted')
})

test('explicitly reports every deferred document under a budget that fits only the first metadata-heavy document', () => {
  const inputs = Array.from({ length: 8 }, (_, i) => ({ document: { ...document(`${i}`, '正文。'.repeat(3000)), title: '很长的标题'.repeat(32) } }))
  const result = buildDocumentReadPage(inputs, request, { maxSerializedCharacters: 2400 })
  assert.ok(JSON.stringify(result).length <= 2400)
  assert.ok(result.documents.length > 0)
  assert.ok(result.deferred_document_ids.length > 0)
  assert.deepEqual(new Set([...result.documents.map(page => page.id), ...result.deferred_document_ids]), new Set(inputs.map(input => input.document.id)))
  for (const id of result.deferred_document_ids) assert.ok(result.continuations.some(next => next.document_ids[0] === id && next.offset === 0))
})

test('validates body and scene fragment offsets rather than claiming an invalid page is complete', () => {
  const input = { document: document('short', '正文'), scenes: [{ id: 's', version: 'v', action: '动作' }] }
  assert.throws(() => buildDocumentReadPage([input], { ...request, offset: 3 }), /读取位置/)
  assert.throws(() => buildDocumentReadPage([input], { ...request, scene_offset: 2 }), /场次读取位置/)
  assert.throws(() => buildDocumentReadPage([input], { ...request, scene_content_offset: 1000 }), /场次片段/)
})

test('a fitting emoji pair makes progress even when its lone surrogate exceeds a tight page budget', () => {
  const input = { document: { id: 'd', title: '标题', version: 'v', content: '😀' + '长'.repeat(100) } }
  const result = buildDocumentReadPage([input], request, { maxSerializedCharacters: 475 })
  assert.ok(JSON.stringify(result).length <= 475)
  assert.equal(result.documents[0]!.content, '😀')
  assert.equal(result.documents[0]!.next_offset, 2)
  assert.equal(result.continuations[0]!.offset, 2)
})
