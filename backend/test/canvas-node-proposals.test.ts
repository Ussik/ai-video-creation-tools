import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Fastify from 'fastify'
import { canvasNodeProposalFingerprint, canvasNodeProposalSourceKey, type CanvasNodeProposalSource } from '@video-studio/shared/canvas/canvas-node-proposal'
import { promptReferenceToken } from '@video-studio/shared/visuals/prompt-references'

const directory = await mkdtemp(join(tmpdir(), 'canvas-node-proposals-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, run, all, one } = await import('../src/infrastructure/database/db.js')
const { registerCanvasNodeProposalRoutes, canvasNodeProposalCapabilities } = await import('../src/modules/canvas/canvas-node-proposals.js')
const { projectVisualStyle } = await import('../src/modules/visuals/project-visual-style.js')
initDb()
run("INSERT INTO providers (id,name,adapter,base_url,key_ciphertext,created_at) VALUES ('provider','测试','http','https://private-provider.invalid','private-encrypted-key','now')")
const config = { ratios: ['16:9', '9:16', 'adaptive'], resolutions: ['720p', '1080p'], min_duration: 4, max_duration: 15,
  supported_modes: ['text', 'reference', 'first_frame', 'first_last_frame', 'edit', 'extend'],
  request_template: { model: '{{model}}', prompt: '{{prompt}}', ratio: '{{ratio}}', resolution: '{{resolution}}', duration: '{{duration}}', generate_audio: '{{generate_audio}}' } }
for (const [id, modality, protocol] of [['text', 'text', 'chat_completions'], ['video', 'video', 'async_video'], ['image', 'image', 'image_generations']]) {
  run('INSERT INTO models (id,provider_id,name,remote_id,modality,protocol,settings,enabled) VALUES (?,?,?,?,?,?,?,1)', id, 'provider', id, `private-remote-${id}`, modality, protocol, JSON.stringify(config))
}
let nextId = 0, calls = 0, captured = '', response: unknown = {}, duringGenerate: (() => void) | null = null
const graph = (projectId: string, canvasId: string) => {
  const nodes = all<any>('SELECT * FROM canvas_nodes WHERE project_id=? AND canvas_id=? ORDER BY position', projectId, canvasId)
    .map(({ project_id, canvas_id, position, settings, ...node }) => ({ ...node, settings: JSON.parse(settings) }))
  const edges = all<any>('SELECT * FROM canvas_edges WHERE project_id=? AND canvas_id=? ORDER BY position', projectId, canvasId)
    .map(({ project_id, canvas_id, position, reference_asset_id, ...edge }) => ({ ...edge, ...(reference_asset_id ? { reference_asset_id } : {}) }))
  return { nodes, edges, revision: createHash('sha256').update(JSON.stringify({ nodes, edges })).digest('hex') }
}
const app = Fastify()
app.setErrorHandler((error, _request, reply) => reply.code((error as any).statusCode || 422).send({ detail: String(error) }))
registerCanvasNodeProposalRoutes(app, { graph, generateText: async (projectId, modelId, prompt, contract, signal) => {
  calls++; captured = prompt
  assert.equal(modelId, 'text'); assert.equal(contract?.name, 'canvas_node_proposal'); assert.ok(signal)
  assert.ok(projectId.startsWith('project-'))
  duringGenerate?.()
  return JSON.stringify(response)
} })
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function fixture(modality: 'image' | 'video' = 'video') {
  const projectId = `project-${++nextId}`, canvasId = projectId, nodeId = `${projectId}-generator`, shotId = modality === 'video' ? `${projectId}-shot` : null
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', projectId, '方案测试', 'now', 'now')
  run('INSERT INTO project_canvases (id,project_id,name,position,is_default,created_at,updated_at) VALUES (?,?,?,0,1,?,?)', canvasId, projectId, '画布', 'now', 'now')
  if (shotId) run("INSERT INTO shots (id,project_id,position,title,prompt,duration,created_at) VALUES (?,?,0,'镜头','角色进场',5,'now')", shotId, projectId)
  const assets: string[] = []
  for (let index = 0; index < 2; index++) {
    const id = `${projectId}-asset-${index}`, path = join(directory, `${id}.png`)
    await writeFile(path, `temporary reference ${index}`)
    run("INSERT INTO assets (id,project_id,kind,filename,path,source,created_at) VALUES (?,?,'image',?,?,'upload','now')", id, projectId, `${index}.png`, path)
    assets.push(id)
    run("INSERT INTO canvas_nodes (id,project_id,canvas_id,position,type,x,y,width,height,title,text,asset_id,prompt,settings) VALUES (?,?,?,?,'image',0,0,200,200,'参考','',?,'','{}')", `${projectId}-image-${index}`, projectId, canvasId, index, id)
  }
  const nodeSettings = { modality, mode: 'reference', ratio: '16:9', resolution: '720p', duration: modality === 'video' ? 5 : 1,
    generate_audio: false, candidate_count: 1, prompt_is_final: true, prompt_document: true }
  run("INSERT INTO canvas_nodes (id,project_id,canvas_id,position,type,x,y,width,height,title,text,shot_id,model_id,prompt,settings) VALUES (?,?,?,2,'generation',500,0,300,300,'生成节点','',?,?,?,?)",
    nodeId, projectId, canvasId, shotId, modality, '原始角色进场提示词，保留图片1和图片2。', JSON.stringify(nodeSettings))
  for (let index = 0; index < assets.length; index++) run('INSERT INTO canvas_edges (id,project_id,canvas_id,position,source,target,reference_asset_id) VALUES (?,?,?,?,?,?,?)',
    `${projectId}-edge-${index}`, projectId, canvasId, index, `${projectId}-image-${index}`, nodeId, assets[index])
  const source = async (): Promise<CanvasNodeProposalSource> => {
    const current = graph(projectId, canvasId), node = current.nodes.find(value => value.id === nodeId)!, p = one<any>('SELECT * FROM projects WHERE id=?', projectId)
    return { project_id: projectId, project_updated_at: p.updated_at, project_style_version: projectVisualStyle(projectId).version,
      canvas_id: canvasId, canvas_revision: current.revision, source_node_id: nodeId, source_fingerprint: await canvasNodeProposalFingerprint(current, nodeId),
      model_id: modality, modality, mode: 'reference', prompt: node.prompt,
      parameters: { ratio: '16:9', resolution: '720p', duration: modality === 'video' ? 5 : 1, generate_audio: false, draft: false, clarity: null, quality: null, background: null, candidate_count: 1 },
      reference_assets: assets.map(asset_id => ({ asset_id, usage: modality === 'video' ? 'identity' : null })), reference_video_asset_id: null,
      shot_id: shotId, storyboard_revision: shotId ? 0 : null, storyboard_reference_asset_id: null }
  }
  const url = `/api/projects/${projectId}/canvases/${canvasId}/node-proposals`
  const request = async (overrides: any = {}) => app.inject({ method: 'POST', url, payload: { text_model_id: 'text', instructions: '让运镜更明确', source: await source(), ...overrides } })
  return { projectId, canvasId, nodeId, shotId, assets, source, url, request }
}
const snapshot = () => canvasNodeProposalSourceKey(Object.fromEntries(['projects', 'canvas_nodes', 'canvas_edges', 'project_canvases', 'assets', 'jobs', 'script_artifacts', 'shots'].map(table => [table, all(`SELECT * FROM ${table} ORDER BY rowid`)])))
const validResponse = () => ({ prompt: '角色进场，保留图片1和图片2，镜头缓慢向前跟随。', parameter_changes: {}, changes: ['明确镜头向前跟随'] })

test('proposal uses text-only structured execution, preserves the typed source and creates no canvas, task or artifact writes', async () => {
  const f = await fixture(), source = await f.source(), before = snapshot()
  response = { prompt: '角色进场，保留图片1和图片2。画面比例：9:16，时长：6秒，镜头跟随。', parameter_changes: { ratio: '9:16', resolution: '1080p', duration: 6, generate_audio: true }, changes: ['调整画幅、清晰度与时长，明确跟随'] }
  const result = await f.request({ source })
  assert.equal(result.statusCode, 200, result.body)
  const proposal = result.json()
  assert.deepEqual(proposal.source, source)
  assert.deepEqual(proposal.before, { prompt: source.prompt, parameters: source.parameters })
  assert.deepEqual(proposal.after.parameters, { ...source.parameters, ...((response as any).parameter_changes) })
  assert.ok(proposal.id && proposal.created_node_id && proposal.id !== proposal.created_node_id)
  assert.equal(proposal.validation_fingerprint.length, 64)
  assert.doesNotMatch(captured, /private-provider|private-encrypted-key|private-remote|request_template|key_ciphertext/)
  assert.match(captured, /未读取素材像素/)
  assert.equal(snapshot(), before)
  const previousCalls = calls
  const validation = await app.inject({ method: 'POST', url: `${f.url}/validate`, payload: { source, validation_fingerprint: proposal.validation_fingerprint } })
  assert.equal(validation.statusCode, 200, validation.body); assert.deepEqual(validation.json(), { valid: true })
  assert.equal(calls, previousCalls); assert.equal(snapshot(), before)
})

test('capabilities lock unconsumed parameters, native size mappings, fixed mode variables and draft overrides', async () => {
  const f = await fixture(), source = await f.source()
  assert.deepEqual(canvasNodeProposalCapabilities({}, source), { ratio: [], resolution: [], duration: null, generate_audio: false })
  const nativeSize = canvasNodeProposalCapabilities({ ...config, request_template: { size: '{{size}}' } }, source)
  assert.deepEqual(nativeSize.resolution, [])
  const locked = canvasNodeProposalCapabilities({ ...config, supports_draft: true, mode_variables: { reference: { ratio: 'adaptive', duration: -1, generate_audio: false } }, draft_variables: { resolution: '720p' } },
    { ...source, parameters: { ...source.parameters, draft: true } })
  assert.deepEqual(locked, { ratio: [], resolution: [], duration: null, generate_audio: false })
})

test('ordinary image sources work while video-only and unsupported fields cannot enter the proposed patch', async () => {
  const f = await fixture('image'), before = snapshot()
  response = validResponse()
  assert.equal((await f.request()).statusCode, 200)
  for (const invalid of [{ resolution: '1080p' }, { duration: 6 }, { generate_audio: true }, { mode: 'text' }, { reference_asset_ids: [] }, { model_id: 'text' }]) {
    const previousCalls = calls
    response = { ...validResponse(), parameter_changes: invalid }
    const result = await f.request()
    assert.equal(result.statusCode, 502, result.body)
    assert.equal(calls - previousCalls, 2, 'one bounded format correction')
  }
  assert.equal(snapshot(), before)
})

test('parameter/prompt conflicts get one correction and never silently alter the accepted prompt', async () => {
  const f = await fixture(), before = snapshot(), previousCalls = calls
  response = { prompt: '画面比例：16:9，角色进入房间。', parameter_changes: { ratio: '9:16' }, changes: ['调整画幅'] }
  const result = await f.request()
  assert.equal(result.statusCode, 502, result.body); assert.equal(calls - previousCalls, 2)
  assert.equal(snapshot(), before)
})

test('a proposed prompt cannot reconnect an image outside the fixed effective references', async () => {
  const f = await fixture(), before = snapshot(), previousCalls = calls
  response = { ...validResponse(), prompt: `角色进入房间，新增${promptReferenceToken('foreign-asset')}。` }
  const result = await f.request()
  assert.equal(result.statusCode, 502, result.body)
  assert.equal(calls - previousCalls, 2)
  assert.equal(snapshot(), before)
})

test('foreign, incomplete, stale and tampered sources fail before any text model call', async () => {
  const f = await fixture(), other = await fixture(), source = await f.source(), before = snapshot(), previousCalls = calls
  const changes: any[] = [
    { project_id: other.projectId }, { canvas_id: other.canvasId }, { canvas_revision: '0'.repeat(64) }, { source_fingerprint: '0'.repeat(64) },
    { project_updated_at: 'old' }, { project_style_version: '0'.repeat(64) }, { model_id: 'image' }, { mode: 'first_frame' },
    { parameters: { ...source.parameters, duration: 9 } }, { parameters: { ...source.parameters, ratio: '9:16' } },
    { reference_assets: [{ asset_id: other.assets[0], usage: 'identity' }] }, { reference_video_asset_id: other.assets[0] },
    { storyboard_revision: 100 }, { storyboard_reference_asset_id: 'missing' }, { prompt: 'x'.repeat(80_001) }, { extra: true },
  ]
  for (const change of changes) {
    const result = await f.request({ source: { ...source, ...change } })
    assert.ok([409, 422].includes(result.statusCode), result.body)
  }
  assert.equal(calls, previousCalls); assert.equal(snapshot(), before)
})

test('saved defaults and video resolution aliases use the same duration normalization as the real preview', async () => {
  const f = await fixture(), saved = JSON.parse(one<any>('SELECT settings FROM canvas_nodes WHERE id=?', f.nodeId)!.settings)
  run('UPDATE canvas_nodes SET settings=? WHERE id=?', JSON.stringify({ ...saved, ratio: '', resolution: '720P', duration: 1 }), f.nodeId)
  const source = await f.source()
  source.parameters.duration = 4
  response = validResponse()
  const result = await f.request({ source })
  assert.equal(result.statusCode, 200, result.body)
  const beforeCalls = calls
  assert.equal((await f.request({ source: { ...source, parameters: { ...source.parameters, duration: 5 } } })).statusCode, 409)
  assert.equal(calls, beforeCalls)
})

test('visual-profile sources and external video locations are rejected rather than dropping their special inputs', async () => {
  const f = await fixture(), previousCalls = calls
  const original = JSON.parse(one<any>('SELECT settings FROM canvas_nodes WHERE id=?', f.nodeId)!.settings)
  for (const fields of [{ visual_profile_id: 'some-profile' }, { reference_video_url: 'https://external.invalid/reference.mp4' }]) {
    run('UPDATE canvas_nodes SET settings=? WHERE id=?', JSON.stringify({ ...original, ...fields }), f.nodeId)
    const result = await f.request()
    assert.equal(result.statusCode, 422, result.body)
  }
  assert.equal(calls, previousCalls)
})

test('source changes during generation and model/asset changes before confirmation reject stale proposals', async () => {
  const f = await fixture()
  response = validResponse()
  duringGenerate = () => { run('UPDATE canvas_nodes SET prompt=? WHERE id=?', '用户并行修改提示词', f.nodeId) }
  const stale = await f.request()
  duringGenerate = null
  assert.equal(stale.statusCode, 409, stale.body)
  assert.equal(all('SELECT * FROM jobs').length, 0)
  const created = await f.request()
  assert.equal(created.statusCode, 200, created.body)
  const proposal = created.json(), payload = { source: proposal.source, validation_fingerprint: proposal.validation_fingerprint }
  run('UPDATE models SET remote_id=? WHERE id=?', 'changed-remote-video', 'video')
  const modelChanged = await app.inject({ method: 'POST', url: `${f.url}/validate`, payload })
  assert.equal(modelChanged.statusCode, 409, modelChanged.body)
  run('UPDATE models SET remote_id=? WHERE id=?', 'private-remote-video', 'video')
  await writeFile(one<any>('SELECT path FROM assets WHERE id=?', f.assets[0])!.path, 'changed asset bytes and length')
  const assetChanged = await app.inject({ method: 'POST', url: `${f.url}/validate`, payload })
  assert.equal(assetChanged.statusCode, 409, assetChanged.body)
})

test('source fingerprint includes exact incoming nodes and order, while canonical keys ignore object insertion order', async () => {
  const first = { revision: 'same', nodes: [{ id: 'source', prompt: 'A' }, { id: 'input', asset_id: 'fixed' }], edges: [{ source: 'input', target: 'source', reference_asset_id: 'fixed' }] }
  const reordered = { revision: 'same', edges: first.edges.map(edge => ({ reference_asset_id: edge.reference_asset_id, target: edge.target, source: edge.source })), nodes: [{ prompt: 'A', id: 'source' }, { asset_id: 'fixed', id: 'input' }] }
  assert.equal(await canvasNodeProposalFingerprint(first, 'source'), await canvasNodeProposalFingerprint(reordered, 'source'))
  assert.notEqual(await canvasNodeProposalFingerprint(first, 'source'), await canvasNodeProposalFingerprint({ ...first, nodes: [{ id: 'source', prompt: 'A' }, { id: 'input', asset_id: 'new' }] }, 'source'))
})

test('application mounts proposal and validation routes without executing a model for invalid requests', async () => {
  const { buildApp } = await import('../src/app.js'), publicApp = buildApp(), f = await fixture(), source = await f.source(), before = snapshot()
  try {
    const proposal = await publicApp.inject({ method: 'POST', url: f.url, payload: { source, text_model_id: 'image', instructions: '调整运镜' } })
    assert.equal(proposal.statusCode, 422, proposal.body)
    assert.match(proposal.json().detail, /文本模型/)
    const validation = await publicApp.inject({ method: 'POST', url: `${f.url}/validate`, payload: { source, validation_fingerprint: '0'.repeat(64) } })
    assert.equal(validation.statusCode, 409, validation.body)
    assert.equal(snapshot(), before)
  } finally { await publicApp.close() }
})
