import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import ffmpegPath from 'ffmpeg-static'

const directory = await mkdtemp(join(tmpdir(), 'canvas-video-analysis-api-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, all, run, mediaDir } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}

const settings = { supports_video: true, video_input_format: 'doubao_ark', request_path: 'chat/completions',
  text_path: 'choices.0.message.content', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }], stream: false } }
run("INSERT INTO providers (id,name,adapter,base_url,created_at) VALUES ('video-provider','测试','http','https://video-analysis.invalid','now')")
run("INSERT INTO models (id,provider_id,name,remote_id,modality,protocol,settings,enabled) VALUES ('video-reader','video-provider','豆包视频理解','doubao-fixture','text','chat_completions',?,1)", JSON.stringify(settings))
run("INSERT INTO models (id,provider_id,name,remote_id,modality,protocol,settings,enabled) VALUES ('image-model','video-provider','图片模型','image-fixture','image','image_generations','{}',1)")
const project = await call('POST', '/api/projects', { name: '视频反推契约' })
const otherProject = await call('POST', '/api/projects', { name: '其他项目' })
const source = join(mediaDir, 'source.mp4')
const made = spawnSync(ffmpegPath!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=24:d=2',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source], { encoding: 'utf8' })
assert.equal(made.status, 0, made.stderr)
function addAsset(id: string, kind: 'image' | 'video', projectId = project.id) {
  run(`INSERT INTO assets (id,project_id,kind,filename,path,source,prompt,created_at)
    VALUES (?,?,?,?,?,'upload','ORIGINAL-PROMPT-MUST-NOT-BE-SENT','now')`, id, projectId, kind, `${id}.${kind === 'video' ? 'mp4' : 'png'}`, source)
}
addAsset('source-video', 'video'); addAsset('replacement-video', 'video'); addAsset('source-image', 'image')
addAsset('foreign-video', 'video', otherProject.id)
function analysisResult() {
  return { asset_id: 'source-video', model_id: 'video-reader', duration_ms: 2000, start_ms: 0, end_ms: 2000, fps: 2,
    global_style: '三维国漫风格，冷色环境光。', uncertainties: ['未分析音轨'], shots: [{
      title: '蓝色场景', start_ms: 0, end_ms: 2000, start_state: '画面为蓝色', action: '画面保持稳定',
      end_state: '画面仍为蓝色', camera: '固定机位', vfx: '未见明显特效', image_prompt: '一幅蓝色背景画面。',
      video_prompt: '蓝色画面保持稳定，固定机位。', uncertainties: [],
    }] }
}
function node(id: string, type = 'video_analysis', patch: Record<string, unknown> = {}) {
  return { id, type, title: '视频反推提示词', x: 20, y: 40, width: 420, height: 340,
    text: '可编辑的镜头提示词', asset_id: null, model_id: null, shot_id: null, job_id: null, prompt: '', settings: {}, ...patch }
}
const canvasUrl = `/api/projects/${project.id}/canvas`
const businessSnapshot = () => JSON.stringify({ jobs: all('SELECT * FROM jobs'), shots: all('SELECT * FROM shots') })

test('default and named canvases persist video-analysis nodes and editable result drafts', async () => {
  const named = await call('POST', `/api/projects/${project.id}/canvases`, { name: '视频反推方案' })
  for (const [index, url] of [canvasUrl, `/api/projects/${project.id}/canvases/${named.id}`].entries()) {
    const initial = await call('GET', url), result = analysisResult()
    const analysis = node(`analysis-${index}`, 'video_analysis', { asset_id: 'source-video', model_id: 'video-reader',
      text: 'x'.repeat(21_000), settings: { video_analysis_instructions: '重点分析运镜', video_analysis_start_ms: 0,
        video_analysis_end_ms: 0, video_analysis_fps: 2, video_analysis_result: result } })
    const saved = await call('PUT', url, { ...initial, nodes: [analysis] })
    assert.equal(saved.nodes[0].type, 'video_analysis')
    assert.equal(saved.nodes[0].text.length, 21_000)
    assert.equal(saved.nodes[0].settings.video_analysis_end_ms, 0)
    assert.deepEqual(saved.nodes[0].settings.video_analysis_result, result)
    assert.deepEqual(await call('GET', url), saved)
    const cleared = { ...result, global_style: '', shots: result.shots.map(shot => ({ ...shot, image_prompt: '', video_prompt: '' })) }
    const edited = await call('PUT', url, { ...saved, nodes: [{ ...saved.nodes[0], settings: {
      ...saved.nodes[0].settings, video_analysis_result: cleared,
    } }] })
    assert.deepEqual(edited.nodes[0].settings.video_analysis_result, cleared)
    assert.deepEqual(await call('GET', url), edited)
    const changedSource = await call('PUT', url, { ...edited, nodes: [{ ...edited.nodes[0], asset_id: 'replacement-video' }] })
    assert.equal(changedSource.nodes[0].settings.video_analysis_result.asset_id, 'source-video', 'previous report remains available after replacing source')
  }
})

test('video edge snapshots are accepted only for video-analysis targets', async () => {
  const graph = await call('GET', canvasUrl)
  const nodes = [node('edge-video', 'video', { asset_id: 'source-video' }), node('edge-analysis'), node('edge-generation', 'generation')]
  const edge = { id: 'video-snapshot', source: 'edge-video', target: 'edge-analysis', reference_asset_id: 'source-video' }
  const saved = await call('PUT', canvasUrl, { ...graph, nodes, edges: [edge] })
  assert.deepEqual(saved.edges, [edge])
  assert.deepEqual(await call('GET', canvasUrl), saved)
  for (const target of ['edge-generation', 'edge-video']) {
    const response = await app.inject({ method: 'PUT', url: canvasUrl, payload: { ...saved,
      edges: [{ ...edge, source: target === 'edge-video' ? 'edge-analysis' : 'edge-video', target }],
    } })
    assert.equal(response.statusCode, 422, response.body)
    assert.match(response.body, /参考图|图片/)
    assert.deepEqual(await call('GET', canvasUrl), saved)
  }
})

test('foreign and wrong-kind video sources are rejected atomically in assets, reports and edge snapshots', async () => {
  const saved = await call('GET', canvasUrl)
  for (const sourceId of ['foreign-video', 'source-image', 'missing-video']) {
    for (const payload of [
      { ...saved, nodes: saved.nodes.map((item: any) => item.id === 'edge-analysis' ? { ...item, asset_id: sourceId } : item) },
      { ...saved, nodes: saved.nodes.map((item: any) => item.id === 'edge-analysis' ? { ...item,
        settings: { video_analysis_result: { ...analysisResult(), asset_id: sourceId } } } : item) },
      { ...saved, edges: saved.edges.map((edge: any) => ({ ...edge, reference_asset_id: sourceId })) },
    ]) {
      const response = await app.inject({ method: 'PUT', url: canvasUrl, payload })
      assert.equal(response.statusCode, 422, `${sourceId}: ${response.body}`)
      assert.deepEqual(await call('GET', canvasUrl), saved)
    }
  }
  const invalidModel = await app.inject({ method: 'PUT', url: canvasUrl, payload: { ...saved,
    nodes: saved.nodes.map((item: any) => item.id === 'edge-analysis' ? { ...item, model_id: 'image-model' } : item),
  } })
  assert.equal(invalidModel.statusCode, 422); assert.match(invalidModel.body, /文本模型/)
  assert.deepEqual(await call('GET', canvasUrl), saved)
})

test('application registers video analysis and a successful analysis creates no shots or generation jobs', async t => {
  const before = businessSnapshot(), graph = await call('GET', canvasUrl)
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (address: unknown, init: RequestInit) => {
    requests++
    assert.equal(address, 'https://video-analysis.invalid/chat/completions')
    const body = JSON.parse(String(init.body))
    assert.doesNotMatch(JSON.stringify(body.messages[0].content[0]), /ORIGINAL-PROMPT-MUST-NOT-BE-SENT/)
    const video = body.messages[0].content[1]
    assert.equal(video.type, 'video_url'); assert.equal(video.video_url.fps, 2)
    const bytes = Buffer.from(video.video_url.url.split(',')[1], 'base64')
    assert.equal(bytes.subarray(4, 8).toString(), 'ftyp')
    const { global_style, shots, uncertainties } = analysisResult()
    return Response.json({ choices: [{ message: { content: JSON.stringify({ global_style, shots, uncertainties }) }, finish_reason: 'stop' }] })
  })
  const endpoint = `/api/projects/${project.id}/canvas/video-prompt-analysis`
  for (const payload of [
    { model_id: 'video-reader', asset_id: 'foreign-video' },
    { model_id: 'video-reader', asset_id: 'source-image' },
    { model_id: 'video-reader', asset_id: 'source-video', end_ms: 0 },
  ]) {
    const rejected = await app.inject({ method: 'POST', url: endpoint, payload })
    assert.equal(rejected.statusCode, 422, rejected.body)
  }
  assert.equal(requests, 0)
  const result = await call('POST', endpoint, { model_id: 'video-reader', asset_id: 'source-video' })
  assert.equal(result.asset_id, 'source-video'); assert.equal(result.duration_ms, 2000)
  assert.equal(result.shots[0].video_prompt, analysisResult().shots[0]!.video_prompt)
  assert.equal(requests, 1)
  assert.equal(businessSnapshot(), before)
  assert.deepEqual(await call('GET', canvasUrl), graph)
})

test('deleting a source and model preserves editable historical reports but cannot authorize forged history', async () => {
  const historicalProject = await call('POST', '/api/projects', { name: '历史反推结果' })
  const url = `/api/projects/${historicalProject.id}/canvas`
  addAsset('historical-video', 'video', historicalProject.id)
  addAsset('current-valid-video', 'video', historicalProject.id)
  run("INSERT INTO models (id,provider_id,name,remote_id,modality,protocol,settings,enabled) VALUES ('historical-reader','video-provider','已删除模型测试','historical-model','text','chat_completions',?,1)", JSON.stringify(settings))
  const report = { ...analysisResult(), asset_id: 'historical-video', model_id: 'historical-reader' }
  const initial = await call('GET', url)
  await call('PUT', url, { ...initial, nodes: [node('historical-analysis', 'video_analysis', {
    asset_id: report.asset_id, model_id: report.model_id, settings: { video_analysis_result: report },
  })] })
  run('DELETE FROM assets WHERE id=?', report.asset_id)
  const deletion = await app.inject({ method: 'DELETE', url: `/api/models/${report.model_id}` })
  assert.equal(deletion.statusCode, 200, deletion.body)
  assert.equal(all('SELECT * FROM assets WHERE id=?', report.asset_id).length, 0)
  assert.equal(all('SELECT * FROM models WHERE id=?', report.model_id).length, 0)
  const missing = await call('GET', url)
  assert.equal(missing.nodes[0].asset_id, null)
  assert.equal(missing.nodes[0].model_id, null)
  assert.deepEqual(missing.nodes[0].settings.video_analysis_result, report)
  const editedReport = { ...report, global_style: '重新整理的手动画风', shots: report.shots.map(shot => ({ ...shot, video_prompt: '手工重写的镜头提示词。' })) }
  const saved = await call('PUT', url, { ...missing, nodes: [{ ...missing.nodes[0], asset_id: null, model_id: null,
    text: '历史报告来源已删除，保留人工修改。', settings: { video_analysis_result: editedReport },
  }] })
  assert.deepEqual(saved.nodes[0].settings.video_analysis_result, editedReport)
  assert.deepEqual(await call('GET', url), saved)
  const changedReport = (patch: Record<string, unknown>) => ({ ...saved,
    nodes: [{ ...saved.nodes[0], settings: { video_analysis_result: { ...editedReport, ...patch } } }],
  })
  for (const payload of [
    changedReport({ asset_id: 'fabricated-missing-video' }),
    changedReport({ model_id: 'fabricated-missing-model' }),
    { ...saved, nodes: [...saved.nodes, node('forged-borrowed-history', 'video_analysis', { settings: { video_analysis_result: editedReport } })] },
    { ...saved, nodes: [...saved.nodes, node('forged-model-history', 'video_analysis', { settings: {
      video_analysis_result: { ...editedReport, asset_id: 'current-valid-video' },
    } })] },
  ]) {
    const rejected = await app.inject({ method: 'PUT', url, payload })
    assert.equal(rejected.statusCode, 422, rejected.body)
    assert.deepEqual(await call('GET', url), saved)
  }
})
