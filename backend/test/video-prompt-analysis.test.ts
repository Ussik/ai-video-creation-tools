import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { IncomingMessage } from 'node:http'
import Fastify from 'fastify'
import ffmpegPath from 'ffmpeg-static'

const directory = await mkdtemp(join(tmpdir(), 'video-analysis-test-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { db, initDb, run, all, mediaDir } = await import('../src/infrastructure/database/db.js')
const { registerVideoPromptAnalysisRoutes, videoPromptAnalysisResultSchema, videoPromptAnalysisDraftSchema, videoPromptAnalysisInstructions,
  validateVideoPromptAnalysisContent } = await import('../src/modules/canvas/video-prompt-analysis.js')
const { prepareVideoAnalysis, videoAnalysisDuration, videoAnalysisLocation, videoAnalysisRange } = await import('../src/modules/canvas/video-analysis-media.js')
initDb()
run("INSERT INTO projects (id,name,created_at,updated_at) VALUES ('project','视频反推','now','now'),('other','其他项目','now','now')")
run("INSERT INTO providers (id,name,adapter,base_url,created_at) VALUES ('provider','豆包测试','http','https://fixture.invalid','now')")
const settings = { supports_video: true, video_input_format: 'doubao_ark' }
run("INSERT INTO models (id,provider_id,name,remote_id,modality,protocol,settings,enabled) VALUES ('doubao','provider','豆包','doubao-test','text','chat_completions',?,1)", JSON.stringify(settings))
run("INSERT INTO models (id,provider_id,name,remote_id,modality,protocol,settings,enabled) VALUES ('named-doubao','provider','豆包未配置','doubao-test','text','chat_completions','{}',1)")
const source = join(mediaDir, 'source.mp4')
const fixture = spawnSync(ffmpegPath!, ['-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=24:d=3',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source], { encoding: 'utf8' })
assert.equal(fixture.status, 0, fixture.stderr)
const addAsset = (id: string, path: string, project = 'project', kind = 'video') => run(`INSERT INTO assets
  (id,project_id,kind,filename,path,source,prompt,created_at) VALUES (?,?,?,?,?,'upload','DO-NOT-COPY-OLD-PROMPT','now')`, id, project, kind, 'DO-NOT-USE-FILENAME.mp4', path)
addAsset('video', source)
addAsset('foreign', source, 'other')
addAsset('image', source, 'project', 'image')
addAsset('missing', join(mediaDir, 'missing.mp4'))
const outside = join(directory, 'outside.mp4')
await writeFile(outside, await readFile(source)); addAsset('outside', outside)
const linked = join(mediaDir, 'linked.mp4'); await symlink(outside, linked); addAsset('linked', linked)
const corrupt = join(mediaDir, 'corrupt.mp4'); await writeFile(corrupt, 'not a video'); addAsset('corrupt', corrupt)
const app = Fastify()
app.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode || 422).send({ detail: String(error) }))
let calls = 0, prepares = 0, raw: IncomingMessage, cancelled = false, mutation = false, providerIssue = false
let requestedVideo: unknown, requestedPrompt = '', duration = 90_000
const shot = { title: '挥剑', start_ms: 0, end_ms: 6000, start_state: '人物持剑站立', action: '人物向前挥剑，衣袖随动',
  end_state: '剑停于身侧', camera: '低机位跟随人物前移', vfx: '未见明显特效',
  image_prompt: '人物持剑站在石阶上，侧光照亮衣料。', video_prompt: '人物向前踏步挥剑，镜头低位跟随，衣袖随动作摆动，挥剑后停于身侧。', uncertainties: ['接触瞬间不清晰'] }
const content = { global_style: '写实比例的三维国漫，冷色环境与暖色侧光。', shots: [shot], uncertainties: [] }
let output = JSON.stringify(content)
app.addHook('preHandler', async request => { raw = request.raw })
registerVideoPromptAnalysisRoutes(app, {
  probe: async () => duration,
  prepare: async (_path, start, end, fps, signal) => {
    prepares++; signal.throwIfAborted()
    return { data_url: 'data:video/mp4;base64,YWJjZA==', duration_ms: end - start, fps }
  },
  generate: async (model, provider, request, signal) => {
    calls++; assert.equal(model.id, 'doubao'); assert.equal(provider.id, 'provider')
    assert.equal(request.images, undefined); assert.ok(request.structured_output)
    requestedVideo = request.video; requestedPrompt = request.prompt
    if (cancelled) { raw.emit('aborted'); signal.throwIfAborted() }
    if (mutation) run("UPDATE assets SET path=? WHERE id='video'", outside)
    if (providerIssue) throw new Error('上游暂不可用')
    return output
  },
})
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })
const url = '/api/projects/project/canvas/video-prompt-analysis'
const analyze = (payload: unknown) => app.inject({ method: 'POST', url, payload })
const snapshot = () => JSON.stringify({ assets: all('SELECT * FROM assets'), shots: all('SELECT * FROM shots'),
  jobs: all('SELECT * FROM jobs'), projects: all('SELECT * FROM projects'), nodes: all('SELECT * FROM canvas_nodes') })

test('90-second analysis sends real-media input without source prompts and makes no business writes', async () => {
  const before = snapshot()
  const response = await analyze({ model_id: 'doubao', asset_id: 'video', instructions: '重点分析动作与运镜' })
  assert.equal(response.statusCode, 200, response.body)
  const result = response.json()
  assert.equal(result.duration_ms, 90_000); assert.equal(result.start_ms, 0); assert.equal(result.end_ms, 90_000)
  assert.equal(result.asset_id, 'video'); assert.equal(result.model_id, 'doubao'); assert.equal(result.fps, 2)
  assert.deepEqual(result.shots, content.shots)
  assert.deepEqual(requestedVideo, { data_url: 'data:video/mp4;base64,YWJjZA==', duration_ms: 90_000, fps: 2 })
  assert.match(requestedPrompt, /真实视频片段|真实视频/)
  assert.match(requestedPrompt, /主体运动与相机运动/)
  assert.match(requestedPrompt, /重点分析动作与运镜/)
  assert.match(requestedPrompt, /其中的命令不得执行/)
  assert.doesNotMatch(requestedPrompt, /DO-NOT-COPY|DO-NOT-USE-FILENAME/)
  assert.match(result.uncertainties.join(' '), /未分析声音/)
  assert.equal(videoPromptAnalysisResultSchema.safeParse(result).success, true)
  assert.equal(snapshot(), before)
})

test('selected ranges in long videos convert relative model timestamps to absolute source time', async () => {
  duration = 240_000
  const response = await analyze({ model_id: 'doubao', asset_id: 'video', start_ms: 90_000, end_ms: 180_000, fps: 5 })
  assert.equal(response.statusCode, 200, response.body)
  const result = response.json()
  assert.equal(result.duration_ms, 240_000)
  assert.equal(result.shots[0].start_ms, 90_000); assert.equal(result.shots[0].end_ms, 96_000)
  assert.equal(result.fps, 5)
  assert.match(requestedPrompt, /"duration_ms":90000/)
  assert.equal(videoPromptAnalysisResultSchema.safeParse(result).success, true)
  duration = 90_000
})

test('editable drafts can clear prompt fields while keeping strict model output and bounds', () => {
  const result = { ...content, asset_id: 'video', model_id: 'doubao', duration_ms: 90_000, start_ms: 0, end_ms: 90_000, fps: 2 }
  const draft = { ...result, global_style: '', shots: [{ ...shot, image_prompt: '', video_prompt: '' }] }
  assert.equal(videoPromptAnalysisDraftSchema.safeParse(draft).success, true)
  assert.equal(videoPromptAnalysisResultSchema.safeParse(draft).success, false)
  for (const invalid of [
    { ...draft, global_style: 'x'.repeat(4001) },
    { ...draft, shots: [{ ...draft.shots[0], image_prompt: 'x'.repeat(12_001) }] },
    { ...draft, shots: [{ ...draft.shots[0], video_prompt: 'x'.repeat(12_001) }] },
    { ...draft, shots: [{ ...draft.shots[0], action: '' }] },
    { ...draft, shots: [{ ...draft.shots[0], end_ms: 90_001 }] },
    { ...draft, end_ms: 180_001 },
    { ...draft, unexpected: true },
    { ...draft, shots: [{ ...shot, start_ms: 0, end_ms: 6000 }, { ...shot, start_ms: 5000, end_ms: 7000 }] },
  ]) assert.equal(videoPromptAnalysisDraftSchema.safeParse(invalid).success, false)
  const oversized = videoPromptAnalysisDraftSchema.safeParse({ ...draft, shots: Array.from({ length: 10 }, (_, index) => ({
    ...shot, start_ms: index * 6000, end_ms: (index + 1) * 6000, image_prompt: '', video_prompt: 'x'.repeat(10_000),
  })) })
  assert.equal(oversized.success, false)
  if (!oversized.success) assert.ok(oversized.error.issues.some(issue => issue.message.includes('过长')))
})

test('source ownership, kind, missing files and escaping paths fail before provider or preparation', async () => {
  const beforeCalls = calls, beforePrepares = prepares, before = snapshot()
  for (const asset_id of ['foreign', 'image', 'missing', 'outside', 'linked', 'unknown']) {
    const response = await analyze({ model_id: 'doubao', asset_id })
    assert.ok([404, 422].includes(response.statusCode), `${asset_id}: ${response.body}`)
  }
  assert.equal(calls, beforeCalls); assert.equal(prepares, beforePrepares); assert.equal(snapshot(), before)
})

test('ranges, sampling and input fields are validated before paid analysis', async () => {
  const beforeCalls = calls, beforePrepares = prepares
  for (const patch of [{ start_ms: -1 }, { start_ms: 90_000 }, { end_ms: 90_001 }, { end_ms: 500 },
    { start_ms: 3000, end_ms: 2000 }, { fps: 0.1 }, { fps: 5.1 }, { fps: '2' }, { source: '/etc/passwd' },
    { instructions: 'x'.repeat(4001) }]) {
    const response = await analyze({ model_id: 'doubao', asset_id: 'video', ...patch })
    assert.equal(response.statusCode, 422, response.body)
  }
  duration = 180_001
  assert.equal((await analyze({ model_id: 'doubao', asset_id: 'video' })).statusCode, 422)
  duration = 90_000
  assert.equal(calls, beforeCalls); assert.equal(prepares, beforePrepares)
})

test('explicit doubao capability and available model/provider are required', async () => {
  const before = calls
  assert.equal((await analyze({ model_id: 'named-doubao', asset_id: 'video' })).statusCode, 422)
  for (const invalid of [{ supports_video: true }, { ...settings, supports_video: false }, { ...settings, supports_video: 'true' }, [], null]) {
    run("UPDATE models SET settings=? WHERE id='doubao'", JSON.stringify(invalid))
    assert.equal((await analyze({ model_id: 'doubao', asset_id: 'video' })).statusCode, 422)
  }
  run("UPDATE models SET settings=? WHERE id='doubao'", JSON.stringify(settings))
  for (const [table, column, value, restored] of [
    ['models', 'enabled', 0, 1], ['models', 'archived', 1, 0], ['models', 'modality', 'image', 'text'],
    ['models', 'protocol', 'image_generations', 'chat_completions'], ['providers', 'enabled', 0, 1],
    ['providers', 'archived', 1, 0], ['providers', 'adapter', 'demo', 'http'],
  ] as const) {
    const id = table === 'models' ? 'doubao' : 'provider'
    run(`UPDATE ${table} SET ${column}=? WHERE id=?`, value, id)
    assert.equal((await analyze({ model_id: 'doubao', asset_id: 'video' })).statusCode, 422)
    run(`UPDATE ${table} SET ${column}=? WHERE id=?`, restored, id)
  }
  assert.equal(calls, before)
})

test('invalid model timestamps and malformed responses never become usable results', async () => {
  const before = snapshot()
  for (const shots of [[{ ...shot, end_ms: 90_001 }], [{ ...shot, end_ms: 0 }],
    [shot, { ...shot, start_ms: 1000, end_ms: 7000 }], [{ ...shot, start_ms: 2000, end_ms: 3000 }, { ...shot, start_ms: 0, end_ms: 1000 }]]) {
    output = JSON.stringify({ ...content, shots })
    const response = await analyze({ model_id: 'doubao', asset_id: 'video' })
    assert.equal(response.statusCode, 502, response.body)
  }
  output = JSON.stringify({ ...content, asset_id: 'foreign' })
  assert.equal((await analyze({ model_id: 'doubao', asset_id: 'video' })).statusCode, 502)
  output = '   '
  assert.equal((await analyze({ model_id: 'doubao', asset_id: 'video' })).statusCode, 502)
  output = JSON.stringify(content)
  assert.equal(snapshot(), before)
})

test('oversized results, source changes, cancellation and provider errors preserve existing data', async () => {
  assert.throws(() => validateVideoPromptAnalysisContent({ ...content, shots: Array.from({ length: 10 }, (_, index) => ({
    ...shot, start_ms: index * 6000, end_ms: (index + 1) * 6000, video_prompt: '长'.repeat(10_000),
  })) }, 0, 90_000), /过长/)
  let before = snapshot()
  cancelled = true
  assert.equal((await analyze({ model_id: 'doubao', asset_id: 'video' })).statusCode, 499)
  cancelled = false
  assert.equal(snapshot(), before)
  providerIssue = true
  const failure = await analyze({ model_id: 'doubao', asset_id: 'video' })
  assert.equal(failure.statusCode, 502); assert.match(failure.body, /上游暂不可用/)
  providerIssue = false
  assert.equal(snapshot(), before)
  mutation = true
  const changed = await analyze({ model_id: 'doubao', asset_id: 'video' })
  assert.equal(changed.statusCode, 409, changed.body)
  mutation = false
  run("UPDATE assets SET path=? WHERE id='video'", source)
  assert.equal(snapshot(), before)
})

test('real FFmpeg preparation selects video range, removes audio and retains the original', async () => {
  const controller = new AbortController(), signal = controller.signal
  const asset = all('SELECT * FROM assets WHERE id=?', 'video')[0] as any
  assert.equal(await videoAnalysisLocation(asset, signal), await realpath(source))
  assert.equal(await videoAnalysisDuration(source, signal), 3000)
  const before = await readFile(source), output = await prepareVideoAnalysis(source, 1000, 2000, 3, signal)
  assert.equal(output.duration_ms, 1000); assert.equal(output.fps, 3)
  const prepared = join(directory, 'prepared.mp4')
  const decoded = Buffer.from(output.data_url.split(',')[1]!, 'base64')
  assert.equal(decoded.subarray(4, 8).toString(), 'ftyp')
  await writeFile(prepared, decoded)
  assert.equal(await videoAnalysisDuration(prepared, signal), 1000)
  const metadata = spawnSync(ffmpegPath!, ['-hide_banner', '-i', prepared], { encoding: 'utf8' }).stderr
  assert.match(metadata, /Video:/); assert.match(metadata, /24 fps/); assert.doesNotMatch(metadata, /Audio:/)
  assert.deepEqual(await readFile(source), before)
  assert.equal((await stat(source)).size, before.length)
  await assert.rejects(videoAnalysisDuration(corrupt, signal), /视频画面|有效视频/)
})

test('range helper accepts 90 seconds and preparation cancellation does not leave temporary files', async () => {
  assert.deepEqual(videoAnalysisRange(90_000, 0, null), { start_ms: 0, end_ms: 90_000 })
  assert.deepEqual(videoAnalysisRange(360_000, 180_000, 360_000), { start_ms: 180_000, end_ms: 360_000 })
  assert.throws(() => videoAnalysisRange(180_001, 0, null), /180/)
  const controller = new AbortController(); controller.abort(new Error('已取消'))
  const before = (await readdir(tmpdir())).filter(name => name.startsWith('video-prompt-analysis-')).sort()
  await assert.rejects(prepareVideoAnalysis(source, 0, 1000, 2, controller.signal), /已取消/)
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('video-prompt-analysis-')).sort(), before)
  assert.match(videoPromptAnalysisInstructions(90_000, 2, '重点看剑气'), /不猜测原始提示词/)
})

test('default route transcodes local video and sends bounded video bytes through the provider adapter', async t => {
  const integrated = Fastify()
  integrated.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode || 422).send({ detail: String(error) }))
  const wireSettings = { ...settings, request_path: 'chat/completions', text_path: 'choices.0.message.content',
    request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }], stream: false, max_tokens: 4000 } }
  run("INSERT INTO models (id,provider_id,name,remote_id,modality,protocol,settings,enabled) VALUES ('wire','provider','真实适配测试','doubao-wire','text','chat_completions',?,1)", JSON.stringify(wireSettings))
  registerVideoPromptAnalysisRoutes(integrated)
  const before = snapshot()
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (address: unknown, init: RequestInit) => {
    requests++
    assert.equal(address, 'https://fixture.invalid/chat/completions')
    const body = JSON.parse(String(init.body))
    const parts = body.messages[0].content
    assert.match(parts[0].text, /真实视频/)
    assert.doesNotMatch(parts[0].text, /DO-NOT-COPY|DO-NOT-USE-FILENAME/)
    assert.equal(parts[1].type, 'video_url'); assert.equal(parts[1].video_url.fps, 2)
    const bytes = Buffer.from(parts[1].video_url.url.split(',')[1], 'base64')
    assert.equal(bytes.subarray(4, 8).toString(), 'ftyp')
    return Response.json({ choices: [{ message: { content: JSON.stringify({ ...content, shots: [{ ...shot, end_ms: 3000 }] }) }, finish_reason: 'stop' }] })
  })
  try {
    const response = await integrated.inject({ method: 'POST', url, payload: { model_id: 'wire', asset_id: 'video' } })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().duration_ms, 3000)
    assert.equal(response.json().model_id, 'wire')
    assert.equal(requests, 1)
    assert.equal(snapshot(), before)
  } finally { await integrated.close() }
})

test('long analysis preserves actual cuts and resumes only the unfinished shot after failure', async t => {
  const isolated = Fastify(); t.after(() => isolated.close())
  isolated.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode || 500).send({ detail: String(error) }))
  let mapCalls = 0, fail = true
  const detailCalls: number[] = []
  const map = { global_style: content.global_style, uncertainties: [], shots: [
    { title: '连续长镜头', start_ms: 0, end_ms: 37_000 }, { title: '真实反打', start_ms: 37_000, end_ms: 120_000 },
  ] }
  registerVideoPromptAnalysisRoutes(isolated, { probe: async () => 120_000,
    prepare: async (_path, start, end, fps) => ({ data_url: 'data:video/mp4;base64,YWJjZA==', duration_ms: end - start, fps }),
    generate: async (_model, _provider, request) => {
      assert.equal(request.video?.duration_ms, 120_000, 'every unit can inspect the full real video for continuity')
      if (request.structured_output?.name === 'video_prompt_analysis_map') { mapCalls++; return JSON.stringify(map) }
      assert.equal(request.structured_output?.name, 'video_prompt_analysis')
      const source = JSON.parse(request.prompt.split('【当前完整镜头单元】')[1]!.split('：')[1]!.split('\n')[0]!)
      detailCalls.push(source.start_ms)
      if (source.start_ms === 37_000 && fail) throw Object.assign(new Error('second shot interrupted'), { statusCode: 422 })
      return JSON.stringify({ ...content, shots: [{ ...shot, ...source }] })
    } })
  const invoke = () => isolated.inject({ method: 'POST', url, payload: { model_id: 'doubao', asset_id: 'video', instructions: '恢复真实镜头测试' } })
  const before = snapshot()
  assert.equal((await invoke()).statusCode, 422)
  fail = false
  const response = await invoke(); assert.equal(response.statusCode, 200, response.body)
  assert.equal(mapCalls, 1); assert.deepEqual(detailCalls, [0, 37_000, 37_000])
  assert.deepEqual(response.json().shots.map((value: any) => [value.start_ms, value.end_ms]), [[0, 37_000], [37_000, 120_000]])
  assert.equal(snapshot(), before)
})
