import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addReference, readReferences, referenceMessages, type DirectorReference } from '../src/features/script/director-references'
import { scriptArtifactLabels, scriptStageArtifacts } from '@video-studio/shared/script/script-stage-content'

const document: DirectorReference = { key: 'outline:0', title: '故事大纲', artifact_type: 'outline', episode_number: 0, content: '前半段'.repeat(2000) + '重要结尾' }

test('all design subdocuments retain their type, title and full body in reference snapshots', () => {
  for (const type of [...scriptStageArtifacts.locations, ...scriptStageArtifacts.props]) {
    const reference = { ...document, key: `${type}:0`, artifact_type: type, title: scriptArtifactLabels[type] }
    assert.deepEqual(readReferences(JSON.parse(JSON.stringify(addReference([], reference)))), [reference])
  }
})

test('references preserve full content separately from the typed question and replace duplicate documents', () => {
  const refs = addReference([], document)
  const updated = addReference(refs, { ...document, content: '修改后的正文' })
  assert.equal(updated.length, 1)
  assert.equal(updated[0]!.content, '修改后的正文')
  const messages = referenceMessages([{ role: 'user' as const, text: '请修改结尾', reference_documents: refs }])
  assert.equal(messages[0]!.text, '请修改结尾')
  assert.equal(messages[0]!.reference_documents?.[0]!.content, document.content)
  assert.deepEqual(readReferences(JSON.parse(JSON.stringify(refs))), refs)
})

test('context deduplicates identical snapshots without mutating historical messages', () => {
  const history = [{ role: 'user' as const, text: '初稿分析', reference_documents: [document] }, { role: 'user' as const, text: '调整对白', reference_documents: [document] }]
  const context = referenceMessages(history)
  assert.equal(context[0]!.reference_documents, undefined)
  assert.equal(context[1]!.reference_documents?.[0]!.content, document.content)
  assert.equal(history[0]!.reference_documents.length, 1)
})

test('invalid or oversized references fail explicitly rather than silently truncating', () => {
  assert.deepEqual(readReferences([{ ...document, content: null }]), [])
  assert.throws(() => addReference([], { ...document, content: 'x'.repeat(100001) }), /长度限制/)
  const four = [0, 1, 2, 3].map(index => ({ ...document, key: `doc${index}` }))
  assert.throws(() => addReference(four, { ...document, key: 'fifth' }), /最多引用/)
  assert.throws(() => addReference([], { ...document, content: '中'.repeat(100000) }), /300 KB/)
})

test('bounded history retains all current references without cutting their bodies', () => {
  const large = { ...document, content: 'x'.repeat(90000) }
  const history = Array.from({ length: 9 }, (_, index) => ({ role: 'user' as const, text: `问题${index}`, reference_documents: [{ ...large, key: `doc${index}` }] }))
  const context = referenceMessages(history)
  assert.equal(context.at(-1)!.reference_documents?.[0]!.content, large.content)
  assert.ok(context.filter(message => message.reference_documents?.length).length < history.length)
})
