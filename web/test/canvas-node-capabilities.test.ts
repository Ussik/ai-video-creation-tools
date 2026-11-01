import assert from 'node:assert/strict'
import test from 'node:test'
import { createGenerationNodeCapabilities, generationNodeDirectorContext, type GenerationNodeState } from '../src/features/canvas/canvas-node-capabilities'

const state: GenerationNodeState = { projectId: 'project', canvasId: 'canvas', node: { id: 'node', title: '回望' },
  model: { id: 'model', name: '视频模型', modality: 'video' }, job: { id: 'job', status: 'succeeded' }, generating: false }
const reference = { assetId: 'fixed-asset', label: '角色侧面', kind: 'image', available: true, usage: 'character' }
const preview = { nodeId: 'node', candidateCount: 2, request: { model_id: 'model', shot_id: 'shot', prompt: '完整的实际提示词', mode: 'reference',
  reference_asset_ids: ['fixed-asset'], reference_video_url: null, resolution: '720p', ratio: '9:16', duration: 5, generate_audio: true, draft: false } }
const parse = (value: string) => JSON.parse(value.slice(value.indexOf('{')))

test('node capabilities freeze selected state and fixed references without exposing runtime configuration', async () => {
  const mutable = structuredClone(state)
  const capabilities = createGenerationNodeCapabilities({ state: { ...mutable, settings: { token: 'secret' } } as GenerationNodeState,
    references: [reference], isCurrent: () => true, preparePreview: async () => preview })
  mutable.node.title = 'later edit'
  assert.equal(capabilities.readState().node.title, '回望')
  assert.equal(capabilities.readReferences()[0].assetId, 'fixed-asset')
  assert.equal((capabilities.readState() as unknown as Record<string, unknown>).settings, undefined)
  assert.equal(await capabilities.preparePreview(), preview)
  const snapshot = parse(generationNodeDirectorContext(capabilities.readState(), capabilities.readReferences(), preview, '2026-10-28T00:00:00Z'))
  assert.equal(snapshot.prompt, preview.request.prompt)
  assert.deepEqual(snapshot.job, { id: 'job', status: 'succeeded' })
  assert.equal(snapshot.references[0].assetId, 'fixed-asset')
  assert.equal(snapshot.completeness, 'complete')
  assert.equal(snapshot.truncated, false)
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|settings/)
})

test('preview capability rejects a changed selection or input before and after asynchronous preparation', async () => {
  let current = true, calls = 0
  let release!: (value: typeof preview) => void
  const capabilities = createGenerationNodeCapabilities({ state, references: [reference], isCurrent: () => current,
    preparePreview: () => { calls++; return new Promise<typeof preview>(resolve => { release = resolve }) } })
  const pending = capabilities.preparePreview()
  current = false; release(preview)
  assert.equal(await pending, undefined)
  assert.equal(await capabilities.preparePreview(), undefined)
  assert.equal(calls, 1)
})

test('director snapshots report missing media and reject oversize prompts without silent truncation', () => {
  const missing = parse(generationNodeDirectorContext(state, [], { ...preview, request: { ...preview.request, reference_video_url: 'https://example.test/secret?signature=private' } }))
  assert.equal(missing.completeness, 'missing')
  assert.deepEqual(missing.missingReferenceAssetIds, ['fixed-asset'])
  assert.equal(missing.referenceVideo.locationOmitted, true)
  assert.doesNotMatch(JSON.stringify(missing), /signature=private/)
  assert.throws(() => generationNodeDirectorContext(state, [reference], { ...preview, request: { ...preview.request, prompt: 'a'.repeat(48000) } }), /尚未添加.*内容未截断/)
  assert.throws(() => generationNodeDirectorContext(state, [reference], { ...preview, nodeId: 'different' }), /节点或模型已变化/)
})

test('asset video references retain their fixed identity and report missing videos explicitly', () => {
  const request = { ...preview.request, mode: 'edit', reference_video_url: 'asset://video-source' }
  const present = parse(generationNodeDirectorContext(state, [reference, { ...reference, assetId: 'video-source', label: '原视频', kind: 'video' }], { ...preview, request }))
  assert.deepEqual(present.referenceVideo, { source: 'asset', assetId: 'video-source', available: true })
  assert.equal(present.completeness, 'complete')
  const missing = parse(generationNodeDirectorContext(state, [reference], { ...preview, request }))
  assert.equal(missing.completeness, 'missing')
  assert.deepEqual(missing.missingReferenceAssetIds, ['video-source'])
  assert.equal(missing.referenceVideo.available, false)
})
