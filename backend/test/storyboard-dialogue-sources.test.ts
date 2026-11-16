import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VideoAudioPlan } from '../../packages/shared/src/media/video-prompt-audio.js'
const dir = await mkdtemp(join(tmpdir(), 'dialogue-sources-'))
process.env.VIDEO_STUDIO_DATA_DIR = dir
const { storyboardDialogueSources, resolveStoryboardAudio, repairStoryboardDialogue, storyboardAudioInputSchema } = await import('../src/modules/storyboard/storyboard-dialogue-sources.js')
const { db } = await import('../src/infrastructure/database/db.js')
after(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })
const original = '别抬头！你刚上来吧？拿着这个。'
const scene = (id = 'scene-a', dialogue = `林清晏：${original}`) => ({ id, heading: id === 'scene-a' ? 'EP001-SC002' : 'EP001-SC003', episode_number: 1, action: '', dialogue, narration: '' })
const audio = (text = original, source_text = `林清晏：${original}`): VideoAudioPlan => ({ version: 1, speech: [{ speaker: '林清晏', text, source_text, delivery: '急促', mode: 'dialogue' }], sound_effects: [], music: '', silent: false })
const isCode = (code: string) => (error: unknown) => (error as { code: string }).code === code

test('legacy source_text and speech widths recover in both directions, with no mutation', () => {
  for (const [a, b] of [[original, original.replace('！', '!').replace('？', '?')], ['别抬头!拿着这个,走吧;', '别抬头！拿着这个，走吧；']]) {
    const sources = storyboardDialogueSources([scene('scene-a', `林清晏：${a}`)])
    const value = audio(b, `林清晏：${b}`), before = structuredClone(value)
    const resolved = resolveStoryboardAudio(value, 'scene-a', sources)
    assert.equal(resolved.speech[0]!.text, a)
    assert.equal(resolved.speech[0]!.source_text, `林清晏：${a}`)
    assert.deepEqual(value, before)
  }
})

test('changed words, missing words, whitespace and unapproved punctuation are rejected', () => {
  const sources = storyboardDialogueSources([scene()])
  for (const text of ['别低头！你刚上来吧？拿着这个。', '别抬头！拿着这个。', '别 抬头！你刚上来吧？拿着这个。', original.replace('。', '.')]) {
    assert.throws(() => resolveStoryboardAudio(audio(text, `林清晏：${text}`), 'scene-a', sources), isCode('dialogue_source_mismatch'))
  }
})

test('duplicate normalized occurrences are ambiguous and another scene is never a legacy fallback', () => {
  const sources = storyboardDialogueSources([scene('scene-a', `林清晏：${original}\n林清晏：${original}`), scene('scene-b', '乙：另一句。')])
  const candidate = audio(original.replace('！', '!'), `林清晏：${original.replace('！', '!')}`)
  assert.throws(() => resolveStoryboardAudio(candidate, 'scene-a', sources), isCode('dialogue_ref_ambiguous'))
  assert.throws(() => resolveStoryboardAudio(audio('另一句。', '乙：另一句。'), 'scene-a', sources), isCode('dialogue_source_mismatch'))
})

test('versioned references resolve exact slices and reject cross-scene, stale, ambiguous and invalid coordinates', () => {
  const sources = storyboardDialogueSources([scene(), scene('scene-b')]), source = sources[0]!
  assert.deepEqual(storyboardDialogueSources([scene()]), sources.slice(0, 1))
  const plan = audio(original, '')
  plan.speech[0]!.source_ref = { id: source.id, scene_id: source.scene_id, version: source.version, start: 4, end: source.text.length }
  assert.ok(storyboardAudioInputSchema.safeParse(plan).success)
  assert.equal(resolveStoryboardAudio(plan, 'scene-a', sources).speech[0]!.text, original)
  assert.throws(() => resolveStoryboardAudio(plan, 'scene-b', sources), isCode('dialogue_ref_wrong_scene'))
  assert.throws(() => resolveStoryboardAudio(plan, 'scene-a', [...sources, source]), isCode('dialogue_ref_ambiguous'))
  assert.throws(() => resolveStoryboardAudio(plan, 'scene-a', storyboardDialogueSources([scene('scene-a', '改稿了。')])), isCode('dialogue_source_mismatch'))
  plan.speech[0]!.source_ref.start = 999999
  plan.speech[0]!.source_ref.end = 1
  assert.equal(resolveStoryboardAudio(plan, 'scene-a', sources, true, true).speech[0]!.text, original, 'legacy coordinates are ignored and recalculated')
})

test('a valid source reference lets the program replace punctuation variants without trusting copied text', () => {
  const sources = storyboardDialogueSources([scene()]), source = sources[0]!, value = audio('别抬头!你刚上来吧?拿着这个。', '错误出处')
  value.speech[0]!.source_ref = { id: source.id, scene_id: source.scene_id, version: source.version, start: 4, end: source.text.length }
  const resolved = resolveStoryboardAudio(value, 'scene-a', sources)
  assert.equal(resolved.speech[0]!.text, original)
  assert.equal(resolved.speech[0]!.source_text, source.text)
})

test('stable source ids recalculate UTF-16 spans for Chinese punctuation and surrogate pairs', () => {
  const spoken = '看见😀了吗？'
  const sources = storyboardDialogueSources([scene('scene-a', `林清晏：${spoken}`)]), source = sources[0]!
  const plan = audio('', '')
  plan.speech[0]!.text = '看见😀了吗?'
  plan.speech[0]!.source_text = ''
  plan.speech[0]!.source_ref = { id: source.id, scene_id: source.scene_id, version: source.version, start: 0, end: 1 }
  const line = resolveStoryboardAudio(plan, 'scene-a', sources, true, true).speech[0]!
  assert.equal(line.text, spoken)
  assert.equal(line.source_ref?.start, 4)
  assert.equal(line.source_ref?.end, source.text.length)
})

test('episode documents authorize only an exactly headed current-scene excerpt', () => {
  const sources = storyboardDialogueSources([scene(), scene('scene-b')], [{ id: 'doc', version: 'v1', artifact_type: 'episode_script', episode_number: 1,
    content: '# EP001-SC002\n林清晏：本场原话。\n# EP001-SC003\n乙：不能跨场。' }])
  assert.equal(resolveStoryboardAudio(audio('本场原话。', '林清晏：本场原话。'), 'scene-a', sources).speech[0]!.text, '本场原话。')
  assert.throws(() => resolveStoryboardAudio(audio('不能跨场。', '乙：不能跨场。'), 'scene-a', sources), isCode('dialogue_source_mismatch'))
})

function fixture() {
  const sources = storyboardDialogueSources([scene()]), steps: Record<string, unknown> = {}
  const value = { scenes: [{ scene_id: 'scene-a', shots: [{ shot_id: 'keep-shot', title: '不改分镜', duration: 5, audio_plan: audio(original, '错误出处') }, { shot_id: 'keep-second', title: '已经完成', duration: 5, audio_plan: audio() }] }] }
  return { sources, value, options: { key: 'outline-key', signal: new AbortController().signal, steps, retain: (k: string, v: unknown) => { steps[k] = structuredClone(v) } } }
}

test('one failed speech gets one local request, preserves all shots and caches the corrected candidate', async () => {
  const f = fixture(); let calls = 0
  const result = await repairStoryboardDialogue(f.value, f.sources, { ...f.options, generate: async (prompt, contract) => {
    calls++; assert.equal(contract?.name, 'storyboard_dialogue_source_correction')
    assert.ok(prompt.length < 5000); assert.ok(!prompt.includes('不改分镜')); assert.ok(!prompt.includes('已经完成'))
    return JSON.stringify({ speech: audio().speech[0] })
  } })
  assert.equal(calls, 1)
  assert.deepEqual(result.scenes[0]!.shots[1], f.value.scenes[0]!.shots[1])
  assert.equal(result.scenes[0]!.shots[0]!.title, '不改分镜')
  assert.equal(result.scenes[0]!.shots[0]!.audio_plan.speech[0]!.source_text, f.sources[0]!.text)
  assert.equal(f.value.scenes[0]!.shots[0]!.audio_plan.speech[0]!.source_text, '错误出处')
})

test('failed correction keeps candidate and spends no further requests on resume or malformed patch', async () => {
  const f = fixture(); let calls = 0
  const generate = async () => { calls++; return '{invalid' }
  await assert.rejects(repairStoryboardDialogue(f.value, f.sources, { ...f.options, generate }))
  assert.equal(calls, 1)
  assert.ok(f.options.steps['outline-key:candidate'])
  await assert.rejects(repairStoryboardDialogue(f.options.steps['outline-key:candidate'] as typeof f.value, f.sources, { ...f.options, generate }), isCode('dialogue_source_mismatch'))
  assert.equal(calls, 1)
})

test('a locally valid reference to another sentence cannot silently rewrite the failed words', async () => {
  const f = fixture(); let calls = 0
  await assert.rejects(repairStoryboardDialogue(f.value, f.sources, { ...f.options, generate: async () => {
    calls++; return JSON.stringify({ speech: audio('拿着这个。').speech[0] })
  } }), isCode('dialogue_source_mismatch'))
  assert.equal(calls, 1)
})

test('dialogue correction rejects diagnostic fields outside speech and classifies the contract failure', async () => {
  const f = fixture()
  await assert.rejects(repairStoryboardDialogue(f.value, f.sources, { ...f.options, generate: async () => JSON.stringify({
    scene_id: 'scene-a', field_path: 'scenes.0.shots.0.audio_plan.speech.0', speech: audio().speech[0],
  }) }), (error: any) => error.code === 'dialogue_source_correction_contract' && error.field_path.includes('speech.0'))
  const candidate: any = f.options.steps['outline-key:candidate']
  assert.equal(candidate.scenes[0].shots[0].audio_plan.speech[0].source_text, '错误出处')
})
