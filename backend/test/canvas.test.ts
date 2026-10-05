import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const testData = await mkdtemp(join(tmpdir(), 'video-studio-canvas-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { buildApp } = await import('../src/server.js')
const { db, initDb, now, one, run } = await import('../src/db.js')
const app = buildApp()

after(async () => {
  await app.close()
  db.close()
  await rm(testData, { recursive: true, force: true })
})

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json() as T
}

const emptyCanvas = { nodes: [], edges: [] }
type CanvasSnapshot = { nodes: Array<Record<string, unknown>>; edges: Array<{ id: string; source: string; target: string }>; revision: string }

async function getCanvas(projectId: string): Promise<CanvasSnapshot> {
  return call<CanvasSnapshot>('GET', `/api/projects/${projectId}/canvas`)
}

async function putCanvas(projectId: string, graph: { nodes: unknown[]; edges: unknown[] }, revision: string): Promise<CanvasSnapshot> {
  return call<CanvasSnapshot>('PUT', `/api/projects/${projectId}/canvas`, { ...graph, revision })
}

test('canvas survives reinitialization, preserves order, and repeated PUT is idempotent', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '画布项目' })
  const other = await call<{ id: string }>('POST', '/api/projects', { name: '另一个项目' })
  const shot = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '桥上' })
  const initial = await getCanvas(project.id)
  assert.deepEqual({ nodes: initial.nodes, edges: initial.edges }, emptyCanvas)
  assert.match(initial.revision, /^[a-f0-9]{64}$/)

  const stamp = now()
  run(`INSERT INTO providers (id, name, adapter, base_url, created_at) VALUES (?, ?, 'http', ?, ?)`,
    'canvas-provider', '测试提供商', 'https://example.test', stamp)
  run(`INSERT INTO models (id, provider_id, name, remote_id, modality) VALUES (?, ?, ?, ?, 'video')`,
    'canvas-model', 'canvas-provider', '视频模型', 'video-model')
  run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, created_at)
    VALUES (?, ?, ?, 'image', 'reference.png', '/missing/reference.png', 'upload', ?)`,
    'canvas-image', project.id, shot.id, stamp)
  run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, created_at)
    VALUES (?, ?, ?, 'video', 'candidate.mp4', '/missing/candidate.mp4', 'generated', ?)`,
    'canvas-video', project.id, shot.id, stamp)
  run(`INSERT INTO jobs (id, project_id, shot_id, model_id, job_type, request, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'generation', '{}', 'succeeded', ?, ?)`,
    'canvas-job', project.id, shot.id, 'canvas-model', stamp, stamp)

  const canvas = {
    nodes: [
      { id: 'note', type: 'text', x: -60, y: 80, width: 240, height: 180, title: '视觉设定', text: '雨夜的桥' },
      { id: 'reference', type: 'image', x: 240, y: 20, width: 260, height: 220, asset_id: 'canvas-image' },
      { id: 'generator', type: 'generation', x: 620, y: 70, width: 320, height: 260,
        shot_id: shot.id, model_id: 'canvas-model', job_id: 'canvas-job', prompt: '雨夜桥上的追逐',
        text: '桥下闪电照亮追逐者的脸',
        settings: { modality: 'video', mode: 'first_frame', duration: 5, ratio: '16:9', generate_audio: true, candidate_count: 4, prompt_override: true,
          group_id: shot.id, group_title: '镜头 01 · 雨夜桥上的追逐' } },
      { id: 'result', type: 'video', x: 1020, y: 60, width: 280, height: 240, asset_id: 'canvas-video' },
    ],
    edges: [
      { id: 'edge-b', source: 'reference', target: 'generator' },
      { id: 'edge-a', source: 'note', target: 'generator' },
      { id: 'edge-c', source: 'generator', target: 'result' },
    ],
  }
  const saved = await putCanvas(project.id, canvas, initial.revision)
  assert.deepEqual(saved.nodes.map(node => node.id), canvas.nodes.map(node => node.id))
  assert.deepEqual(saved.edges, canvas.edges)
  assert.deepEqual(saved.nodes[0], { ...canvas.nodes[0], asset_id: null, shot_id: null,
    model_id: null, job_id: null, prompt: '', settings: {} })
  assert.deepEqual(saved.nodes[2]?.settings, canvas.nodes[2]?.settings)
  assert.equal(saved.nodes[2]?.text, canvas.nodes[2]?.text)
  assert.notEqual(saved.revision, initial.revision)
  assert.deepEqual(await getCanvas(project.id), saved)

  initDb()
  assert.deepEqual(await getCanvas(project.id), saved)
  run('UPDATE projects SET updated_at=? WHERE id=?', '2000-01-01T00:00:00.000Z', project.id)
  assert.deepEqual(await putCanvas(project.id, canvas, initial.revision), saved)
  assert.equal(one<{ updated_at: string }>('SELECT updated_at FROM projects WHERE id=?', project.id)?.updated_at,
    '2000-01-01T00:00:00.000Z')

  const otherCanvas = { nodes: [{ id: 'note', type: 'text', x: 0, y: 0, width: 200, height: 140, text: '另一个项目' }], edges: [] }
  await putCanvas(other.id, otherCanvas, (await getCanvas(other.id)).revision)
  assert.deepEqual(await getCanvas(project.id), saved)
  assert.equal((await getCanvas(other.id)).nodes[0]?.text, '另一个项目')
})

test('canvas rejects invalid references and connections without changing the saved graph', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '校验项目' })
  const other = await call<{ id: string }>('POST', '/api/projects', { name: '外部项目' })
  const localShot = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '本项目镜头' })
  const anotherLocalShot = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '另一镜头' })
  const foreignShot = await call<{ id: string }>('POST', `/api/projects/${other.id}/shots`, { title: '外部镜头' })
  const stamp = now()
  run(`INSERT INTO assets (id, project_id, kind, filename, path, source, created_at)
    VALUES (?, ?, 'video', 'local.mp4', '/missing/local.mp4', 'upload', ?)`,
    'local-canvas-video', project.id, stamp)
  run(`INSERT INTO assets (id, project_id, kind, filename, path, source, created_at)
    VALUES (?, ?, 'image', 'foreign.png', '/missing/foreign.png', 'upload', ?)`,
    'foreign-canvas-image', other.id, stamp)
  run(`INSERT INTO jobs (id, project_id, shot_id, job_type, request, status, created_at, updated_at)
    VALUES (?, ?, ?, 'generation', '{}', 'succeeded', ?, ?)`,
    'local-canvas-job', project.id, localShot.id, stamp, stamp)
  run(`INSERT INTO jobs (id, project_id, shot_id, job_type, request, status, created_at, updated_at)
    VALUES (?, ?, ?, 'generation', '{}', 'succeeded', ?, ?)`,
    'foreign-canvas-job', other.id, foreignShot.id, stamp, stamp)
  const base = { nodes: [{ id: 'n1', type: 'text', x: 10, y: 20, width: 200, height: 140, text: '保留' }], edges: [] }
  const saved = await putCanvas(project.id, base, (await getCanvas(project.id)).revision)
  const node = { id: 'n2', type: 'image', x: 0, y: 0, width: 200, height: 140 }
  const invalidCanvases = [
    { nodes: [base.nodes[0], { ...node, asset_id: 'foreign-canvas-image' }], edges: [] },
    { nodes: [base.nodes[0], { ...node, asset_id: 'missing-asset' }], edges: [] },
    { nodes: [base.nodes[0], { ...node, asset_id: 'local-canvas-video' }], edges: [] },
    { nodes: [base.nodes[0], { ...node, shot_id: foreignShot.id }], edges: [] },
    { nodes: [base.nodes[0], { ...node, job_id: 'foreign-canvas-job' }], edges: [] },
    { nodes: [base.nodes[0], { ...node, shot_id: anotherLocalShot.id, job_id: 'local-canvas-job' }], edges: [] },
    { nodes: [base.nodes[0], base.nodes[0]], edges: [] },
    { nodes: [base.nodes[0]], edges: [{ id: 'bad', source: 'n1', target: 'missing' }] },
    { nodes: [base.nodes[0]], edges: [{ id: 'bad', source: 'n1', target: 'n1' }] },
    { nodes: [base.nodes[0], node], edges: [
      { id: 'e1', source: 'n1', target: 'n2' }, { id: 'e2', source: 'n1', target: 'n2' },
    ] },
    { nodes: [{ ...base.nodes[0], x: Number.POSITIVE_INFINITY }], edges: [] },
    ...[0, 1.5, 5].map(candidate_count => ({ nodes: [{ ...base.nodes[0], settings: { candidate_count } }], edges: [] })),
  ]
  for (const invalid of invalidCanvases) {
    const response = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/canvas`, payload: { ...invalid, revision: saved.revision } })
    assert.equal(response.statusCode, 422, response.body)
    assert.deepEqual(await getCanvas(project.id), saved)
  }

  await call('DELETE', `/api/projects/${project.id}`)
  assert.equal(one('SELECT 1 FROM canvas_nodes WHERE project_id=?', project.id), undefined)
  assert.equal((await app.inject({ method: 'GET', url: `/api/projects/${project.id}/canvas` })).statusCode, 404)
})

test('canvas preserves the editable script node role and content', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '剧本节点项目' })
  const initial = await getCanvas(project.id)
  const graph = {
    nodes: [{ id: 'script', type: 'text', x: 0, y: 0, width: 320, height: 320,
      title: '剧本节点', text: '故事大纲\n雨夜的桥', settings: { role: 'script' } }],
    edges: [],
  }
  const saved = await putCanvas(project.id, graph, initial.revision)
  assert.deepEqual(saved.nodes[0]?.settings, { role: 'script' })
  assert.equal(saved.nodes[0]?.text, graph.nodes[0].text)
})

test('canvas persists text node creation mode', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '文本节点模式' })
  const initial = await getCanvas(project.id)
  const graph = {
    nodes: [
      { id: 'write', type: 'text', x: 0, y: 0, width: 420, height: 340,
        title: '文本节点', text: '', settings: { text_mode: 'write' } },
      { id: 'video', type: 'text', x: 520, y: 0, width: 420, height: 340,
        title: '文本节点', text: '港口雨夜追逐', settings: { text_mode: 'video' } },
      { id: 'generator', type: 'generation', x: 1040, y: 0, width: 440, height: 420,
        title: '视频生成', text: '', prompt: '', settings: { modality: 'video', mode: 'text' } },
    ],
    edges: [{ id: 'edge', source: 'video', target: 'generator' }],
  }
  const saved = await putCanvas(project.id, graph, initial.revision)
  assert.deepEqual(saved.nodes.map(node => (node.settings as { text_mode?: string }).text_mode), ['write', 'video', undefined])
  assert.deepEqual(saved.edges, graph.edges)
  assert.deepEqual(await getCanvas(project.id), saved)
})

test('canvas persists a project script reference node', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '项目剧本卡片' })
  const initial = await getCanvas(project.id)
  const graph = {
    nodes: [
      { id: 'script-ref', type: 'project_script_ref', x: 120, y: 80, width: 360, height: 240,
        title: '项目剧本', text: '', settings: {} },
      { id: 'shot-note', type: 'text', x: 600, y: 80, width: 300, height: 200,
        title: '镜头备注', text: '桥下传来脚步声' },
    ],
    edges: [{ id: 'script-to-note', source: 'script-ref', target: 'shot-note' }],
  }

  const saved = await putCanvas(project.id, graph, initial.revision)
  assert.deepEqual(saved.nodes.map(node => node.type), ['project_script_ref', 'text'])
  assert.deepEqual(saved.edges, graph.edges)
  initDb()
  assert.deepEqual(await getCanvas(project.id), saved)
})

test('canvas accepts persisted image generation controls', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '图片参数画布' })
  const initial = await getCanvas(project.id)
  const node = { id: 'image-generation', type: 'generation', x: 0, y: 0, width: 440, height: 420,
    title: '图片生成', text: '', settings: {
      modality: 'image', resolution: '1K', clarity: '高清', quality: '精细', background: '透明',
    } }
  const saved = await putCanvas(project.id, { nodes: [node], edges: [] }, initial.revision)
  assert.deepEqual(saved.nodes[0]?.settings, node.settings)
})

test('canvas preserves safe rich text documents and remains compatible with plain text nodes', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '富文本节点' })
  const document = {
    type: 'doc', content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '雨夜追逐' }] },
      { type: 'heading', attrs: { level: 2 } },
      { type: 'heading', attrs: { level: 3 }, content: [] },
      { type: 'paragraph', content: [
        { type: 'text', text: '闪电', marks: [{ type: 'bold' }, { type: 'italic' }] },
        { type: 'hardBreak', marks: [{ type: 'bold' }] }, { type: 'text', text: '照亮石桥' },
      ] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [
        { type: 'paragraph', content: [{ type: 'text', text: '主角跳上桥面' }] },
        { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
      ] }] },
      { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [] }] }] },
      { type: 'horizontalRule' }, { type: 'paragraph' },
    ],
  }
  const richNode = { id: 'rich', type: 'text', x: 0, y: 0, width: 420, height: 340,
    text: '雨夜追逐\n闪电\n照亮石桥\n主角跳上桥面', settings: { text_mode: 'write', text_document: document } }
  const legacyNode = { id: 'legacy', type: 'text', x: 520, y: 0, width: 420, height: 340, text: '旧纯文本' }
  const saved = await putCanvas(project.id, { nodes: [richNode, legacyNode], edges: [] }, (await getCanvas(project.id)).revision)
  assert.deepEqual(saved.nodes[0]?.settings, richNode.settings)
  assert.equal(saved.nodes[0]?.text, richNode.text)
  assert.deepEqual(saved.nodes[1]?.settings, {})
  initDb()
  assert.deepEqual(await getCanvas(project.id), saved)
  const cleared = await putCanvas(project.id, { nodes: [
    { ...richNode, settings: { text_mode: 'write', text_document: null } }, legacyNode,
  ], edges: [] }, saved.revision)
  assert.deepEqual(cleared.nodes[0]?.settings, { text_mode: 'write', text_document: null })
  assert.equal(cleared.nodes[0]?.text, richNode.text)
})

test('canvas rejects unknown rich text nodes, HTML attributes, marks and invalid nesting without changing the graph', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '富文本校验' })
  const node = { id: 'note', type: 'text', x: 0, y: 0, width: 420, height: 340, text: '保留原文' }
  const saved = await putCanvas(project.id, { nodes: [node], edges: [] }, (await getCanvas(project.id)).revision)
  const invalidDocuments = [
    { type: 'paragraph' },
    { type: 'doc', attrs: { onclick: 'alert(1)' } },
    { type: 'doc', content: [{ type: 'script', text: 'alert(1)' }] },
    { type: 'doc', content: [{ type: 'paragraph', attrs: { style: 'color:red' } }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'foo', attrs: { class: 'html' } }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'foo', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'foo', marks: [{ type: 'bold', attrs: { onclick: 'alert(1)' } }] }] }] },
    { type: 'doc', content: [{ type: 'heading', attrs: { level: 4 } }] },
    { type: 'doc', content: [{ type: 'heading', attrs: { level: 1, style: 'color:red' } }] },
    { type: 'doc', content: [{ type: 'orderedList', attrs: { start: 0 }, content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }] },
    { type: 'doc', content: [{ type: 'orderedList', attrs: { start: 1, type: 'a' }, content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }] },
    { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'text', text: 'invalid list' }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'heading', attrs: { level: 1 } }] }] },
    { type: 'doc', content: [{ type: 'text', text: 'block must wrap text' }] },
  ]
  for (const text_document of invalidDocuments) {
    const response = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/canvas`, payload: {
      revision: saved.revision, edges: [], nodes: [{ ...node, settings: { text_document } }],
    } })
    assert.equal(response.statusCode, 422, response.body)
    assert.deepEqual(await getCanvas(project.id), saved)
  }
})

test('canvas bounds rich text size and depth while accepting the existing text character limit', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '富文本边界' })
  const node = { id: 'note', type: 'text', x: 0, y: 0, width: 420, height: 340, text: '文'.repeat(20_000) }
  const document = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: node.text }] }] }
  const saved = await putCanvas(project.id, { nodes: [{ ...node, settings: { text_document: document } }], edges: [] }, (await getCanvas(project.id)).revision)
  assert.deepEqual((saved.nodes[0]?.settings as { text_document: unknown }).text_document, document)
  let nested: unknown = { type: 'paragraph' }
  for (let index = 0; index < 8; index += 1) {
    nested = { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }, nested] }] }
  }
  const invalidDocuments = [
    { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: '文'.repeat(10_001) }, { type: 'text', text: '文'.repeat(10_000) },
    ] }] },
    { type: 'doc', content: Array.from({ length: 2_000 }, () => ({ type: 'paragraph' })) },
    { type: 'doc', content: [nested] },
  ]
  for (const text_document of invalidDocuments) {
    const response = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/canvas`, payload: {
      revision: saved.revision, edges: [], nodes: [{ ...node, settings: { text_document } }],
    } })
    assert.equal(response.statusCode, 422, response.body)
    assert.deepEqual(await getCanvas(project.id), saved)
  }
})

test('stale snapshots cannot overwrite edits, while identical retries remain idempotent', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '并发画布' })
  const initial = await getCanvas(project.id)
  const first = { nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 200, height: 140, text: '第一处编辑' }], edges: [] }
  const second = { nodes: [{ id: 'b', type: 'text', x: 0, y: 0, width: 200, height: 140, text: '另一处编辑' }], edges: [] }
  const saved = await putCanvas(project.id, first, initial.revision)
  const conflict = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/canvas`,
    payload: { ...second, revision: initial.revision } })
  assert.equal(conflict.statusCode, 409, conflict.body)
  assert.deepEqual(await getCanvas(project.id), saved)
  assert.deepEqual(await putCanvas(project.id, first, initial.revision), saved)
  assert.equal((await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/canvas`, payload: second })).statusCode, 422)
  assert.deepEqual(await getCanvas(project.id), saved)
})

test('deleted asset and shot clear references without removing canvas nodes or edges', async () => {
  const project = await call<{ id: string }>('POST', '/api/projects', { name: '引用删除' })
  const shot = await call<{ id: string }>('POST', `/api/projects/${project.id}/shots`, { title: '待删镜头' })
  const stamp = now()
  run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, created_at)
    VALUES (?, ?, ?, 'image', 'image.png', '/missing/image.png', 'upload', ?)`,
    'deletable-canvas-asset', project.id, shot.id, stamp)
  run(`INSERT INTO jobs (id, project_id, shot_id, job_type, request, status, created_at, updated_at)
    VALUES (?, ?, ?, 'generation', '{}', 'succeeded', ?, ?)`,
    'deletable-canvas-job', project.id, shot.id, stamp, stamp)
  const graph = { nodes: [
    { id: 'asset', type: 'image', x: 0, y: 0, width: 200, height: 140, asset_id: 'deletable-canvas-asset', shot_id: shot.id },
    { id: 'job', type: 'generation', x: 260, y: 0, width: 280, height: 200, shot_id: shot.id, job_id: 'deletable-canvas-job' },
  ], edges: [{ id: 'flow', source: 'asset', target: 'job' }] }
  const saved = await putCanvas(project.id, graph, (await getCanvas(project.id)).revision)
  run('DELETE FROM assets WHERE id=?', 'deletable-canvas-asset')
  const withoutAsset = await getCanvas(project.id)
  assert.equal(withoutAsset.nodes[0]?.asset_id, null)
  assert.equal(withoutAsset.nodes.length, 2)
  assert.deepEqual(withoutAsset.edges, saved.edges)
  assert.notEqual(withoutAsset.revision, saved.revision)
  const stale = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}/canvas`,
    payload: { ...graph, revision: saved.revision } })
  assert.equal(stale.statusCode, 409, stale.body)

  await call('DELETE', `/api/shots/${shot.id}`)
  const withoutShot = await getCanvas(project.id)
  assert.equal(withoutShot.nodes[0]?.shot_id, null)
  assert.equal(withoutShot.nodes[1]?.shot_id, null)
  assert.equal(withoutShot.nodes[1]?.job_id, 'deletable-canvas-job')
  assert.deepEqual(withoutShot.edges, saved.edges)
  assert.notEqual(withoutShot.revision, withoutAsset.revision)
  assert.deepEqual(await getCanvas(project.id), withoutShot)
})
