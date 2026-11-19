import { readFile, stat } from 'node:fs/promises'
// Reuse exact source bytes only. Entries are bounded by encoded bytes; pending
// reads share a promise and never survive a failure or file identity change.
const limit = 64 * 1024 * 1024, entries = new Map<string, string>(), pending = new Map<string, Promise<string>>()
let bytes = 0
export async function referenceBase64(path: string): Promise<string> {
  const file = await stat(path), key = JSON.stringify([path, file.size, file.mtimeMs, file.ctimeMs, file.ino])
  const previous = entries.get(key)
  if (previous !== undefined) { entries.delete(key); entries.set(key, previous); return previous }
  const underway = pending.get(key)
  if (underway) return underway
  const reading = (async () => {
    const value = (await readFile(path)).toString('base64'), after = await stat(path)
    if (file.size !== after.size || file.mtimeMs !== after.mtimeMs || file.ctimeMs !== after.ctimeMs || file.ino !== after.ino) {
      throw new Error('参考图在读取时变化，请刷新后重新提交')
    }
    if (value.length <= limit) {
      while (entries.size && bytes + value.length > limit) { const first = entries.keys().next().value!; bytes -= entries.get(first)!.length; entries.delete(first) }
      entries.set(key, value); bytes += value.length
    }
    return value
  })()
  pending.set(key, reading)
  try { return await reading } finally { pending.delete(key) }
}
