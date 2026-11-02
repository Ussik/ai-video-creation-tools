import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { serializePromptSectionDocument, type PromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'

const directory = await mkdtemp(join(tmpdir(), 'studio-canvas-prompt-sections-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, initDb, all } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
const section = (content: string) => `【镜头视觉设定】\n${content}\n【镜头视觉设定结束】`
function document(): PromptSectionDocument {
  return { version: 1, blocks: [
    { id: 'body-1', kind: 'body', text: '保留本节点的动作。\n\n' },
    { id: 'managed-1', kind: 'managed', name: '镜头视觉设定', text: section('本节点红衣设定'),
      sourceText: section('原项目蓝衣设定'), pendingSourceText: section('新项目绿衣设定'),
      mergeBaseText: section('原项目蓝衣设定\n场景：已同步的新站台'), sourceStatus: 'source_changed' },
    { id: 'managed-2', kind: 'managed', name: '项目画风约束', text: '', deleted: true,
      sourceText: '【项目画风约束】\n本节点已主动移除的旧画风\n【项目画风约束结束】' },
    { id: 'managed-3', kind: 'managed', name: '图片参考图用途', text: '', deleted: true, deletionSource: 'source', sourceText: '' },
  ] }
}
function node(id: string, sections: PromptSectionDocument) {
  return { id, type: 'generation', x: 0, y: 0, width: 320, height: 240,
    text: serializePromptSectionDocument(sections), settings: { modality: 'image', prompt_is_final: true, prompt_document: true, prompt_sections: sections } }
}

test('default and named canvas routes persist complete prompt sections, source snapshots, pending choices and tombstones through reload', async () => {
  const project = await call('POST', '/api/projects', { name: '提示词结构持久化' })
  const canvas = await call('POST', `/api/projects/${project.id}/canvases`, { name: '独立方案' })
  for (const [suffix, id] of [['canvas', 'default-prompt'], [`canvases/${canvas.id}`, 'named-prompt']]) {
    const url = `/api/projects/${project.id}/${suffix}`
    const initial = await call('GET', url), sections = document()
    const saved = await call('PUT', url, { ...initial, nodes: [node(id!, sections)] })
    assert.deepEqual(saved.nodes[0].settings.prompt_sections, sections)
    assert.equal(saved.nodes[0].text, serializePromptSectionDocument(sections))
    assert.deepEqual(await call('GET', url), saved)
    initDb()
    assert.deepEqual(await call('GET', url), saved)
    assert.deepEqual(await call('PUT', url, saved), saved, 'unchanged persisted documents remain idempotent')
  }
  assert.equal(all('SELECT * FROM jobs').length, 0)
})

test('invalid or oversized section documents fail without replacing the saved graph', async () => {
  const project = await call('POST', '/api/projects', { name: '结构文档验证' })
  const url = `/api/projects/${project.id}/canvas`, initial = await call('GET', url)
  const saved = await call('PUT', url, { ...initial, nodes: [node('kept', document())] })
  const body = { id: 'body', kind: 'body', text: '' }
  const invalid = [
    { version: 2, blocks: [] },
    { version: 1, blocks: [body, body] },
    { version: 1, blocks: [{ ...body, id: 'bad', kind: 'unknown' }] },
    { version: 1, blocks: [{ id: 'broken', kind: 'managed', name: '镜头视觉设定', text: '【镜头视觉设定】缺失结束标记' }] },
    { version: 1, blocks: [{ id: 'broken', kind: 'managed', name: '镜头视觉设定', text: section('保留'), deleted: true }] },
    { version: 1, blocks: Array.from({ length: 1_001 }, (_, index) => ({ ...body, id: `body-${index}` })) },
    { version: 1, blocks: [{ ...body, text: 'x'.repeat(80_001) }] },
    ...(['text', 'sourceText', 'pendingSourceText', 'mergeBaseText'] as const).map(field => ({ version: 1, blocks: [
      { ...body, id: 'first', [field]: 'x'.repeat(40_001) }, { ...body, id: 'second', [field]: 'x'.repeat(40_001) },
    ] })),
  ]
  for (const sections of invalid) {
    const response = await app.inject({ method: 'PUT', url, payload: { ...saved,
      nodes: [{ ...saved.nodes[0], settings: { ...saved.nodes[0].settings, prompt_sections: sections } }],
    } })
    assert.equal(response.statusCode, 422, response.body)
    assert.deepEqual(await call('GET', url), saved)
  }
})

function imageVideoHandoff() {
  return { source_node_id: 'image-source', source_asset_id: 'chosen-frame', source_signature: 'source-snapshot',
    applied_signature: 'video-snapshot', inherited_reference_asset_ids: ['new-character', 'location-detail'] }
}

test('default and named canvases retain image to video handoff snapshots across save and reload', async () => {
  const project = await call('POST', '/api/projects', { name: '图片到视频承接持久化' })
  const canvas = await call('POST', `/api/projects/${project.id}/canvases`, { name: '视频方案' })
  for (const [index, suffix] of ['canvas', `canvases/${canvas.id}`].entries()) {
    const url = `/api/projects/${project.id}/${suffix}`, initial = await call('GET', url)
    const handoff = imageVideoHandoff(), video = node(`video-handoff-${index}`, document())
    const saved = await call('PUT', url, { ...initial, nodes: [{ ...video,
      settings: { ...video.settings, modality: 'video', image_video_handoff: handoff },
    }] })
    assert.deepEqual(saved.nodes[0].settings.image_video_handoff, handoff)
    assert.deepEqual(await call('GET', url), saved)
    initDb()
    assert.deepEqual(await call('GET', url), saved)
    assert.deepEqual(await call('PUT', url, saved), saved, 'handoff provenance survives idempotent resaves')

    const { inherited_reference_asset_ids: _references, ...withoutReferences } = handoff
    const noReferences = await call('PUT', url, { ...saved, nodes: [{ ...saved.nodes[0],
      settings: { ...saved.nodes[0].settings, image_video_handoff: withoutReferences },
    }] })
    assert.deepEqual(noReferences.nodes[0].settings.image_video_handoff, withoutReferences)
    assert.deepEqual(await call('GET', url), noReferences)
  }
  assert.equal(all('SELECT * FROM jobs').length, 0)
})

test('malformed handoff metadata rejects both canvas routes without replacing the saved graph', async () => {
  const project = await call('POST', '/api/projects', { name: '图片到视频承接验证' })
  const canvas = await call('POST', `/api/projects/${project.id}/canvases`, { name: '视频方案' })
  const handoff = imageVideoHandoff()
  const invalid = [null, [], 'snapshot', {},
    ...(['source_node_id', 'source_asset_id', 'source_signature', 'applied_signature'] as const).flatMap(field => [
      { ...handoff, [field]: undefined }, { ...handoff, [field]: null }, { ...handoff, [field]: 1 },
      { ...handoff, [field]: '' }, { ...handoff, [field]: 'x'.repeat(101) },
    ]),
    { ...handoff, inherited_reference_asset_ids: 'image' },
    { ...handoff, inherited_reference_asset_ids: null },
    { ...handoff, inherited_reference_asset_ids: [''] },
    { ...handoff, inherited_reference_asset_ids: [null] },
    { ...handoff, inherited_reference_asset_ids: ['x'.repeat(101)] },
    { ...handoff, inherited_reference_asset_ids: Array.from({ length: 101 }, (_, index) => `image-${index}`) },
    { ...handoff, extra: true },
  ]
  for (const [index, suffix] of ['canvas', `canvases/${canvas.id}`].entries()) {
    const url = `/api/projects/${project.id}/${suffix}`, initial = await call('GET', url)
    const video = node(`kept-video-${index}`, document())
    const saved = await call('PUT', url, { ...initial, nodes: [{ ...video,
      settings: { ...video.settings, modality: 'video', image_video_handoff: handoff },
    }] })
    for (const metadata of invalid) {
      const response = await app.inject({ method: 'PUT', url, payload: { ...saved, nodes: [{ ...saved.nodes[0],
        settings: { ...saved.nodes[0].settings, image_video_handoff: metadata },
      }] } })
      assert.equal(response.statusCode, 422, response.body)
      assert.deepEqual(await call('GET', url), saved)
    }
  }
})
