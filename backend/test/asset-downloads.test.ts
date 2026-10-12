import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const testData = await mkdtemp(join(tmpdir(), 'video-studio-asset-download-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/app.js')
const { db, newId, now, run } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

async function project(name = '以命为薪') {
  const response = await app.inject({ method: 'POST', url: '/api/projects', payload: { name } })
  assert.equal(response.statusCode, 200)
  return response.json<{ id: string }>().id
}
async function asset(projectId: string, filename: string, content: Buffer, kind = 'video') {
  const id = newId(), path = join(testData, id)
  await writeFile(path, content)
  run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, model_id, prompt, remote_url, created_at)
    VALUES (?, ?, NULL, ?, ?, ?, 'generated', NULL, NULL, NULL, ?)`, id, projectId, kind, filename, path, now())
  return { id, path, content }
}
async function prepare(projectId: string, ids: string[]) {
  return app.inject({ method: 'POST', url: `/api/projects/${projectId}/asset-downloads`, payload: { asset_ids: ids } })
}
// Read the ZIP central directory independently of the archive writer; use
// the local header offset to verify each extracted file's exact bytes.
function zipEntries(buffer: Buffer) {
  const end = buffer.length - 22
  assert.equal(buffer.readUInt32LE(end), 0x06054b50)
  const count = buffer.readUInt16LE(end + 10), result = new Map<string, Buffer>()
  let position = buffer.readUInt32LE(end + 16)
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(position), 0x02014b50)
    assert.equal(buffer.readUInt16LE(position + 10), 0, 'media is stored without recompression')
    const size = buffer.readUInt32LE(position + 20), nameLength = buffer.readUInt16LE(position + 28)
    const name = buffer.toString('utf8', position + 46, position + 46 + nameLength)
    const local = buffer.readUInt32LE(position + 42)
    assert.equal(buffer.readUInt32LE(local), 0x04034b50)
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
    assert.ok(!result.has(name), `duplicate archive entry: ${name}`)
    result.set(name, buffer.subarray(start, start + size))
    position += 46 + nameLength + buffer.readUInt16LE(position + 30) + buffer.readUInt16LE(position + 32)
  }
  return result
}

test('eight selected videos download as one valid ZIP without overwriting duplicate filenames', async () => {
  const projectId = await project(), files = []
  for (let index = 0; index < 8; index++) files.push(await asset(projectId, index < 2 ? '镜头.mp4' : `镜头-${index}.mp4`, Buffer.alloc(130_000 + index, index)))
  const response = await prepare(projectId, [...files.map(file => file.id), files[0]!.id])
  assert.equal(response.statusCode, 200, response.body)
  const prepared = response.json<{ url: string; filename: string; count: number }>()
  assert.equal(prepared.count, 8)
  assert.equal(prepared.filename, '以命为薪-素材-8.zip')
  const download = await app.inject({ method: 'GET', url: prepared.url })
  assert.equal(download.statusCode, 200, download.body.slice(0, 100))
  assert.equal(download.headers['content-type'], 'application/zip')
  assert.match(String(download.headers['content-disposition']), /^attachment;/)
  assert.match(String(download.headers['content-disposition']), /filename\*=UTF-8''/)
  assert.equal(Number(download.headers['content-length']), download.rawPayload.length)
  const entries = zipEntries(download.rawPayload)
  assert.equal(entries.size, 8)
  assert.deepEqual(entries.get('镜头.mp4'), files[0]!.content)
  assert.deepEqual(entries.get('镜头 (2).mp4'), files[1]!.content)
  for (let index = 2; index < 8; index++) assert.deepEqual(entries.get(`镜头-${index}.mp4`), files[index]!.content)
})

test('one selected asset stays an original attachment and can be downloaded again', async () => {
  const projectId = await project(), file = await asset(projectId, '雨夜镜头.mp4', Buffer.from('original-video'))
  const response = await prepare(projectId, [file.id])
  assert.equal(response.statusCode, 200)
  const prepared = response.json<{ url: string; filename: string; count: number }>()
  assert.equal(prepared.count, 1)
  assert.equal(prepared.filename, '雨夜镜头.mp4')
  for (let index = 0; index < 2; index++) {
    const download = await app.inject({ method: 'GET', url: prepared.url })
    assert.equal(download.statusCode, 200)
    assert.deepEqual(download.rawPayload, file.content)
    assert.equal(download.headers['content-disposition'], `attachment; filename="asset.mp4"; filename*=UTF-8''${encodeURIComponent('雨夜镜头.mp4')}`)
  }
})

test('download preparation rejects empty, missing and foreign selections before creating a download', async () => {
  const projectId = await project(), other = await project('其他项目'), file = await asset(other, 'foreign.mp4', Buffer.from('foreign'))
  assert.equal((await prepare(projectId, [])).statusCode, 422)
  assert.equal((await prepare(projectId, ['missing'])).statusCode, 404)
  assert.equal((await prepare(projectId, [file.id])).statusCode, 404)
  assert.equal((await prepare('missing-project', [file.id])).statusCode, 404)
  const response = await prepare(other, [file.id]), prepared = response.json<{ url: string }>()
  assert.equal((await app.inject({ method: 'GET', url: prepared.url.replace(other, projectId) })).statusCode, 404)
})

test('missing files fail preparation and files removed afterwards cannot silently yield a partial archive', async () => {
  const projectId = await project(), first = await asset(projectId, '丢失.mp4', Buffer.from('lost')), second = await asset(projectId, '存在.mp4', Buffer.from('present'))
  const prepared = (await prepare(projectId, [first.id, second.id])).json<{ url: string }>()
  await rm(first.path)
  const failed = await prepare(projectId, [first.id, second.id])
  assert.equal(failed.statusCode, 404)
  assert.match(failed.json<{ detail: string }>().detail, /丢失\.mp4/)
  const download = await app.inject({ method: 'GET', url: prepared.url })
  assert.equal(download.statusCode, 404)
  assert.match(String(download.headers['content-type']), /application\/json/)
  assert.match(download.json<{ detail: string }>().detail, /丢失\.mp4/)
})

test('mixed media names are safe, unique across case-insensitive filesystems and preserve binary content', async () => {
  const projectId = await project(), files = await Promise.all([
    asset(projectId, '../View.PNG', Buffer.from([0, 255, 2]), 'image'),
    asset(projectId, 'view.png', Buffer.from([3, 4]), 'image'),
    asset(projectId, 'folder\\声音.wav', Buffer.from([5, 0, 6]), 'audio'),
    asset(projectId, '说明\r\n.txt', Buffer.from('对白：雨夜'), 'text'),
  ])
  const prepared = (await prepare(projectId, files.map(file => file.id))).json<{ url: string }>()
  const download = await app.inject({ method: 'GET', url: prepared.url }), entries = zipEntries(download.rawPayload)
  assert.deepEqual([...entries.keys()], ['View.PNG', 'view (2).png', '声音.wav', '说明__.txt'])
  assert.deepEqual([...entries.values()], files.map(file => file.content))
})

test('prepared download links expire and HEAD does not consume the download', async t => {
  const projectId = await project(), file = await asset(projectId, 'ready.mp4', Buffer.from('ready'))
  const prepared = (await prepare(projectId, [file.id])).json<{ url: string }>()
  const head = await app.inject({ method: 'HEAD', url: prepared.url })
  assert.equal(head.statusCode, 200)
  assert.equal(head.body, '')
  assert.equal((await app.inject({ method: 'GET', url: prepared.url })).statusCode, 200)
  const clock = Date.now() + 11 * 60_000
  t.mock.method(Date, 'now', () => clock)
  assert.equal((await app.inject({ method: 'GET', url: prepared.url })).statusCode, 404)
})
