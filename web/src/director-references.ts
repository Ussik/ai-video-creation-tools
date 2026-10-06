import type { ScriptArtifactType } from './api'

export type DirectorReference = { key: string; title: string; artifact_type: ScriptArtifactType; episode_number: number; content: string }
const types = new Set(['outline', 'synopsis', 'world', 'characters', 'relationships', 'locations', 'props', 'structure', 'hooks', 'foreshadowing', 'reversals', 'constraints', 'episode_outline', 'episode_script'])
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

export function readReferences(value: unknown): DirectorReference[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is DirectorReference => item && typeof item.key === 'string' && item.key.length > 0 && item.key.length <= 120
    && typeof item.title === 'string' && item.title.length > 0 && item.title.length <= 160
    && types.has(item.artifact_type) && Number.isInteger(item.episode_number) && item.episode_number >= 0 && item.episode_number <= 200
    && typeof item.content === 'string' && item.content.length > 0 && item.content.length <= 100000).slice(0, 4)
}

export function addReference(current: DirectorReference[], document: DirectorReference): DirectorReference[] {
  if (!readReferences([document]).length) throw new Error('该文档为空或超过引用长度限制')
  const next = [...current.filter(item => item.key !== document.key), document]
  if (next.length > 4) throw new Error('一次最多引用 4 份文档，请先移除一份')
  if (bytes(next) > 300000) throw new Error('引用文档超过 300 KB，请减少引用数量')
  return next
}

// Include each snapshot once, favoring the newest reference. Older snapshots
// can leave the bounded model context; the conversation history keeps them.
export function referenceMessages<T extends { role: 'user' | 'assistant'; text: string; reference_documents?: DirectorReference[] }>(messages: T[]) {
  const seen = new Map<string, Set<string>>()
  let size = 0
  const result = messages.map(message => ({ role: message.role, text: message.text, reference_documents: [] as DirectorReference[] }))
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role !== 'user') continue
    for (const document of readReferences(messages[i]!.reference_documents)) {
      const versions = seen.get(document.key) || new Set<string>()
      if (versions.has(document.content)) continue
      const documentSize = bytes(document)
      if (size + documentSize > 600000) continue
      size += documentSize
      versions.add(document.content)
      seen.set(document.key, versions)
      result[i]!.reference_documents.push(document)
    }
  }
  return result.map(message => message.reference_documents.length ? message : { role: message.role, text: message.text })
}
