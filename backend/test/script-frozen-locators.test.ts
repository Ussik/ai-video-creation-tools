import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { createFrozenPassageRegistry, frozenPassageEditSchema, frozenPassageVersion } from '../src/modules/script/script-frozen-locators.js'
import { createDraftRepairReferences } from '../src/modules/script/script-draft-repair-references.js'
import { applyResolvedEdits, documentParagraphs, ScriptToolProblem } from '../src/modules/script/script-revision.js'

const identity = { candidate_id: 'candidate', candidate_version: 'version', source_version: 'source' }
const proposal = { replace: '修订后正文。', reason: '落实完整作者反馈' }
const input = (id: string, content: string) => ({ id, version: frozenPassageVersion(identity, id, content), content, read_ranges: [[0, content.length] as [number, number]] })
const problem = (code: string) => (error: unknown) => error instanceof ScriptToolProblem && error.diagnostic.code === code
const frozenDocs = (prompt: string) => JSON.parse(prompt.split('可替换来源（冻结段落原文）：')[1]!.split('\n')[0]!)

test('registry binds every repeated paragraph to immutable source/version/UTF16 range and text digest without string lookup', () => {
  const original = input('world', '\r\n重复🦊。\r\n\r\n重复🦊。\r\n\r\n尾段é。\r\n')
  const registry = createFrozenPassageRegistry([original])
  const blocks = registry.documents[0]!.blocks
  assert.equal(blocks.length, 3); assert.equal(new Set(blocks.map(block => block.paragraph_id)).size, 3)
  assert.deepEqual(blocks.map(block => block.paragraph_id), documentParagraphs(original.content, original.version).map(block => block.id))
  for (const block of blocks) {
    assert.equal(original.content.slice(block.start, block.end), block.text)
    assert.equal(block.text_sha256, createHash('sha256').update(block.text).digest('hex'))
  }
  assert.notEqual(blocks[0]!.paragraph_id, blocks[1]!.paragraph_id)
  const changes = registry.resolve(original.id, original, [{ paragraph_id: blocks[1]!.paragraph_id, ...proposal }])
  assert.equal(changes[0]!.start, blocks[1]!.start)
  assert.equal(applyResolvedEdits(original.content, changes), original.content.slice(0, blocks[1]!.start) + proposal.replace + original.content.slice(blocks[1]!.end))
  original.content = '调用者改了原文'
  blocks[1]!.start = 0; blocks[1]!.text = '篡改公有元数据'
  const frozen = input('world', '\r\n重复🦊。\r\n\r\n重复🦊。\r\n\r\n尾段é。\r\n')
  assert.equal(registry.resolve('world', frozen, [{ paragraph_id: blocks[1]!.paragraph_id, ...proposal }])[0]!.start, 11, 'input/public mutations cannot alter trusted ranges')
})

test('registry rejects foreign/stale/fabricated IDs, source and version drift, and overlapping aliases atomically', () => {
  const world = input('world', '同字原文。\n\n另段。'), constraints = input('constraints', '同字原文。\n\n另段。')
  const registry = createFrozenPassageRegistry([world, constraints])
  const block = registry.documents[0]!.blocks[0]!, foreign = registry.documents[1]!.blocks[0]!
  assert.notEqual(block.paragraph_id, foreign.paragraph_id)
  for (const paragraph_id of [foreign.paragraph_id, block.paragraph_id.replace(/.$/, '0'), 'p:0:1:forged']) {
    assert.throws(() => registry.resolve('world', world, [{ paragraph_id, ...proposal }]), problem('anchor_stale'))
  }
  assert.throws(() => registry.resolve('absent', world, [{ paragraph_id: block.paragraph_id, ...proposal }]), problem('document_not_registered'))
  for (const changed of [{ ...world, version: 'changed' }, { ...world, content: world.content + '变更' }]) {
    assert.throws(() => registry.resolve('world', changed, [{ paragraph_id: block.paragraph_id, ...proposal }]), (error: any) => error.statusCode === 409)
  }
  for (const edits of [
    [{ paragraph_id: block.paragraph_id, ...proposal }, { paragraph_id: block.paragraph_id, ...proposal }],
    [{ paragraph_id: block.paragraph_id, ...proposal }, { find: '字原文', ...proposal }],
  ]) assert.throws(() => registry.resolve('world', world, edits), problem('overlapping_passages'))
  assert.throws(() => registry.resolve('world', world, [{ paragraph_id: block.paragraph_id, find: block.text, ...proposal }]), problem('mixed_locator'))
})

test('registry enforces registered and current read permissions without allowing a caller to widen them', () => {
  const source = input('world', '已读原文。\n\n未读原文。')
  const all = createFrozenPassageRegistry([source]).documents[0]!.blocks
  const limited = createFrozenPassageRegistry([{ ...source, read_ranges: [[0, all[0]!.end]] }])
  assert.equal(limited.documents[0]!.blocks.length, 1, 'public block inventory never includes unread text')
  assert.throws(() => limited.resolve('world', source, [{ paragraph_id: all[1]!.paragraph_id, ...proposal }], [[0, source.content.length]]), problem('unread_passage'))
  assert.throws(() => limited.resolve('world', source, [{ paragraph_id: all[0]!.paragraph_id, ...proposal }], []), problem('unread_passage'))
  assert.equal(limited.resolve('world', source, [{ paragraph_id: all[0]!.paragraph_id, ...proposal }]).length, 1)
  assert.throws(() => createFrozenPassageRegistry([{ ...source, read_ranges: [[0, Infinity]] }]), /范围/)
  const none = createFrozenPassageRegistry([{ id: source.id, version: source.version, content: source.content }])
  assert.equal(none.documents[0]!.blocks.length, 0)
  assert.throws(() => none.resolve('world', source, [{ find: '已读', ...proposal }]), problem('unread_passage'))
})

test('legacy exact find keeps uniqueness and item indices while Unicode fragments and replacements cannot split characters', () => {
  const source = input('world', '重复。\n\n重复。\n\n🦊é汉字。'), registry = createFrozenPassageRegistry([source])
  assert.throws(() => registry.resolve('world', source, [{ find: '重复。', ...proposal }]), problem('ambiguous_passage'))
  assert.throws(() => registry.resolve('world', source, [{ find: '🦊', ...proposal }, { find: '不存在', ...proposal }]), (error: any) => problem('passage_not_found')(error) && error.diagnostic.item_index === 1)
  assert.throws(() => registry.resolve('world', source, [{ find: '\ud83e', ...proposal }]), problem('invalid_unicode_boundary'))
  assert.throws(() => registry.resolve('world', source, [{ find: '汉字', ...proposal, replace: '\udd8a' }]), problem('invalid_unicode_replacement'))
  assert.throws(() => createFrozenPassageRegistry([input('bad', '\ud83e')]), /Unicode/)
  assert.throws(() => createFrozenPassageRegistry([{ ...source, read_ranges: [[0, source.content.indexOf('🦊') + 1]] }]), /UTF-16/)
  assert.equal(registry.resolve('world', source, [{ find: '重复。\n\n重复。', ...proposal }]).length, 1)
})

test('shared schema strictly separates paragraph and exact-find locators', () => {
  assert.ok(frozenPassageEditSchema.safeParse({ paragraph_id: 'p:0:3:id', ...proposal }).success)
  assert.ok(frozenPassageEditSchema.safeParse({ find: '唯一原文', ...proposal }).success)
  for (const invalid of [{ ...proposal }, { paragraph_id: 'p:0:3:id', find: '原文', ...proposal }, { paragraph_id: 'p:0:3:id', start: 0, ...proposal }]) assert.equal(frozenPassageEditSchema.safeParse(invalid).success, false)
})

test('default draft refs give repeated paragraphs distinct IDs and normalize to paragraph_id without long find', () => {
  const content = '重复🦊。\n\n重复🦊。\n\n' + '长原文'.repeat(2000)
  const sources = [{ key: 'world', title: '世界', content }, { key: 'constraints', content: '禁止更名。' }]
  const references = createDraftRepairReferences(sources, identity)
  const documents = frozenDocs(references.prompt('完整原任务'))
  const parts = documents[0].parts.filter(Array.isArray)
  assert.equal(parts.length, 3); assert.notEqual(parts[0][0], parts[1][0])
  for (let index = 0; index < parts.length; index++) {
    const edit = references.editSchema.parse({ operation: 'replace_ref', source_key: 'world', ref_id: parts[index][0], ...proposal })
    assert.ok('paragraph_id' in edit); assert.equal('find' in edit, false)
    assert.deepEqual(references.editSchema.parse(edit), edit, 'canonical cache parses again without conversion to a quotation')
    const resolved = references.resolveEdits('world', [edit])
    assert.equal(resolved[0]!.find, parts[index][1], 'backend retrieves the exact trusted text only after position resolution')
    assert.equal(resolved[0]!.start, documentParagraphs(content, references.locatorVersion('world'))[index]!.start)
  }
  assert.ok(!references.editSchema.safeParse({ operation: 'replace_ref', source_key: 'constraints', ref_id: parts[0][0], ...proposal }).success)
  assert.throws(() => references.resolveEdits('world', [{ source_key: 'constraints', find: '长原文', ...proposal }]), problem('source_mismatch'))
  const old = createDraftRepairReferences(sources, { ...identity, candidate_version: 'old' })
  assert.ok(!old.editSchema.safeParse({ operation: 'replace_ref', source_key: 'world', ref_id: parts[0][0], ...proposal }).success)
  const allText = documents[0].parts.map((part: string | [string,string]) => Array.isArray(part) ? part[1] : part).join('')
  assert.equal(allText, content)
})

test('legacy draft factory reconstructs the old prompt, references, input JSONSchema and canonical value exactly', () => {
  const sources = [{ key: 'world', title: '旧世界', content: '\n独段🦊。\n\n重复。\n\n重复。\n' }, { key: 'constraints', content: '禁止更名。' }]
  const legacy = createDraftRepairReferences(sources, identity, { legacy: true })
  const sha = (value: string) => createHash('sha256').update(value).digest('hex')
  // Captured independently from the unmodified historical factory, before the
  // position-based implementation. These guard old prompt/schema input hashes.
  assert.equal(sha(legacy.introduction), 'a5c97a603b71902bd7fddb464c43f5948cfb583888dd7802141ff2ff0e0e5659')
  assert.equal(sha(legacy.prompt('完整任务', 'front')), '3efdaf435a9e3ec4d76fff4df12dfc0660a8957a3e072df8d05e79520ac31de5')
  assert.equal(sha(legacy.prompt('完整任务', 'tail')), '2b8448658f223c60266b095d4825f945a8c48979d8bb14f29821487a71def333')
  assert.equal(sha(JSON.stringify(z.toJSONSchema(legacy.editSchema, { io: 'input', unrepresentable: 'any' }))), '6e31a0c925176763728ffc0610843ab11a220fdf264cf9fc5c15f26bfe030013')
  const parts = frozenDocs(legacy.prompt('完整任务'))[0].parts.filter(Array.isArray)
  assert.equal(parts.length, 1, 'old prompt still omits repeated paragraph references')
  const wire = { operation: 'replace_ref', source_key: 'world', ref_id: parts[0][0], ...proposal }
  assert.deepEqual(legacy.editSchema.parse(wire), { source_key: 'world', find: '独段🦊。', ...proposal })
  assert.ok('find' in legacy.editSchema.parse(wire))
})
