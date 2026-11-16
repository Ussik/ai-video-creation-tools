import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceSection } from '@video-studio/shared/script/script-source-document'
import { synthesizeSourceStory, validateSourceStory } from '../src/modules/script/script-source-story.js'
import { sourceStoryTasks } from '../src/modules/script/script-source-story-plan.js'
import { scriptSourceVersion } from '../src/modules/script/script-source-identity.js'
import { currentModelRequestContext } from '../src/modules/generation/model-task-policy.js'
import { modelAttemptNumber } from '../src/modules/generation/model-execution.js'
import { beginTextRequest, createScriptRequestUsage, isTextRequestBudgetError, withTextRequestUsage } from '../src/infrastructure/providers/text-request-usage.js'

type Character = { name: string; aliases: string[]; description: string; section_ids: number[] }
type Input = { complete_source: boolean; source: { filename: string; content?: string }; character_context?: unknown;
  part: { key: string; kind: string; target_names?: string[]; section_ids?: number[]; merge_candidates?: Character[];
    include_additional_characters?: boolean }; materials: Array<{ section: ScriptSourceSection & { id: number } }> }
const marker = '【全剧整合资料】\n'
const inputFrom = (prompt: string): Input => JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
const signal = () => new AbortController().signal
function fixture() {
  let content = ''
  const sections: ScriptSourceSection[] = []
  for (let id = 0; id < 17; id++) {
    const name = `角色${String(id).padStart(2, '0')}`, opening = `第${id + 1}集，${name}保存信件，最终大家回家。`
    const text = opening + '原文记载城中人物保存全部线索。'.repeat(145) + '\n'
    const evidence = { offset: content.length, quote: opening }
    sections.push({ offset: content.length, length: text.length, title: `第${id + 1}集`, episode_number: id + 1,
      summary: opening, characters: [{ name, description: '保管信件的人物', evidence }],
      events: [{ summary: `${name}保存信件。`, evidence }], open_threads: [] })
    content += text
  }
  const source = { filename: '并发合成剧本.txt', content }
  const state: ScriptSourceAnalysis = { story_work: { input_hash: 'legacy-concurrency-fixture', tasks: [] }, id: 'concurrent-story', source_version: scriptSourceVersion(source), model_id: 'model',
    status: 'running', phase: 'synthesis', completed_chunks: 1, total_chunks: 1, sections, error: null, updated_at: 'now' }
  assert.ok(content.length > 32_000)
  return { state, source }
}
function characters(input: Input, all = false): Character[] {
  if (input.character_context) return ((input.character_context as any).identity_hypotheses as Character[]).filter(c => input.part.target_names!.some(name => [c.name, ...c.aliases].includes(name))).map(c => structuredClone(c))
  return input.materials.flatMap(({ section }) => section.characters.map(character => ({ name: character.name, aliases: [],
    description: '保管信件的人物', section_ids: [section.id] }))).filter(character => all || input.part.target_names!.includes(character.name))
}
function reply(input: Input, changedDescription = false): object {
  const ids = input.materials.map(({ section }) => section.id)
  if (input.part.kind === 'overview') return { summary: '全城保存信件，最后大家回家。', ending: { summary: '大家回家。', section_ids: [ids.at(-1)] }, covered_section_ids: ids }
  if (input.part.kind === 'characters') return { characters: characters(input, input.part.include_additional_characters).map(character =>
    changedDescription && !input.part.include_additional_characters ? { ...character, description: '保管原有信件，最终回家。' } : character),
    ...(input.character_context ? { needs_full_source: false, reason: '' } : {}) }
  if (input.part.kind === 'characters_merge') return { characters: [input.part.merge_candidates![0]], ...(input.character_context ? { needs_full_source: false, reason: '' } : {}) }
  if (input.part.kind === 'timeline') return { covered_section_ids: input.part.section_ids,
    timeline: input.part.section_ids!.map(id => ({ summary: input.materials[id]!.section.events[0]!.summary, section_ids: [id] })) }
  return { [input.part.kind]: [] }
}
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function until(predicate: () => boolean, label: string) {
  for (let count = 0; count < 100 && !predicate(); count++) await setImmediate()
  assert.ok(predicate(), label)
}
async function configured<T>(value: string | undefined, work: () => Promise<T>) {
  const previous = process.env.VIDEO_STUDIO_SOURCE_STORY_CONCURRENCY
  if (value === undefined) delete process.env.VIDEO_STUDIO_SOURCE_STORY_CONCURRENCY
  else process.env.VIDEO_STUDIO_SOURCE_STORY_CONCURRENCY = value
  try { return await work() } finally {
    if (previous === undefined) delete process.env.VIDEO_STUDIO_SOURCE_STORY_CONCURRENCY
    else process.env.VIDEO_STUDIO_SOURCE_STORY_CONCURRENCY = previous
  }
}

test('independent discovery overlaps overview, later scoped characters wait for both, and request concurrency stays at two', () => configured(undefined, async () => {
  const { state, source } = fixture(), controller = new AbortController(), overview = gate(), discovery = gate()
  const started: string[] = [], completed = new Set<string>(), retained = new Set<string>()
  let active = 0, maximum = 0, scoped = 0
  const execution = synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt), key = input.part.key
    started.push(key); maximum = Math.max(maximum, ++active)
    try {
      if (key === 'overview') { assert.equal(input.source.content, source.content); await overview.promise }
      else if (key === 'characters:0') { assert.equal(input.source.content, source.content); await discovery.promise }
      else {
        assert.ok(completed.has('overview') && completed.has('characters:0'), 'base dependency barrier must precede all later packages')
        if (input.character_context) scoped++
        await setImmediate()
      }
      completed.add(key)
      return JSON.stringify(reply(input))
    } finally { active-- }
  }, () => state.story_work?.tasks.forEach(task => { if (task.result !== undefined) retained.add(task.key) }), controller.signal, undefined, 1000, source)
  try {
    await until(() => started.length === 2, 'both independent first-stage requests must start before either resolves')
    assert.deepEqual(started, ['overview', 'characters:0'])
    overview.resolve(); await setImmediate(); assert.equal(started.length, 2)
    discovery.resolve()
    const story = await execution
    assert.equal(maximum, 2); assert.ok(scoped > 0, 'later known-character batch retains its exact evidence context')
    assert.equal(story.characters.length, 17); assert.equal(story.timeline.length, 17)
    assert.deepEqual(story.timeline.map(item => item.section_ids[0]), Array.from({ length: 17 }, (_, id) => id))
    assert.deepEqual(retained, new Set(started)); assert.deepEqual(validateSourceStory(state, story), story)
  } finally { overview.resolve(); discovery.resolve(); controller.abort(); await execution.catch(() => {}) }
}))

test('a first-stage failure waits for its dispatched sibling to persist and resumes without repeating that sibling', () => configured('2', async () => {
  const { state, source } = fixture(), fail = gate(), sibling = gate(), started: string[] = []
  const failure = Object.assign(new TextProviderError('overview local preparation failed', false), { delivery: 'not_sent' })
  let durable = structuredClone(state), finished = false
  const execution = synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt); started.push(input.part.key)
    if (input.part.key === 'overview') { await fail.promise; throw failure }
    assert.equal(input.part.key, 'characters:0'); await sibling.promise
    return JSON.stringify(reply(input))
  }, () => { durable = structuredClone(state) }, signal(), undefined, 1000, source)
  const settlement = execution.then(() => { finished = true }, () => { finished = true })
  await until(() => started.length === 2, 'dispatch both first-stage tasks')
  fail.resolve(); await setImmediate(); await setImmediate(); assert.equal(finished, false)
  sibling.resolve(); await assert.rejects(execution, issue => issue === failure); await settlement
  assert.deepEqual(started, ['overview', 'characters:0'])
  assert.ok(durable.story_work!.tasks.find(task => task.key === 'characters:0')!.result)
  assert.equal(durable.story, undefined)
  const resumed: string[] = []
  const story = await synthesizeSourceStory(durable, async prompt => { const input = inputFrom(prompt); resumed.push(input.part.key); return JSON.stringify(reply(input)) },
    () => {}, signal(), undefined, 1000, source)
  assert.equal(resumed.includes('characters:0'), false); assert.equal(story.characters.length, 17)
}))

test('a later failure stops queued tasks, settles the other active task, and preserves every completed task on continuation', () => configured('2', async () => {
  const { state, source } = fixture(), fail = gate(), sibling = gate(), started: string[] = [], failure = Object.assign(new TextProviderError('later batch local preparation failed', false), { delivery: 'not_sent' })
  let durable = structuredClone(state), finished = false
  const execution = synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt); started.push(input.part.key)
    if (input.part.key === 'characters:1') { await fail.promise; throw failure }
    if (input.part.key === 'timeline:0') await sibling.promise
    return JSON.stringify(reply(input))
  }, () => { durable = structuredClone(state) }, signal(), undefined, 1000, source)
  const settlement = execution.then(() => { finished = true }, () => { finished = true })
  await until(() => started.includes('characters:1') && started.includes('timeline:0'), 'start the first two later tasks')
  fail.resolve(); await setImmediate(); await setImmediate(); assert.equal(finished, false)
  sibling.resolve(); await assert.rejects(execution, issue => issue === failure); await settlement
  assert.deepEqual(started, ['overview', 'characters:0', 'characters:1', 'timeline:0'])
  const completed = durable.story_work!.tasks.filter(task => task.result !== undefined).map(task => task.key)
  assert.deepEqual(completed, ['overview', 'characters:0', 'timeline:0'])
  const resumed: string[] = []
  await synthesizeSourceStory(durable, async prompt => { const input = inputFrom(prompt); resumed.push(input.part.key); return JSON.stringify(reply(input)) },
    () => {}, signal(), undefined, 1000, source)
  for (const key of completed) assert.equal(resumed.includes(key), false, `${key} must remain checkpointed`)
}))

test('concurrency one retains the original sequential request order', () => configured('1', async () => {
  const { state, source } = fixture(), started: string[] = []
  let active = 0, maximum = 0
  await synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt); started.push(input.part.key); maximum = Math.max(maximum, ++active)
    await setImmediate(); active--; return JSON.stringify(reply(input))
  }, () => {}, signal(), undefined, 1000, source)
  assert.equal(maximum, 1); assert.deepEqual(started, sourceStoryTasks(state).map(task => task.key))
}))

test('parallel branches retain isolated attempt scopes and reserve one shared workflow budget before dispatch', () => configured('2', async () => {
  const { state, source } = fixture(), usage = createScriptRequestUsage(), attempts: Array<{ key: string; count?: number; stage?: string }> = []
  let durable = structuredClone(state), dispatches = 0
  const request = async (prompt: string) => {
    const input = inputFrom(prompt)
    const reservation = beginTextRequest({ request_bytes: 10, estimated_input_tokens: 10, reserved_output_tokens: 100 })
    reservation.identify(input.part.key); dispatches++
    await setImmediate()
    const context = currentModelRequestContext()
    attempts.push({ key: input.part.key, count: modelAttemptNumber(), stage: context?.operationStage })
    assert.equal(context?.policy.readOnly, true)
    reservation.complete({ input_tokens: 10, output_tokens: 10 })
    return JSON.stringify(reply(input))
  }
  await assert.rejects(withTextRequestUsage({ usage, limits: { max_requests: 2, max_tokens: 10000 } }, () =>
    synthesizeSourceStory(state, request, () => { durable = structuredClone(state) }, signal(), undefined, 1000, source)), isTextRequestBudgetError)
  assert.equal(dispatches, 2); assert.equal(usage.requests, 2); assert.equal(usage.input_tokens, 20); assert.equal(usage.output_tokens, 20)
  assert.deepEqual(attempts, [{ key: 'overview', count: 1, stage: 'source_synthesis' }, { key: 'characters:0', count: 1, stage: 'source_characters' }])
  assert.ok(durable.story_work!.tasks.find(task => task.key === 'overview')!.result)
  assert.ok(durable.story_work!.tasks.find(task => task.key === 'characters:0')!.result)
}))

test('character merging starts after durable base results and respects the shared concurrency bound', () => configured('2', async () => {
  const { state, source } = fixture(), baseKeys = sourceStoryTasks(state).map(task => task.key), durable = new Set<string>()
  let merges = 0, activeMerges = 0, maximumMerges = 0
  const story = await synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt)
    if (input.part.kind === 'characters_merge') {
      merges++; maximumMerges = Math.max(maximumMerges, ++activeMerges)
      for (const key of baseKeys) assert.ok(durable.has(key), `${key} must be durable before merge`)
    }
    await setImmediate()
    if (input.part.kind === 'characters_merge') activeMerges--
    return JSON.stringify(reply(input, true))
  }, () => state.story_work?.tasks.forEach(task => { if (task.result !== undefined) durable.add(task.key) }), signal(), undefined, 1000, source)
  assert.ok(merges > 0); assert.ok(maximumMerges >= 1 && maximumMerges <= 2); assert.deepEqual(validateSourceStory(state, story), story)
}))
