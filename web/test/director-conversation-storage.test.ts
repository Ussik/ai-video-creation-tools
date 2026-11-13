import assert from 'node:assert/strict'
import test from 'node:test'
import { directorConversationStorageKey, releaseVerifiedDirectorConversationCache } from '../src/features/script/director-conversation-storage'

function storage(initial?: string) {
  let value: string | null = initial ?? null
  return {
    getItem: (_key: string) => value,
    setItem: (_key: string, next: string) => { value = next },
    removeItem: (_key: string) => { value = null },
  }
}

const message = { id: 'm1', role: 'user' as const, text: '保留的创作要求' }

test('releases a local fallback only after every cached conversation message is confirmed remotely', () => {
  const key = directorConversationStorageKey('project')
  const local = JSON.stringify({ messages: [message], history: [{ id: 'old', label: '旧对话', messages: [message] }] })
  const store = storage(local)
  const remote = [
    { id: 'current', label: '当前对话', messages: [message] },
    { id: 'old', label: '旧对话', messages: [message] },
  ]

  assert.equal(releaseVerifiedDirectorConversationCache('project', remote, store), true)
  assert.equal(store.getItem(key), null)
})

test('keeps the local fallback when a server message differs or history is missing', () => {
  const key = directorConversationStorageKey('project')
  const local = JSON.stringify({ messages: [message], history: [{ id: 'old', label: '旧对话', messages: [message] }] })
  const store = storage(local)

  assert.equal(releaseVerifiedDirectorConversationCache('project', [
    { id: 'current', label: '当前对话', messages: [{ ...message, text: '不同内容' }] },
    { id: 'old', label: '旧对话', messages: [message] },
  ], store), false)
  assert.equal(store.getItem(key), local)
  assert.equal(releaseVerifiedDirectorConversationCache('project', [
    { id: 'current', label: '当前对话', messages: [message] },
  ], store), false)
  assert.equal(store.getItem(key), local)
})

test('does not remove a newer local cache written after remote verification', () => {
  const key = directorConversationStorageKey('project')
  const original = JSON.stringify({ messages: [message], history: [] })
  let reads = 0
  const store = {
    getItem: () => ++reads === 1 ? original : `${original} `,
    removeItem: () => assert.fail('must not remove a changed cache'),
  }

  assert.equal(releaseVerifiedDirectorConversationCache('project', [{ id: 'current', label: '当前对话', messages: [message] }], store), false)
  assert.notEqual(store.getItem(key), original)
})
