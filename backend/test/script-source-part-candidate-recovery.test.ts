import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceSection } from '@video-studio/shared/script/script-source-document'
import { CompletedOutputReplayMiss, generateStructuredOutput, type StructuredGenerator } from '../src/modules/generation/model-output.js'
import { sourceStorySchema, synthesizeSourceStoryParts } from '../src/modules/script/script-source-story-parts.js'
import { z } from 'zod'

function fixture() {
  const source = { filename: 'original.txt', content: '甲辰和乙巳一起回来。' }
  const evidence = { offset: 0, quote: source.content }
  const section: ScriptSourceSection = { offset: 0, length: source.content.length, title: '第一章', summary: '两人回来',
    characters: ['甲辰', '乙巳'].map(name => ({ name, description: name, evidence })), events: [{ summary: '两人回来', evidence }], open_threads: [] }
  const state: ScriptSourceAnalysis = { id: 'original-run', source_version: 'original-source', model_id: 'model', configuration_hash: 'same-config',
    status: 'running', phase: 'synthesis', completed_chunks: 1, total_chunks: 1, sections: [section], error: null, updated_at: 'now' }
  return { source, state, materials: [{ covered_section_ids: [0], section }] }
}
function input(prompt: string): { part: { key: string; kind: string; target_names?: string[] } } {
  const marker = '【全剧整合资料】\n'; return JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
}
function reply(prompt: string) {
  const part = input(prompt).part
  if (part.kind === 'overview') return { summary: '甲辰和乙巳回来', ending: { summary: '两人回来', section_ids: [0] }, covered_section_ids: [0] }
  if (part.kind === 'characters') return { characters: part.target_names!.map(name => ({ name, aliases: [], description: '原稿人物'+name, section_ids: [0] })) }
  if (part.kind === 'timeline') return { timeline: [{ summary: '两人回来', section_ids: [0] }], covered_section_ids: [0] }
  if (part.kind === 'threads') return { threads: [] }
  return { uncertainties: [] }
}
const run = (f: ReturnType<typeof fixture>, generate: StructuredGenerator, persist = () => {}) => synthesizeSourceStoryParts(
  f.state, generate, persist, new AbortController().signal, f.source, f.materials, value => sourceStorySchema.parse(value))

async function interrupted(formatCorrection: boolean) {
  const f = fixture(), recorded = new Map<string, string>(); let interrupted = false, characterCalls = 0
  const generate: StructuredGenerator = async (prompt, contract) => {
    const value = reply(prompt)
    if (input(prompt).part.kind === 'characters' && ++characterCalls === 1 && formatCorrection) {
      const person = (value as { characters: Array<{ description?: string; key_attributes?: string }> }).characters[0]!
      person.key_attributes = person.description; delete person.description
    }
    const raw = JSON.stringify(value); recorded.set(JSON.stringify([prompt, contract]), raw); return raw
  }
  await assert.rejects(run(f, generate, () => {
    const candidate = f.state.story_work?.tasks.find(task => task.key === 'characters:0')?.output_candidate
    if (!interrupted && (formatCorrection ? candidate?.checkpoint.correction : candidate?.checkpoint.raw)) { interrupted = true; throw new Error('fixture interruption after complete output') }
  }), /检查点保存失败/)
  return { f, recorded }
}

test('private complete part raw and correction are revalidated before a stale coverage recovery branch without another provider call', async () => {
  for (const formatCorrection of [false, true]) {
    const { f } = await interrupted(formatCorrection)
    const parent = f.state.story_work!.tasks.find(task => task.key === 'characters:0')!
    assert.ok(parent.output_candidate?.checkpoint.raw)
    if (formatCorrection) assert.ok(parent.output_candidate?.checkpoint.correction)
    parent.recovery = 'character-coverage-v1'; parent.failure = { message: 'old coverage bug' }
    f.state.id = 'explicit-resumed-run'
    let characterCalls = 0
    const result = await run(f, async prompt => { if (input(prompt).part.kind === 'characters') characterCalls++; return JSON.stringify(reply(prompt)) })
    assert.equal(characterCalls, 0)
    assert.equal(result.characters.length, 2)
  }
})

test('legacy exact historical prompt and correction replay can recover a complete part even after failure and coverage change the normal prompt', async () => {
  const { f, recorded } = await interrupted(true)
  const parent = f.state.story_work!.tasks.find(task => task.key === 'characters:0')!
  delete parent.output_candidate
  parent.recovery = 'character-coverage-v1'; parent.failure = { message: 'old complete-name coverage bug' }
  let characterCalls = 0, peeks = 0
  const generate: StructuredGenerator = async prompt => { if (input(prompt).part.kind === 'characters') characterCalls++; return JSON.stringify(reply(prompt)) }
  generate.readCompleted = async (prompt, contract) => { peeks++; return recorded.get(JSON.stringify([prompt, contract])) }
  const result = await run(f, generate)
  assert.equal(result.characters.length, 2); assert.equal(characterCalls, 0); assert.equal(peeks, 2)
})

test('a completed-only correction miss retains raw and resumes only the unfinished correction', async () => {
  const f = fixture()
  let interrupted = false, initialCharacterCalls = 0
  await assert.rejects(run(f, async prompt => {
    const value = reply(prompt)
    if (input(prompt).part.kind === 'characters') {
      initialCharacterCalls++
      const person = (value as { characters: Array<{ description?: string; key_attributes?: string }> }).characters[0]!
      person.key_attributes = person.description; delete person.description
    }
    return JSON.stringify(value)
  }, () => {
    const candidate = f.state.story_work?.tasks.find(task => task.key === 'characters:0')?.output_candidate
    if (!interrupted && candidate?.checkpoint.raw) { interrupted = true; throw new Error('interrupted before correction') }
  }), /检查点保存失败/)
  assert.equal(initialCharacterCalls, 1)
  const candidate = f.state.story_work!.tasks.find(task => task.key === 'characters:0')!.output_candidate!
  assert.ok(candidate.checkpoint.raw); assert.equal(candidate.checkpoint.correction, undefined)
  let resumedCharacters = 0, correctionOnly = true
  const generate: StructuredGenerator = async prompt => {
    if (input(prompt).part.kind === 'characters') {
      resumedCharacters++; correctionOnly &&= prompt.includes('【一次格式修正】')
    }
    return JSON.stringify(reply(prompt))
  }
  generate.readCompleted = async () => undefined
  const result = await run(f, generate)
  assert.equal(result.characters.length, 2); assert.equal(resumedCharacters, 1); assert.equal(correctionOnly, true)
})

test('private raw part candidates cannot cross source, model, configuration or task identities', async () => {
  for (const mutation of ['source', 'model', 'configuration', 'task'] as const) {
    const { f } = await interrupted(false)
    if (mutation === 'source') f.source.content += '原文改变'
    if (mutation === 'model') f.state.model_id = 'another-model'
    if (mutation === 'configuration') f.state.configuration_hash = 'another-configuration'
    if (mutation === 'task') f.state.sections[0]!.characters.push({ ...f.state.sections[0]!.characters[0]!, name: '丙午' })
    let characterCalls = 0
    await run(f, async prompt => { if (input(prompt).part.kind === 'characters') characterCalls++; return JSON.stringify(reply(prompt)) })
    assert.ok(characterCalls > 0, mutation)
  }
})

test('completed-only structured probe never falls through to generation on a miss and preserves unknown-state errors', async () => {
  let calls = 0
  const generate: StructuredGenerator = async () => { calls++; return '{"ok":true}' }
  await assert.rejects(generateStructuredOutput('script_source_story_characters', z.object({ ok: z.boolean() }), generate, 'exact', { completedOnly: true }), CompletedOutputReplayMiss)
  generate.readCompleted = async () => { throw Object.assign(new Error('unknown dispatch'), { code: 'source_request_unknown', statusCode: 409 }) }
  await assert.rejects(generateStructuredOutput('script_source_story_characters', z.object({ ok: z.boolean() }), generate, 'exact', { completedOnly: true }), /unknown dispatch/)
  assert.equal(calls, 0)
})

test('a complete but unsupported legacy alias remains rejected rather than becoming a saved parent result', async () => {
  const { f } = await interrupted(false)
  const parent = f.state.story_work!.tasks.find(task => task.key === 'characters:0')!
  delete parent.output_candidate
  parent.failure = { message: 'prior evidence error', evidence: { task_key: 'characters:0', character_name: '甲辰', name: '虚构别名', section_ids: [0], evidence_section_ids: [] } }
  const invalid = (prompt: string) => {
    const value = reply(prompt)
    if (input(prompt).part.kind === 'characters') (value as { characters: Array<{ aliases: string[] }> }).characters[0]!.aliases = ['虚构别名']
    return JSON.stringify(value)
  }
  const generate: StructuredGenerator = async prompt => invalid(prompt)
  generate.readCompleted = async prompt => invalid(prompt)
  await assert.rejects(run(f, generate), /虚构别名.*没有所引章节的原文或目录证据/)
  assert.equal(f.state.story_work!.tasks.find(task => task.key === 'characters:0')!.result, undefined)
  assert.equal(f.state.story_work!.tasks.find(task => task.key === 'characters:0')!.failure!.evidence!.name, '虚构别名')
})

test('an exhausted part retains its original proposal and correction across changing failure text with zero redispatch', async () => {
  const f = fixture(); let uncertaintyCalls = 0
  const generate: StructuredGenerator = async prompt => {
    if (input(prompt).part.kind === 'uncertainties') { uncertaintyCalls++; return '{"uncertainties":[{"description":"原回答仍需核对","section_ids":[8]}]}' }
    return JSON.stringify(reply(prompt))
  }
  await assert.rejects(run(f, generate), /真实且不重复的章节ID/)
  assert.equal(uncertaintyCalls, 2)
  const part = f.state.story_work!.tasks.find(task => task.key === 'uncertainties:0')!, candidate = structuredClone(part.output_candidate!)
  assert.ok(candidate.checkpoint.raw); assert.ok(candidate.checkpoint.correction)
  part.failure = { message: '显示层诊断已经变化' }
  await assert.rejects(run(f, async () => assert.fail('cannot regenerate an exhausted logical task')), /真实且不重复的章节ID/)
  assert.equal(part.output_candidate!.checkpoint.original_raw, candidate.checkpoint.original_raw)
  assert.deepEqual(part.output_candidate!.checkpoint.correction, candidate.checkpoint.correction)
  assert.equal(part.result, undefined)
})
test('an unknown initial part remains guarded across continuation instead of becoming a fresh proposal', async () => {
  const f = fixture(); let calls = 0
  await assert.rejects(run(f, async prompt => {
    if (input(prompt).part.kind === 'characters') { calls++; throw new Error('accepted then disconnected') }
    return JSON.stringify(reply(prompt))
  }), /accepted then disconnected/)
  const part = f.state.story_work!.tasks.find(task => task.key === 'characters:0')!
  assert.ok(part.output_candidate!.checkpoint.initial_started)
  await assert.rejects(run(f, async () => assert.fail('unknown request cannot be resent')), error => (error as any).code === 'structured_initial_delivery_pending')
  assert.equal(calls, 1)
})
