import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import Fastify from 'fastify'
import { ZodError } from 'zod'
import type { SceneSoundPlan, VideoAudioPlan } from '@video-studio/shared/media/video-prompt-audio'
import { shotVideoPrompt } from '@video-studio/shared/storyboard/shot-prompts'
import type { Shot } from '../src/infrastructure/database/db.js'

const testData = await mkdtemp(join(tmpdir(), 'video-audio-plan-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { all, db, initDb, now, run } = await import('../src/infrastructure/database/db.js')
const { registerVideoAudioPlanRoutes } = await import('../src/modules/canvas/video-audio-plan.js')
initDb()
after(async () => { db.close(); await rm(testData, { recursive: true, force: true }) })
const exactLine = '刘叔，这两天自来水管没洗吧？煮出来的汤底，隐隐带着股烂鱼死水腥泥味。'
const source = `许知夜用纸巾擦拭唇角红油，缓缓放下手，嘴唇微动沉声开口，声音平稳而带着洞察感：“${exactLine}”`
const audio = (): VideoAudioPlan => ({ version: 1, speech: [{ speaker: '许知夜', text: exactLine,
  delivery: '平稳而带着洞察感', mode: 'dialogue', source_text: source }], sound_effects: ['雨声'], music: '', silent: false })

async function fixture(t: TestContext, generate?: (call: number) => unknown | Promise<unknown>) {
  const projectId = randomUUID(), shotId = randomUUID(), timestamp = now()
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', projectId, '结构化镜头声音', timestamp, timestamp)
  run(`INSERT INTO shots (id,project_id,position,title,prompt,video_prompt,duration,start_state,end_state,cut_note,created_at)
    VALUES (?,?,0,?,?,?,?,?,?,?,?)`, shotId, projectId, '擦拭嘴角', '本镜叙事', source, 8, '拿着纸巾', '收回纸巾', '接老板反应', timestamp)
  const routes = Fastify(), prompts: string[] = []
  routes.setErrorHandler((error, _request, reply) => reply.code(error instanceof ZodError ? 422 : (error as Error & { statusCode?: number }).statusCode || 500)
    .send({ detail: error.message }))
  registerVideoAudioPlanRoutes(routes, { generateText: async (id, modelId, prompt, contract, signal) => {
    assert.equal(id, projectId); assert.equal(modelId, 'mock-text'); assert.equal(contract?.name, 'video_handoff_plan')
    assert.equal(signal?.aborted, false); prompts.push(prompt)
    return JSON.stringify(generate ? await generate(prompts.length) : { audio_plan: audio(), motion_prompt: '擦嘴角后收回纸巾，镜头微拉，保留说话表演。' })
  } })
  t.after(() => routes.close())
  const currentPrompt = () => shotVideoPrompt(all<Shot>('SELECT * FROM shots WHERE id=?', shotId)[0]!)
  const payload = { model_id: 'mock-text', shot_id: shotId, shot_video_prompt: currentPrompt(),
    image_body: '最新画面：许知夜穿深色外套，坐在雨棚下。不要绘制字幕。', source_signature: '0123456789abcdef' }
  const invoke = async (extra: object = {}, status = 200, project = projectId) => {
    const result = await routes.inject({ method: 'POST', url: `/api/projects/${project}/canvas/video-audio-plan`, payload: { ...payload, ...extra } })
    assert.equal(result.statusCode, status, result.body); return result.json()
  }
  const resources = () => Object.fromEntries(['shots', 'assets', 'jobs', 'canvas_nodes'].map(table => [table, all(`SELECT * FROM ${table} WHERE project_id=? ORDER BY rowid`, projectId)]))
  return { projectId, shotId, prompts, payload, invoke, resources, currentPrompt }
}

test('explicit handoff analysis keeps exact plan5 speech and motion while leaving project data untouched', async t => {
  const f = await fixture(t), before = f.resources(), result = await f.invoke()
  assert.deepEqual(result.audio_plan, audio())
  assert.equal(result.source_signature, f.payload.source_signature)
  assert.match(result.motion_prompt, /擦嘴角/)
  assert.equal(f.prompts.length, 1)
  assert.ok(f.prompts[0]!.includes(exactLine))
  assert.match(f.prompts[0]!, /拿着纸巾/)
  assert.match(f.prompts[0]!, /收回纸巾/)
  assert.match(f.prompts[0]!, /接老板反应/)
  assert.match(f.prompts[0]!, /motion_prompt 仅包含画面与动作，不复制台词原文/)
  assert.match(f.prompts[0]!, /实际发声要求全部交 audio_plan/)
  assert.deepEqual(f.resources(), before)
})

test('handoff restores generated punctuation before checking confirmed speech and rendering', async t => {
  const generated = audio()
  generated.speech[0]!.text = exactLine.replaceAll('，', ',').replaceAll('？', '?')
  const f = await fixture(t, () => ({ audio_plan: generated, motion_prompt: '收回纸巾，保持机位。' }))
  run('UPDATE shots SET video_prompt=?,audio_plan=? WHERE id=?', '收回纸巾，保持机位。', JSON.stringify(audio()), f.shotId)
  const before = f.resources(), result = await f.invoke({ shot_video_prompt: f.currentPrompt() })
  assert.equal(result.audio_plan.speech[0].text, exactLine)
  assert.equal(result.audio_plan.speech[0].source_text, source)
  assert.equal(f.prompts.length, 1)
  assert.deepEqual(f.resources(), before)
})

test('cross-project shots and stale source snapshots are rejected before any model work', async t => {
  const f = await fixture(t), otherId = randomUUID(), timestamp = now()
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', otherId, '其他项目', timestamp, timestamp)
  await f.invoke({}, 404, otherId)
  await f.invoke({ shot_video_prompt: '旧分镜内容' }, 409)
  await f.invoke({ shot_id: null }, 422)
  assert.equal(f.prompts.length, 0)
})

test('customised images retain confirmed structured speech absent from the motion prose', async t => {
  const f = await fixture(t)
  run('UPDATE shots SET video_prompt=?,audio_plan=? WHERE id=?', '收回纸巾，镜头微拉。', JSON.stringify(audio()), f.shotId)
  const result = await f.invoke({ shot_video_prompt: f.currentPrompt() })
  assert.equal(result.audio_plan.speech[0].text, exactLine)
  assert.match(f.prompts[0]!, /已保存的 shot.audio_plan/)
  assert.ok(f.prompts[0]!.includes(exactLine))
})

test('managed sound can extend the old motion-only input bound without losing exact speech', async t => {
  const confirmed = audio()
  confirmed.speech[0]!.delivery = '平'.repeat(4000)
  const f = await fixture(t, () => ({ audio_plan: confirmed, motion_prompt: '收回纸巾，保持当前机位。' }))
  run('UPDATE shots SET video_prompt=?,start_state=?,end_state=?,cut_note=?,audio_plan=? WHERE id=?',
    '动'.repeat(20000), '始'.repeat(2000), '终'.repeat(2000), '切'.repeat(2000), JSON.stringify(confirmed), f.shotId)
  const prompt = f.currentPrompt()
  assert.ok(prompt.length > 28000)
  const result = await f.invoke({ shot_video_prompt: prompt })
  assert.equal(result.audio_plan.speech[0].text, exactLine)
  assert.equal(handoffContext(f.prompts[0]!).shot_video_prompt, prompt)
})

test('overlarge structured sound is rejected clearly before model work rather than truncating speech', async t => {
  const f = await fixture(t), line = '台'.repeat(5000)
  const confirmed: VideoAudioPlan = { ...audio(), speech: Array.from({ length: 14 }, () => ({
    speaker: '乘客', text: line, delivery: '低'.repeat(4000), mode: 'dialogue', source_text: line,
  })) }
  run('UPDATE shots SET audio_plan=? WHERE id=?', JSON.stringify(confirmed), f.shotId)
  const prompt = f.currentPrompt()
  assert.ok(prompt.length > 120000)
  assert.equal(prompt.split(line).length, 15, 'compilation never truncates any confirmed line')
  const result = await f.invoke({ shot_video_prompt: prompt }, 422)
  assert.match(result.detail, /超过 120000 字符/)
  assert.match(result.detail, /不会截断已确认台词/)
  assert.equal(f.prompts.length, 0)
})

test('changing only a saved audio plan invalidates an in-flight semantic analysis', async t => {
  let shotId = ''
  const f = await fixture(t, () => {
    run('UPDATE shots SET audio_plan=? WHERE id=?', JSON.stringify(audio()), shotId)
    return { audio_plan: audio(), motion_prompt: '旧声音计划的动作' }
  })
  shotId = f.shotId
  await f.invoke({}, 409)
})

test('a late model result cannot apply after stored shot action or timing changes', async t => {
  let shotId = ''
  const f = await fixture(t, () => {
    run('UPDATE shots SET end_state=? WHERE id=?', '创作者改成起身', shotId)
    return { audio_plan: audio(), motion_prompt: '旧版结束动作' }
  })
  shotId = f.shotId
  await f.invoke({}, 409)
  assert.equal(f.prompts.length, 1)
  assert.equal(all('SELECT * FROM jobs WHERE project_id=?', f.projectId).length, 0)
})

test('invented dialogue evidence fails after one correction without saving any plan', async t => {
  const f = await fixture(t, () => {
    const invented = audio(); invented.speech[0]!.source_text = `不存在的来源：${exactLine}`
    return { audio_plan: invented, motion_prompt: '模型动作草稿' }
  }), before = f.resources()
  const result = await f.invoke({}, 502)
  assert.match(result.detail, /来源摘录/)
  assert.equal(f.prompts.length, 2)
  assert.deepEqual(f.resources(), before)
})

test('a free canvas shot can explicitly analyze silence without a stored storyboard', async t => {
  const silent: VideoAudioPlan = { version: 1, speech: [], sound_effects: [], music: '', silent: true }
  const f = await fixture(t, () => ({ audio_plan: silent, motion_prompt: '维持静止画面与固定机位。' }))
  const result = await f.invoke({ shot_id: null, shot_video_prompt: '', image_body: '人物静坐，整段全程静音。' })
  assert.deepEqual(result.audio_plan, silent)
})

function addShot(projectId: string, position: number, options: { designId?: string; sceneId?: string; video?: string; deleted?: boolean; supersededBy?: string } = {}) {
  const id = randomUUID()
  run(`INSERT INTO shots (id,project_id,position,title,prompt,video_prompt,image_prompt,duration,start_state,end_state,cut_note,created_at,design_id,source_scene_id,deleted_at,superseded_by)
    VALUES (?,?,?,?,?,?,?,5,?,?,?,?,?,?,?,?)`, id, projectId, position, `邻镜 ${position}`, '保持人物朝向', options.video || '固定机位，人物向画面右侧迈步',
    '人物在门前，侧面中景', '站在门前', '右脚刚落地', '在右脚落地处切', now(), options.designId || null, options.sceneId || null,
    options.deleted ? now() : null, options.supersededBy || null)
  return id
}

test('handoff reads only ordered active neighbors of the same project and design and distinguishes scene changes', async t => {
  const f = await fixture(t), design = randomUUID(), otherDesign = randomUUID(), scene = randomUUID(), nextScene = randomUUID(), timestamp = now()
  for (const designId of [design, otherDesign]) run('INSERT INTO storyboard_designs (id,project_id,name,scene_ids,created_at) VALUES (?,?,?,?,?)',
    designId, f.projectId, '独立方案', '[]', timestamp)
  for (const [index, sceneId] of [scene, nextScene].entries()) run('INSERT INTO script_scenes (id,project_id,position,heading,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    sceneId, f.projectId, index, index ? '门外' : '雨棚下', timestamp, timestamp)
  run('UPDATE shots SET position=10,design_id=?,source_scene_id=? WHERE id=?', design, scene, f.shotId)
  const previous = addShot(f.projectId, 5, { designId: design, sceneId: scene }), next = addShot(f.projectId, 20, { designId: design, sceneId: nextScene })
  const skipped = [addShot(f.projectId, 9, { designId: otherDesign }), addShot(f.projectId, 11, { designId: otherDesign }),
    addShot(f.projectId, 8, { designId: design, deleted: true }), addShot(f.projectId, 12, { designId: design, supersededBy: otherDesign })]
  const otherProject = randomUUID()
  run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', otherProject, '其他项目', timestamp, timestamp)
  skipped.push(addShot(otherProject, 9))
  await f.invoke()
  const prompt = f.prompts[0]!, context = JSON.parse(prompt.split('\n').find(line => line.startsWith('{"shot_video_prompt":'))!)
  assert.equal(context.neighbors.previous.id, previous)
  assert.equal(context.neighbors.next.id, next)
  assert.equal(context.neighbors.previous.same_scene, true)
  assert.equal(context.neighbors.next.same_scene, false)
  assert.equal(context.neighbors.next.scene.heading, '门外')
  assert.equal('audio_plan' in context.neighbors.previous, false)
  for (const id of skipped) assert.ok(!prompt.includes(id))
  assert.match(prompt, /不能要求摄影机在本镜内飞到下一镜机位/)
  assert.match(prompt, /不是本镜声音或新增剧情来源/)
})

test('a changed neighboring camera plan rejects an in-flight handoff even when the current shot is unchanged', async t => {
  let previousId = ''
  const f = await fixture(t, () => {
    run('UPDATE shots SET video_prompt=? WHERE id=?', '创作者改成向左运动', previousId)
    return { audio_plan: audio(), motion_prompt: '旧的向右承接' }
  })
  previousId = addShot(f.projectId, -1)
  const result = await f.invoke({}, 409)
  assert.match(result.detail, /相邻分镜/)
  assert.equal(f.prompts.length, 1)
})

test('newly inserted neighbors invalidate a handoff snapshot', async t => {
  let projectId = ''
  const f = await fixture(t, () => {
    addShot(projectId, 1)
    return { audio_plan: audio(), motion_prompt: '没有后镜时规划的收尾' }
  })
  projectId = f.projectId
  await f.invoke({}, 409)
})

test('neighboring dialogue cannot become evidence for the current audio plan', async t => {
  const neighborLine = '门外还有人在等你。', neighborSource = `门外的人说：“${neighborLine}”`
  const f = await fixture(t, () => ({ audio_plan: { version: 1, speech: [{ speaker: '门外的人', text: neighborLine, delivery: '', mode: 'dialogue', source_text: neighborSource }],
    sound_effects: [], music: '', silent: false }, motion_prompt: '人物看向门口。' }))
  addShot(f.projectId, -1, { video: neighborSource })
  const result = await f.invoke({}, 502)
  assert.match(result.detail, /来源摘录/)
  assert.equal(f.prompts.length, 2)
})

test('maximum authored prompt plus saved boundaries fits the handoff input contract', async t => {
  const silent = { version: 1, speech: [], sound_effects: [], music: '', silent: true }
  const f = await fixture(t, () => ({ audio_plan: silent, motion_prompt: '保持机位和人物姿态。' }))
  run('UPDATE shots SET video_prompt=?,start_state=?,end_state=?,cut_note=? WHERE id=?', '静'.repeat(20000), '始'.repeat(2000), '终'.repeat(2000), '切'.repeat(2000), f.shotId)
  const prompt = f.currentPrompt()
  assert.ok(prompt.length > 26000)
  const result = await f.invoke({ shot_video_prompt: prompt })
  assert.deepEqual(result.audio_plan, silent)
})

const trainSound: SceneSoundPlan = { ambience: ['列车车轮连续碾压铁轨', '隔着车窗的雨声'], acoustics: '封闭金属车厢，广播位于头顶', music_policy: 'timeline' }
function addScene(projectId: string) {
  const sceneId = randomUUID(), timestamp = now()
  run('INSERT INTO script_scenes (id,project_id,position,heading,created_at,updated_at) VALUES (?,?,0,?,?,?)', sceneId, projectId, '列车车厢', timestamp, timestamp)
  return sceneId
}
function handoffContext(prompt: string) {
  return JSON.parse(prompt.split('\n').find(line => line.startsWith('{"shot_video_prompt":'))!)
}

test('accepted common scene sound propagates without borrowing another shot dialogue', async t => {
  const f = await fixture(t), sceneId = addScene(f.projectId)
  run('UPDATE shots SET source_scene_id=? WHERE id=?', sceneId, f.shotId)
  const neighbor = addShot(f.projectId, -1, { sceneId })
  const neighborPlan = audio(); neighborPlan.scene_sound = trainSound
  neighborPlan.speech = [{ speaker: '广播', text: '下一站，白骨荒坡。', delivery: '', mode: 'voiceover', source_text: '广播：下一站，白骨荒坡。' }]
  run('UPDATE shots SET audio_plan=? WHERE id=?', JSON.stringify(neighborPlan), neighbor)
  const before = f.resources(), result = await f.invoke()
  assert.deepEqual(result.audio_plan.scene_sound, trainSound)
  assert.equal(result.audio_plan.speech[0].text, exactLine)
  const context = handoffContext(f.prompts[0]!)
  assert.deepEqual(context.scene_sound_context, { status: 'accepted', source_shot_ids: [neighbor], plan: trainSound })
  assert.equal('speech' in context.scene_sound_context.plan, false)
  assert.equal('audio_plan' in context.neighbors.previous, false)
  assert.deepEqual(f.resources(), before)
})

test('scene sound does not cross scene, design or scene-less clip boundaries', async t => {
  const f = await fixture(t), currentScene = addScene(f.projectId), otherScene = addScene(f.projectId), otherDesign = randomUUID()
  run('INSERT INTO storyboard_designs (id,project_id,name,scene_ids,created_at) VALUES (?,?,?,?,?)', otherDesign, f.projectId, '另一方案', '[]', now())
  run('UPDATE shots SET source_scene_id=? WHERE id=?', currentScene, f.shotId)
  for (const options of [{ sceneId: otherScene }, { sceneId: currentScene, designId: otherDesign }]) {
    const id = addShot(f.projectId, -1, options)
    run('UPDATE shots SET audio_plan=? WHERE id=?', JSON.stringify({ ...audio(), scene_sound: trainSound }), id)
  }
  await f.invoke()
  assert.equal(handoffContext(f.prompts[0]!).scene_sound_context.status, 'unknown')
  run('UPDATE shots SET source_scene_id=NULL WHERE id=?', f.shotId)
  const unscoped = addShot(f.projectId, -2)
  run('UPDATE shots SET audio_plan=? WHERE id=?', JSON.stringify({ ...audio(), scene_sound: trainSound }), unscoped)
  await f.invoke()
  assert.equal(handoffContext(f.prompts[1]!).scene_sound_context.status, 'unknown')
})

test('conflicting accepted scene beds remain unresolved instead of silently choosing one', async t => {
  const f = await fixture(t), sceneId = addScene(f.projectId)
  run('UPDATE shots SET source_scene_id=? WHERE id=?', sceneId, f.shotId)
  for (const [position, ambience] of [[-1, '铁轨声'], [1, '海边浪声']] as const) {
    const id = addShot(f.projectId, position, { sceneId })
    run('UPDATE shots SET audio_plan=? WHERE id=?', JSON.stringify({ ...audio(), scene_sound: { ...trainSound, ambience: [ambience] } }), id)
  }
  const result = await f.invoke()
  assert.equal(handoffContext(f.prompts[0]!).scene_sound_context.status, 'conflict')
  assert.equal(result.audio_plan.scene_sound, undefined)
})

test('a model cannot resolve conflicting saved sound beds without a creator sound revision', async t => {
  const f = await fixture(t, () => ({ audio_plan: { ...audio(), scene_sound: trainSound }, motion_prompt: '模型擅自选择的声场' })), sceneId = addScene(f.projectId)
  run('UPDATE shots SET source_scene_id=? WHERE id=?', sceneId, f.shotId)
  for (const [position, acoustics] of [[-1, '金属车厢'], [1, '空旷站台']] as const) {
    const id = addShot(f.projectId, position, { sceneId })
    run('UPDATE shots SET audio_plan=? WHERE id=?', JSON.stringify({ ...audio(), scene_sound: { ...trainSound, acoustics } }), id)
  }
  const result = await f.invoke({}, 502)
  assert.match(result.detail, /共同声场存在冲突/)
  assert.equal(f.prompts.length, 2)
})

test('changing accepted common sound invalidates an in-flight handoff snapshot', async t => {
  let neighborId = ''
  const f = await fixture(t, () => {
    run('UPDATE shots SET audio_plan=? WHERE id=?', JSON.stringify({ ...audio(), scene_sound: { ...trainSound, acoustics: '空旷站台' } }), neighborId)
    return { audio_plan: audio(), motion_prompt: '此前车厢声场的动作' }
  }), sceneId = addScene(f.projectId)
  run('UPDATE shots SET source_scene_id=? WHERE id=?', sceneId, f.shotId)
  neighborId = addShot(f.projectId, -1, { sceneId })
  run('UPDATE shots SET audio_plan=? WHERE id=?', JSON.stringify({ ...audio(), scene_sound: trainSound }), neighborId)
  await f.invoke({}, 409)
})

test('confirmed dialogue cannot be omitted, reassigned or changed to voiceover without explicit permission', async t => {
  for (const change of ['omit', 'speaker', 'mode'] as const) {
    const f = await fixture(t, () => {
      const candidate = audio()
      if (change === 'omit') candidate.speech = []
      else if (change === 'speaker') candidate.speech[0]!.speaker = '模型换了个人'
      else candidate.speech[0]!.mode = 'voiceover'
      return { audio_plan: candidate, motion_prompt: '保留画面动作' }
    })
    run('UPDATE shots SET audio_plan=? WHERE id=?', JSON.stringify(audio()), f.shotId)
    const result = await f.invoke({ shot_video_prompt: f.currentPrompt() }, 502)
    assert.match(result.detail, /已确认台词/)
    assert.equal(f.prompts.length, 2)
  }
})

test('only explicit modify_audio authorizes cancelling confirmed speech and common sound', async t => {
  const silent: VideoAudioPlan = { version: 1, speech: [], sound_effects: [], music: '', silent: true }
  const f = await fixture(t, () => ({ audio_plan: silent, motion_prompt: '人物不再说话，静止画面。' }))
  run('UPDATE shots SET audio_plan=? WHERE id=?', JSON.stringify({ ...audio(), scene_sound: trainSound }), f.shotId)
  const result = await f.invoke({ shot_video_prompt: f.currentPrompt(), modify_audio: true, image_body: '创作者要求本镜改为全程静音。' })
  assert.deepEqual(result.audio_plan, silent)
  assert.equal(handoffContext(f.prompts[0]!).modify_audio, true)
  const denied = await f.invoke({ shot_video_prompt: f.currentPrompt(), image_body: '创作者要求本镜改为全程静音。' }, 502)
  assert.match(denied.detail, /已确认台词/)
})

test('contradictory opening results are returned with evidence instead of silently changing accepted boundaries', async t => {
  const f = await fixture(t, () => ({ audio_plan: audio(), motion_prompt: '保持已确认动作，等待创作者确认边界。',
    boundary_conflicts: [{ message: '首帧提前包含睁眼发光的结果', evidence: ['双眼已爆发金芒', '双眼尚未睁开'], suggestion: '将首帧改为未睁眼状态，或明确修订镜头起点。' }] }))
  run('UPDATE shots SET start_state=? WHERE id=?', '双眼尚未睁开', f.shotId)
  const before = f.resources()
  const result = await f.invoke({ shot_video_prompt: f.currentPrompt(), image_body: '首帧中双眼已爆发金芒。' }, 422)
  assert.match(result.detail, /镜头边界需要确认/)
  assert.match(result.detail, /双眼已爆发金芒/)
  assert.equal(f.prompts.length, 1)
  assert.deepEqual(f.resources(), before)
})

test('a handoff boundary conflict cannot invent its quoted source', async t => {
  const f = await fixture(t, () => ({ audio_plan: audio(), motion_prompt: '等待确认',
    boundary_conflicts: [{ message: '模型臆造穿帮', evidence: ['不存在的青铜剑'], suggestion: '不能臆造依据。' }] }))
  const result = await f.invoke({}, 502)
  assert.match(result.detail, /不能编造证据/)
  assert.equal(f.prompts.length, 2)
})

test('changing a selected previous take invalidates an in-flight handoff even if its plan is unchanged', async t => {
  let previousId = ''
  const f = await fixture(t, () => {
    run('UPDATE shots SET selected_asset_id=? WHERE id=?', 'replacement-take', previousId)
    return { audio_plan: audio(), motion_prompt: '沿旧计划继续' }
  })
  previousId = addShot(f.projectId, -1, {})
  await f.invoke({}, 409)
})
