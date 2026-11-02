import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scriptToolProfile } from '../src/modules/script/script-tool-profile.js'
import { scriptFunctions } from '../src/modules/script/script-document-tools.js'

const offered = (input: Parameters<typeof scriptToolProfile>[0]) => scriptFunctions.filter(tool => !scriptToolProfile(input).excluded.has(tool.name)).map(tool => tool.name)

test('each task kind gets a stable subset that keeps every tool it may legitimately call', () => {
  const full = offered({}), discussion = offered({ discussionOnly: true }), review = offered({ reviewOnly: true })
  assert.deepEqual(full, scriptFunctions.map(tool => tool.name))
  assert.deepEqual(offered({}), full, 'repeated selection serializes identically')
  for (const name of ['create_document_draft', 'propose_document_patch', 'commit_document_draft']) {
    assert.ok(full.includes(name)); assert.ok(!discussion.includes(name)); assert.ok(!review.includes(name))
  }
  for (const name of ['read_documents', 'read_source_document', 'search_source_document', 'get_creation_state', 'find_related_content', 'ask_creator', 'submit_document_review', 'load_creation_skills']) {
    assert.ok(discussion.includes(name), `discussion keeps ${name}`); assert.ok(review.includes(name), `review keeps ${name}`)
  }
  assert.ok(discussion.includes('record_story_decision') && !review.includes('record_story_decision'))
  assert.deepEqual(discussion, full.filter(name => discussion.includes(name)), 'declared order is preserved')
})
