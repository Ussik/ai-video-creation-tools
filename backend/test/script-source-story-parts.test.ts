import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { ScriptSourceAnalysis, ScriptSourceSection } from '@video-studio/shared/script/script-source-document'
import { synthesizeSourceStory, validateSourceStory } from '../src/modules/script/script-source-story.js'
import { sourceStoryTasks } from '../src/modules/script/script-source-story-plan.js'

type Character = { name: string; aliases: string[]; description: string; section_ids: number[] }
type Input = {
  source: { filename: string; content: string }
  materials: Array<{ covered_section_ids: number[]; section: ScriptSourceSection & { id: number } }>
  part: { key: string; kind: 'overview' | 'characters' | 'characters_merge' | 'timeline' | 'threads' | 'uncertainties'; target_names?: string[]; section_ids?: number[]; merge_candidates?: Character[]; include_additional_characters?: boolean }
}
const signal = () => new AbortController().signal
function manuscript(extra: Record<number, string> = {}) {
  const sections: ScriptSourceSection[] = []
  let content = ''
  for (let id = 0; id < 59; id++) {
    const opening = `第${id + 1}集：角色${id}听见钟声。${id === 0 ? '林舟埋下信物，决定调查停摆之城。' : id === 58 ? '林舟又名阿舟；阿舟归还开篇信物，城市恢复，最终众人回家。' : id === 24 ? '资料未交代城内钟楼由谁修复。' : '调查继续，人物保留前集行动的后果。'}`
    const text = `${opening}${extra[id] || ''}\n${'城市仍在等待钟声，人物依照线索行动。'.repeat(45)}\n`
    const evidence = { offset: content.length, quote: opening }
    sections.push({ offset: content.length, length: text.length, title: `第${id + 1}集`, episode_number: id + 1, summary: opening,
      characters: [{ name: `角色${id}`, description: `第${id + 1}集出现的人物`, evidence },
        ...(id === 0 ? [{ name: '林舟', description: '主角', evidence }] : id === 58 ? [{ name: '阿舟', description: '林舟的明示别名', evidence }] : [])],
      events: [{ summary: `角色${id}听见钟声`, evidence }, { summary: id === 58 ? '阿舟归还开篇信物，城市恢复，众人回家' : `第${id + 1}集调查推进并留下后果`, evidence }],
      open_threads: id === 0 ? ['信物为何遗失'] : [] })
    content += text
  }
  const state: ScriptSourceAnalysis = { id: 'long-story', source_version: 'source-1', model_id: 'model', status: 'running', phase: 'synthesis',
    completed_chunks: 1, total_chunks: 1, sections, error: null, updated_at: 'now' }
  assert.ok(content.length > 32_000)
  return { state, source: { filename: '全城停在零点后59集.txt', content } }
}
function inputFrom(prompt: string): Input {
  const marker = '【全剧整合资料】\n'
  return JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
}
function reply(input: Input): object {
  const ids = input.materials.map(item => item.section.id)
  if (input.part.kind === 'overview') return { covered_section_ids: ids, summary: '林舟调查停摆之城；后半部揭示阿舟身份，归还开篇信物后众人回家。',
    ending: { summary: '阿舟归还开篇信物，城市恢复，众人回家。', section_ids: [58] } }
  if (input.part.kind === 'characters_merge') {
    const candidates = input.part.merge_candidates!, first = candidates[0]!
    return { characters: [{ name: first.name,
      aliases: [...new Set(candidates.flatMap(character => [character.name, ...character.aliases]))].filter(name => name !== first.name),
      description: [...new Set(candidates.map(character => character.description))].join('；'),
      section_ids: [...new Set(candidates.flatMap(character => character.section_ids))].sort((a, b) => a - b) }] }
  }
  if (input.part.kind === 'characters') return { characters: input.part.target_names!.map(name => {
    if (name === '林舟' || name === '阿舟') return { name: '林舟', aliases: ['阿舟'], description: '原文明示为同一主角', section_ids: [0, 58] }
    return { name, aliases: [], description: `原稿人物${name}`, section_ids: input.materials.filter(item => item.section.characters.some(character => character.name === name)).map(item => item.section.id) }
  }) }
  if (input.part.kind === 'timeline') return { covered_section_ids: input.part.section_ids, timeline: input.part.section_ids!.map(id => ({
    summary: input.materials[id]!.section.events.map(event => event.summary).join('；'), section_ids: id === 58 ? [0, 58] : [id],
  })) }
  if (input.part.kind === 'uncertainties') return { uncertainties: input.part.section_ids!.includes(24)
    ? [{ description: '原稿未说明钟楼修复者，结尾仍未解释。', section_ids: [24, 58] }] : [] }
  return { threads: input.part.section_ids!.includes(0) ? [{ setup: '开篇遗失信物', payoff: '终集阿舟归还信物并恢复城市，收回开篇铺垫', section_ids: [0, 58] }] : [] }
}

test('dense long-story tasks each retain the full manuscript and directory while preserving all names, events and final payoffs', async () => {
  const { state, source } = manuscript(), tasks: string[] = [], progress: string[] = []
  const savedTaskKeys = new Set<string>()
  const story = await synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt)
    assert.equal(input.source.content, source.content)
    assert.equal(input.materials.length, 59)
    assert.deepEqual(input.materials.map(item => item.section.id), state.sections.map((_, id) => id))
    assert.match(prompt, /不把原文切片理解/)
    tasks.push(input.part.key)
    return JSON.stringify(reply(input))
  }, () => {
    state.story_work?.tasks.forEach(task => { if (task.result !== undefined) savedTaskKeys.add(task.key) })
  }, signal(), message => { if (message) progress.push(message) }, 1000, source)
  assert.ok(tasks.filter(key => key.startsWith('characters:')).length > 1)
  const timelineCount = tasks.filter(key => key.startsWith('timeline:')).length
  const threadCount = tasks.filter(key => key.startsWith('threads:')).length
  const uncertaintyCount = tasks.filter(key => key.startsWith('uncertainties:')).length
  assert.ok(timelineCount < 5); assert.ok(threadCount < 5); assert.ok(uncertaintyCount < 5)
  assert.ok(tasks.length < 1 + Math.ceil(60 / 12) + 5 * 3, 'dynamic response planning makes fewer full-source tasks than fixed twelve-section batches')
  assert.equal(tasks[0], 'overview'); assert.equal(tasks.at(-1), `uncertainties:${uncertaintyCount - 1}`)
  assert.equal(story.characters.length, 60)
  assert.deepEqual(story.characters.find(character => character.name === '林舟')!.aliases, ['阿舟'])
  assert.equal(story.timeline.length, 59)
  assert.match(story.timeline.at(-1)!.summary, /众人回家/)
  assert.deepEqual(story.timeline.at(-1)!.section_ids, [0, 58])
  assert.deepEqual(story.threads[0]!.section_ids, [0, 58]); assert.match(story.threads[0]!.payoff!, /恢复城市/)
  assert.match(story.ending.summary, /城市恢复/)
  assert.equal(story.uncertainties.length, 1); assert.deepEqual(story.uncertainties[0]!.section_ids, [24, 58])
  assert.equal(state.story_work, undefined); assert.deepEqual(savedTaskKeys, new Set(tasks))
  assert.equal(progress.length, tasks.length)
  assert.deepEqual(validateSourceStory(state, story), story)
})

test('dynamic task groups are deterministic, cover every section exactly once, and normalize equivalent character names', () => {
  const { state } = manuscript()
  state.sections[0]!.characters.push({ name: '林舟', description: '重复目录名', evidence: state.sections[0]!.characters[0]!.evidence })
  state.sections[1]!.characters.push({ name: '林舟'.normalize('NFD'), description: '兼容形式的重复目录名', evidence: state.sections[1]!.characters[0]!.evidence })
  const first = sourceStoryTasks(state), second = sourceStoryTasks(state)
  assert.deepEqual(first, second)
  assert.equal(first.filter(task => task.kind === 'characters').flatMap(task => task.target_names!).filter(name => name.normalize('NFKC') === '林舟').length, 1)
  for (const kind of ['timeline', 'threads', 'uncertainties'] as const) {
    const sections = first.filter(task => task.kind === kind).flatMap(task => task.section_ids!)
    assert.deepEqual(sections, state.sections.map((_, id) => id))
  }
  assert.ok(first.length < sourceStoryTasks(state, true).length)
})

test('identical cross-group threads and uncertainties consolidate source references without dropping facts', async () => {
  const { state, source } = manuscript()
  let threadCopies = 0, uncertaintyCopies = 0
  const story = await synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt), value = reply(input) as Record<string, unknown>
    if (input.part.kind === 'threads' && input.part.section_ids!.includes(0)) {
      threadCopies++
      value.threads = [{ setup: '开篇遗失信物', payoff: '终集阿舟归还信物并恢复城市，收回开篇铺垫', section_ids: [0, 58] }]
    }
    if (input.part.kind === 'threads' && input.part.section_ids!.includes(58)) {
      threadCopies++
      value.threads = [{ setup: '开篇遗失信物', payoff: '终集阿舟归还信物并恢复城市，收回开篇铺垫', section_ids: [0, 58] }]
    }
    if (input.part.kind === 'uncertainties' && input.part.section_ids!.includes(24)) {
      uncertaintyCopies++
      value.uncertainties = [{ description: '原稿未说明钟楼修复者，结尾仍未解释。', section_ids: [24, 58] }]
    }
    if (input.part.kind === 'uncertainties' && input.part.section_ids!.includes(58)) {
      uncertaintyCopies++
      value.uncertainties = [{ description: '原稿未说明钟楼修复者，结尾仍未解释。', section_ids: [24, 58] }]
    }
    return JSON.stringify(value)
  }, () => {}, signal(), undefined, 1000, source)
  assert.ok(threadCopies >= 2); assert.ok(uncertaintyCopies >= 2)
  assert.equal(story.threads.length, 1)
  assert.deepEqual(story.threads[0]!.section_ids, [0, 58])
  assert.equal(story.uncertainties.length, 1)
  assert.deepEqual(story.uncertainties[0]!.section_ids, [24, 58])
})

test('results beyond the public story contract fail explicitly with every completed fact checkpointed', async () => {
  const { state, source } = manuscript()
  let generatedUncertainties = 0, calls = 0
  await assert.rejects(synthesizeSourceStory(state, async prompt => {
    calls++
    const input = inputFrom(prompt), value = reply(input) as Record<string, unknown>
    if (input.part.kind === 'uncertainties') {
      const items = Array.from({ length: input.part.key === 'uncertainties:0' ? 100 : 101 }, (_, index) => ({
        description: `仅此一处保留的未解事实 ${input.part.key} ${index}`,
        section_ids: [input.part.section_ids![index % input.part.section_ids!.length]!],
      }))
      generatedUncertainties += items.length
      value.uncertainties = items
    }
    return JSON.stringify(value)
  }, () => {}, signal(), undefined, 1000, source), /Too big|200|uncertainties/i)
  assert.equal(state.story, undefined)
  const saved = state.story_work!.tasks.filter(task => task.key.startsWith('uncertainties:') && task.result)
    .flatMap(task => (task.result as { uncertainties: unknown[] }).uncertainties)
  assert.equal(generatedUncertainties, 201)
  assert.equal(saved.length, 201, 'no task result is sliced to satisfy the final schema')
  const beforeRetry = calls
  await assert.rejects(synthesizeSourceStory(state, async () => { calls++; throw new Error('completed facts must not be regenerated') }, () => {}, signal(), undefined, 1000, source), /Too big|200|uncertainties/i)
  assert.equal(calls, beforeRetry)
})

test('known people repeated across batches retain verified facts and merge without a correction or duplicate identity', async () => {
  const { state, source } = manuscript(), calls = new Map<string, number>()
  const story = await synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt)
    calls.set(input.part.key, (calls.get(input.part.key) || 0) + 1)
    const value = reply(input) as { characters?: Array<{ name: string; aliases: string[]; description: string; section_ids: number[] }> }
    if (input.part.key === 'characters:0') value.characters!.push({ name: '角色20', aliases: [], description: '首批补充的人物事实', section_ids: [20] })
    if (input.part.key === 'characters:1') value.characters!.push(
      { name: '角色0', aliases: [], description: '后批补充的人物事实', section_ids: [0] },
      { name: '林舟', aliases: ['阿舟'], description: '身份跨批保留', section_ids: [0, 58] })
    return JSON.stringify(value)
  }, () => {}, signal(), undefined, 1000, source)
  assert.ok([...calls.values()].every(count => count === 1), 'a known person outside the requested batch must not trigger correction')
  assert.equal(story.characters.length, 60)
  assert.match(story.characters.find(character => character.name === '角色20')!.description, /首批补充的人物事实/)
  assert.match(story.characters.find(character => character.name === '角色0')!.description, /后批补充的人物事实/)
  const main = story.characters.filter(character => character.name === '林舟')
  assert.equal(main.length, 1); assert.deepEqual(main[0]!.aliases, ['阿舟'])
  assert.deepEqual(main[0]!.section_ids, [0, 58]); assert.match(main[0]!.description, /身份跨批保留/)
})

test('a known alias can use cited original text even when the directory lists that alias only in another chapter', async () => {
  const { state, source } = manuscript({ 0: '林舟又名阿舟。' })
  assert.equal(state.sections[0]!.characters.some(character => character.name === '阿舟'), false)
  let firstBatchCalls = 0
  const story = await synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt)
    const value = reply(input) as { characters?: Array<{ name: string; aliases: string[]; section_ids: number[] }> }
    if (input.part.key === 'characters:0') {
      firstBatchCalls++
      value.characters!.find(character => character.name === '林舟')!.section_ids = [0]
    }
    return JSON.stringify(value)
  }, () => {}, signal(), undefined, 1000, source)
  assert.equal(firstBatchCalls, 1, 'directory omissions must not trigger a correction when the cited original has the alias')
  assert.deepEqual(story.characters.find(character => character.name === '林舟')!.aliases, ['阿舟'])
})

test('one correction receives exact name evidence locations without silently accepting wrong chapter references', async () => {
  const { state, source } = manuscript()
  let firstBatchCalls = 0
  const story = await synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt)
    const value = reply(input) as { characters?: Array<{ name: string; aliases: string[]; section_ids: number[] }> }
    if (input.part.key === 'characters:0') {
      firstBatchCalls++
      if (firstBatchCalls === 1) value.characters!.find(character => character.name === '林舟')!.section_ids = [0]
      else {
        assert.match(prompt, /姓名或别名「阿舟」没有所引章节/)
        assert.match(prompt, /已引用章节ID：0「第1集」/)
        assert.match(prompt, /可核验该名称的章节ID：58「第59集」/)
        assert.match(prompt, /名称出现不代表属于同一人物/)
      }
    }
    return JSON.stringify(value)
  }, () => {}, signal(), undefined, 1000, source)
  assert.equal(firstBatchCalls, 2)
  assert.deepEqual(story.characters.find(character => character.name === '林舟')!.section_ids, [0, 58])
})

test('a failed alias reference retains precise private diagnostics through serialization and clears them only after recovery', async () => {
  const { state, source } = manuscript(), calls = new Map<string, number>()
  let invalid = true, stopAfterRecovery = false
  const generate = async (prompt: string) => {
    const input = inputFrom(prompt) as Input & { previous_failure?: { message: string; evidence?: unknown } }
    calls.set(input.part.key, (calls.get(input.part.key) || 0) + 1)
    if (stopAfterRecovery && input.part.key === 'timeline:0') throw new Error('测试暂停以检查成功任务的诊断清理')
    const value = reply(input) as { characters?: Array<{ name: string; aliases: string[]; section_ids: number[] }> }
    if (input.part.key === 'characters:0') {
      if (invalid) value.characters!.find(character => character.name === '林舟')!.section_ids = [0]
      else {
        assert.match(input.previous_failure!.message, /阿舟/)
        assert.deepEqual(input.previous_failure!.evidence, { task_key: 'characters:0', character_name: '林舟', name: '阿舟', section_ids: [0], evidence_section_ids: [58] })
      }
    }
    return JSON.stringify(value)
  }
  await assert.rejects(synthesizeSourceStory(state, generate, () => {}, signal(), undefined, 1000, source), /阿舟.*没有所引章节/)
  const restored = JSON.parse(JSON.stringify(state)) as ScriptSourceAnalysis
  const failed = restored.story_work!.tasks.find(task => task.key === 'characters:0')!
  assert.equal(failed.result, undefined)
  assert.deepEqual(failed.failure!.evidence, { task_key: 'characters:0', character_name: '林舟', name: '阿舟', section_ids: [0], evidence_section_ids: [58] })
  assert.equal('raw_output' in failed.failure!, false)
  assert.equal(JSON.stringify(failed).includes('城市仍在等待钟声'), false, 'diagnostics must not retain manuscript/model output')
  invalid = false; stopAfterRecovery = true
  await assert.rejects(synthesizeSourceStory(restored, generate, () => {}, signal(), undefined, 1000, source), /测试暂停/)
  assert.equal(calls.get('overview'), 1); assert.equal(calls.get('characters:0'), 3)
  assert.equal(failed.failure, undefined); assert.ok(failed.result)
  stopAfterRecovery = false
  const story = await synthesizeSourceStory(restored, generate, () => {}, signal(), undefined, 1000, source)
  assert.equal(calls.get('characters:0'), 3); assert.equal(restored.story_work, undefined)
  assert.deepEqual(story.characters.find(character => character.name === '林舟')!.aliases, ['阿舟'])
})

test('evidence failure persistence does not replace the original validation error or write after cancellation', async () => {
  for (const cancel of [false, true]) {
    const { state, source } = manuscript(), controller = new AbortController()
    let failureWrites = 0, requests = 0
    const expected = new Error('已停止人物任务')
    const run = () => synthesizeSourceStory(state, async prompt => {
      const input = inputFrom(prompt), value = reply(input) as { characters?: Array<{ name: string; section_ids: number[] }> }
      if (input.part.key === 'characters:0') {
        requests++
        if (cancel) { controller.abort(expected); throw expected }
        value.characters!.find(character => character.name === '林舟')!.section_ids = [0]
      }
      return JSON.stringify(value)
    }, () => {
      assert.equal(controller.signal.aborted, false, 'failure recording cannot persist after cancellation')
      if (state.story_work?.tasks.some(task => task.failure)) { failureWrites++; throw new Error('诊断持久化失败') }
    }, controller.signal, undefined, 1000, source)
    await assert.rejects(run(), error => cancel ? error === expected : error instanceof Error && /阿舟.*没有所引章节/.test(error.message))
    assert.equal(requests, cancel ? 1 : 2)
    assert.equal(state.story, undefined); assert.equal(failureWrites, cancel ? 0 : 1)
  }
})

test('a correction transport failure retains the preceding alias evidence diagnostic for the next explicit resume', async () => {
  const { state, source } = manuscript()
  let firstBatchCalls = 0, resume = false
  const generate = async (prompt: string) => {
    const input = inputFrom(prompt) as Input & { previous_failure?: { message: string; evidence?: { name: string; evidence_section_ids: number[] } } }
    const value = reply(input) as { characters?: Array<{ name: string; section_ids: number[] }> }
    if (input.part.key === 'characters:0') {
      firstBatchCalls++
      if (!resume) {
        if (firstBatchCalls === 2) throw new Error('自动修正请求连接中断')
        value.characters!.find(character => character.name === '林舟')!.section_ids = [0]
      } else {
        assert.match(input.previous_failure!.message, /自动修正请求连接中断/)
        assert.equal(input.previous_failure!.evidence!.name, '阿舟')
        assert.deepEqual(input.previous_failure!.evidence!.evidence_section_ids, [58])
      }
    }
    return JSON.stringify(value)
  }
  await assert.rejects(synthesizeSourceStory(state, generate, () => {}, signal(), undefined, 1000, source), /自动修正请求连接中断/)
  const restored = JSON.parse(JSON.stringify(state)) as ScriptSourceAnalysis
  assert.equal(restored.story_work!.tasks.find(task => task.key === 'characters:0')!.failure!.evidence!.name, '阿舟')
  resume = true
  const story = await synthesizeSourceStory(restored, generate, () => {}, signal(), undefined, 1000, source)
  assert.equal(firstBatchCalls, 3); assert.equal(restored.story_work, undefined)
  assert.deepEqual(story.characters.find(character => character.name === '林舟')!.aliases, ['阿舟'])
})

test('a compatible v3 checkpoint resumes the failed batch without repeating completed character or overview work', async () => {
  const { state, source } = manuscript(), calls = new Map<string, number>()
  const legacyTasks = sourceStoryTasks(state, true)
  state.story_work = { input_hash: createHash('sha256').update(JSON.stringify(['source-story-parts-v3', state.source_version, source, state.sections])).digest('hex'),
    tasks: legacyTasks.map(task => ({ key: task.key })) }
  let stop = true
  const generate = async (prompt: string) => {
    const input = inputFrom(prompt)
    calls.set(input.part.key, (calls.get(input.part.key) || 0) + 1)
    if (stop && input.part.key === 'characters:1') throw new Error('旧版本人物任务中断')
    const value = reply(input) as { characters?: Array<{ name: string; aliases: string[]; description: string; section_ids: number[] }> }
    if (input.part.key === 'characters:1') value.characters!.push({ name: '角色0', aliases: [], description: '后续批次补充', section_ids: [0] })
    return JSON.stringify(value)
  }
  await assert.rejects(synthesizeSourceStory(state, generate, () => {}, signal(), undefined, 1000, source), /旧版本人物任务中断/)
  assert.equal(state.story_work!.input_hash, createHash('sha256').update(JSON.stringify(['source-story-parts-v3', state.source_version, source, state.sections])).digest('hex'))
  const restored = JSON.parse(JSON.stringify(state)) as ScriptSourceAnalysis
  stop = false
  const story = await synthesizeSourceStory(restored, generate, () => {}, signal(), undefined, 1000, source)
  assert.equal(calls.get('overview'), 1); assert.equal(calls.get('characters:0'), 1); assert.equal(calls.get('characters:1'), 2)
  assert.match(story.characters.find(character => character.name === '角色0')!.description, /后续批次补充/)
  assert.equal(restored.story_work, undefined)
})

test('source-only independent discoveries remain confined to the first character task with specific correction diagnostics', async () => {
  for (const batch of ['characters:0', 'characters:1']) {
    const { state, source } = manuscript()
    const added = '守钟人送大家回家。'
    source.content += added; state.sections.at(-1)!.length += added.length
    let affectedCalls = 0
    const run = () => synthesizeSourceStory(state, async prompt => {
      const input = inputFrom(prompt)
      const value = reply(input) as { characters?: Array<{ name: string; aliases: string[]; description: string; section_ids: number[] }> }
      if (input.part.key === batch) {
        affectedCalls++
        if (affectedCalls === 2) {
          assert.match(prompt, /人物任务「characters:1」新增了目录之外的独立人物「守钟人」/)
          assert.match(prompt, /本批目标：角色11/)
        }
        value.characters!.push({ name: '守钟人', aliases: [], description: '原文存在但目录未列出的人物', section_ids: [58] })
      }
      return JSON.stringify(value)
    }, () => {}, signal(), undefined, 1000, source)
    if (batch === 'characters:0') {
      const story = await run()
      assert.equal(affectedCalls, 1); assert.equal(story.characters.length, 61)
      assert.deepEqual(story.characters.find(character => character.name === '守钟人')!.section_ids, [58])
    } else {
      await assert.rejects(run(), /characters:1.*守钟人.*本批目标/)
      assert.equal(affectedCalls, 2); assert.equal(state.story, undefined)
    }
  }
})

test('accepting known cross-batch people cannot hide invalid evidence, invented aliases or invalid chapter IDs', async t => {
  for (const issue of ['wrong_evidence', 'invented_alias', 'invalid_id', 'duplicate_id'] as const) await t.test(issue, async () => {
    const { state, source } = manuscript()
    let attempts = 0
    await assert.rejects(synthesizeSourceStory(state, async prompt => {
      const input = inputFrom(prompt)
      const value = reply(input) as { characters?: Array<{ name: string; aliases: string[]; description: string; section_ids: number[] }> }
      if (input.part.key === 'characters:0') {
        attempts++
        const extra = { name: '角色20', aliases: [] as string[], description: '其他批次的目录人物', section_ids: [20] }
        if (issue === 'wrong_evidence') extra.section_ids = [0]
        if (issue === 'invented_alias') extra.aliases = ['原文没有的别名']
        if (issue === 'invalid_id') extra.section_ids = [999]
        if (issue === 'duplicate_id') extra.section_ids = [20, 20]
        value.characters!.push(extra)
        if (attempts === 2 && (issue === 'wrong_evidence' || issue === 'invented_alias')) {
          assert.match(prompt, /人物任务「characters:0」中「角色20」/)
        }
      }
      return JSON.stringify(value)
    }, () => {}, signal(), undefined, 1000, source), issue === 'wrong_evidence' || issue === 'invented_alias'
      ? /characters:0.*角色20.*没有所引章节.*证据/ : /真实且不重复的章节ID/)
    assert.equal(attempts, 2); assert.equal(state.story, undefined)
    assert.equal(state.story_work!.tasks.find(task => task.key === 'characters:0')!.result, undefined)
    assert.equal(state.story_work!.tasks.some(task => task.key.includes('/coverage:')), false, 'evidence and identity errors cannot use coverage recovery')
  })
})

test('a twelve-name batch that repeatedly omits seven targets recovers with small full-source tasks despite known people from other batches', async () => {
  const { state, source } = manuscript(), calls = new Map<string, number>(), children: Input['part'][] = []
  let parentTargets: string[] = []
  const story = await synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt)
    calls.set(input.part.key, (calls.get(input.part.key) || 0) + 1)
    const value = reply(input) as { characters?: Character[] }
    if (input.part.key === 'characters:1') {
      parentTargets = input.part.target_names!
      value.characters = value.characters!.slice(0, 5)
      value.characters.push({ name: '角色0', aliases: [], description: '原稿人物角色0', section_ids: [0] })
    }
    if (input.part.key.startsWith('characters:1/coverage:')) {
      assert.equal(input.source.content, source.content, 'smaller output scope still reads the complete manuscript')
      assert.equal(input.materials.length, state.sections.length)
      assert.equal(input.part.kind, 'characters')
      assert.equal(input.part.target_names!.length, 3)
      assert.equal(input.part.include_additional_characters, false)
      children.push(input.part)
    }
    return JSON.stringify(value)
  }, () => {}, signal(), undefined, 1000, source)
  assert.equal(parentTargets.length, 12)
  assert.equal(calls.get('characters:1'), 2, 'only the normal bounded correction retries the original batch')
  assert.deepEqual(children.map(part => part.key), Array.from({ length: 4 }, (_, index) => `characters:1/coverage:${index}`))
  assert.deepEqual(children.flatMap(part => part.target_names!), parentTargets)
  assert.ok(children.every(part => calls.get(part.key) === 1))
  const represented = new Set(story.characters.flatMap(character => [character.name, ...character.aliases]))
  assert.ok(parentTargets.every(name => represented.has(name)))
  assert.equal(story.characters.length, 60)
  assert.equal(state.story_work, undefined)
})

test('coverage recovery narrows three-name failures to single-name full-source tasks and retains first-discovery ownership', async () => {
  const { state, source } = manuscript(), calls = new Map<string, number>(), parts: Input['part'][] = []
  const story = await synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt)
    calls.set(input.part.key, (calls.get(input.part.key) || 0) + 1)
    const value = reply(input) as { characters?: Character[] }
    if (input.part.key === 'characters:0' || input.part.key.startsWith('characters:0/coverage:')) {
      parts.push(input.part)
      assert.equal(input.source.content, source.content)
      if (input.part.target_names!.length > 1) value.characters = value.characters!.slice(0, 1)
    }
    return JSON.stringify(value)
  }, () => {}, signal(), undefined, 1000, source)
  const uniqueParts = [...new Map(parts.map(part => [part.key, part])).values()]
  const triples = uniqueParts.filter(part => part.target_names!.length === 3)
  const singles = uniqueParts.filter(part => part.target_names!.length === 1)
  assert.equal(calls.get('characters:0'), 2)
  assert.equal(triples.length, 4); assert.equal(singles.length, 12)
  assert.ok(triples.every(part => calls.get(part.key) === 2))
  assert.ok(singles.every(part => calls.get(part.key) === 1))
  assert.deepEqual(singles.flatMap(part => part.target_names!), uniqueParts[0]!.target_names)
  assert.deepEqual(uniqueParts.filter(part => part.include_additional_characters).map(part => part.key),
    ['characters:0', 'characters:0/coverage:0', 'characters:0/coverage:0/coverage:0'])
  assert.equal(story.characters.length, 60)
})

test('coverage recovery survives child failure or cancellation without repeating completed siblings or the original batch', async t => {
  for (const interruption of ['failure', 'cancellation'] as const) await t.test(interruption, async () => {
    const { state, source } = manuscript(), calls = new Map<string, number>()
    const controller = new AbortController(), interrupted = new Error(`coverage child ${interruption}`)
    let stop = true
    const generate = async (prompt: string) => {
      const input = inputFrom(prompt)
      calls.set(input.part.key, (calls.get(input.part.key) || 0) + 1)
      if (stop && input.part.key === 'characters:1/coverage:1') {
        if (interruption === 'cancellation') controller.abort(interrupted)
        throw interrupted
      }
      const value = reply(input) as { characters?: Character[] }
      if (input.part.key === 'characters:1') value.characters = value.characters!.slice(0, 5)
      return JSON.stringify(value)
    }
    await assert.rejects(synthesizeSourceStory(state, generate, () => {}, controller.signal, undefined, 1000, source), error => error === interrupted)
    const restored = JSON.parse(JSON.stringify(state)) as ScriptSourceAnalysis
    const parent = restored.story_work!.tasks.find(task => task.key === 'characters:1')!
    assert.equal((parent as { recovery?: string }).recovery, 'character-coverage-v1')
    assert.equal(parent.result, undefined)
    assert.ok(restored.story_work!.tasks.find(task => task.key === 'characters:1/coverage:0')!.result)
    assert.equal(restored.story_work!.tasks.find(task => task.key === 'characters:1/coverage:1')!.result, undefined)
    stop = false
    const story = await synthesizeSourceStory(restored, generate, () => {}, signal(), undefined, 1000, source)
    assert.equal(calls.get('overview'), 1); assert.equal(calls.get('characters:0'), 1)
    assert.equal(calls.get('characters:1'), 2); assert.equal(calls.get('characters:1/coverage:0'), 1)
    assert.equal(calls.get('characters:1/coverage:1'), 2)
    assert.equal(story.characters.length, 60); assert.equal(restored.story_work, undefined)
  })
})

test('legacy saved coverage failure enters small-task recovery without another whole-batch request', async () => {
  const { state, source } = manuscript(), calls = new Map<string, number>()
  let stop = true, targets: string[] = []
  const generate = async (prompt: string) => {
    const input = inputFrom(prompt)
    calls.set(input.part.key, (calls.get(input.part.key) || 0) + 1)
    if (input.part.key === 'characters:1') {
      targets = input.part.target_names!
      if (stop) throw new Error('old character batch stopped')
      assert.fail('a recorded terminal coverage failure must not rerun the same twelve-name request')
    }
    return JSON.stringify(reply(input))
  }
  await assert.rejects(synthesizeSourceStory(state, generate, () => {}, signal(), undefined, 1000, source), /old character batch stopped/)
  const restored = JSON.parse(JSON.stringify(state)) as ScriptSourceAnalysis
  const parent = restored.story_work!.tasks.find(task => task.key === 'characters:1')!
  parent.failure = { message: `模型结果不符合 script_source_story_characters 契约（已修正一次）：人物任务「characters:1」遗漏了目录已有证据的姓名或别名：${targets.slice(5).join('、')}；必须完整覆盖本批目标，其他批次人物不能替代缺失项` }
  stop = false
  const story = await synthesizeSourceStory(restored, generate, () => {}, signal(), undefined, 1000, source)
  assert.equal(calls.get('characters:1'), 1)
  assert.equal(calls.get('overview'), 1); assert.equal(calls.get('characters:0'), 1)
  assert.ok(Array.from({ length: 4 }, (_, index) => calls.get(`characters:1/coverage:${index}`) === 1).every(Boolean))
  assert.equal(story.characters.length, 60)
})

test('single-name coverage failure remains unresolved and never substitutes a different known character', async () => {
  const { state, source } = manuscript(), calls = new Map<string, number>()
  await assert.rejects(synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt)
    calls.set(input.part.key, (calls.get(input.part.key) || 0) + 1)
    const value = reply(input) as { characters?: Character[] }
    if (input.part.key === 'characters:1' || input.part.key.startsWith('characters:1/coverage:')) {
      value.characters = [{ name: '角色0', aliases: [], description: '原稿人物角色0', section_ids: [0] }]
    }
    return JSON.stringify(value)
  }, () => {}, signal(), undefined, 1000, source), /characters:1\/coverage:0\/coverage:0.*遗漏.*姓名或别名/)
  assert.equal(state.story, undefined)
  assert.equal(calls.get('characters:1'), 2)
  assert.equal(calls.get('characters:1/coverage:0'), 2)
  assert.equal(calls.get('characters:1/coverage:0/coverage:0'), 2)
  assert.equal(calls.has('characters:1/coverage:0/coverage:0/coverage:0'), false, 'a single missing target cannot split forever')
  assert.ok(state.story_work!.tasks.filter(task => task.key.startsWith('characters:1')).every(task => task.result === undefined))
})

test('a missing-name attempt followed by a different terminal error does not enter coverage recovery', async t => {
  for (const finalError of ['evidence', 'schema', 'transport'] as const) await t.test(finalError, async () => {
    const { state, source } = manuscript(), calls = new Map<string, number>()
    await assert.rejects(synthesizeSourceStory(state, async prompt => {
      const input = inputFrom(prompt)
      calls.set(input.part.key, (calls.get(input.part.key) || 0) + 1)
      const value = reply(input) as { characters?: Character[] }
      if (input.part.key === 'characters:1') {
        if (calls.get(input.part.key) === 1) value.characters!.pop()
        else {
          assert.match(prompt, /遗漏了目录已有证据的姓名或别名/)
          if (finalError === 'transport') throw new Error('correction transport stopped')
          if (finalError === 'schema') return JSON.stringify({ characters: 'invalid-array' })
          value.characters![0]!.section_ids = [0]
        }
      }
      return JSON.stringify(value)
    }, () => {}, signal(), undefined, 1000, source), finalError === 'transport' ? /correction transport stopped/
      : finalError === 'schema' ? /\$\.characters: 字段类型不合法，要求 array/ : /没有所引章节.*证据/)
    assert.equal(calls.get('characters:1'), 2)
    assert.equal([...calls.keys()].some(key => key.includes('/coverage:')), false)
    const failed = state.story_work!.tasks.find(task => task.key === 'characters:1')!
    assert.equal(failed.recovery, undefined); assert.equal(failed.result, undefined)
    assert.equal(state.story, undefined)
  })
})

test('misplaced recovery markers and malformed saved diagnostics are discarded without blocking ordinary task recovery', async () => {
  const { state, source } = manuscript(), calls = new Map<string, number>()
  let stop = true
  const generate = async (prompt: string) => {
    const input = inputFrom(prompt)
    calls.set(input.part.key, (calls.get(input.part.key) || 0) + 1)
    if (stop && input.part.key === 'timeline:0') throw new Error('checkpoint inspection stop')
    return JSON.stringify(reply(input))
  }
  await assert.rejects(synthesizeSourceStory(state, generate, () => {}, signal(), undefined, 1000, source), /checkpoint inspection stop/)
  const restored = JSON.parse(JSON.stringify(state)) as ScriptSourceAnalysis
  const overview = restored.story_work!.tasks.find(task => task.key === 'overview')!
  const single = restored.story_work!.tasks.find(task => task.key === 'characters:5')!
  const malformed = restored.story_work!.tasks.find(task => task.key === 'characters:1')!
  overview.recovery = single.recovery = 'character-coverage-v1'
  delete overview.result; delete single.result; delete malformed.result
  malformed.failure = { message: { invalid: 'diagnostic' } as unknown as string }
  stop = false
  const story = await synthesizeSourceStory(restored, generate, () => {}, signal(), undefined, 1000, source)
  assert.equal(overview.recovery, undefined); assert.equal(single.recovery, undefined)
  assert.equal(calls.get('overview'), 2); assert.equal(calls.get('characters:5'), 2)
  assert.equal(calls.get('characters:1'), 2); assert.equal(calls.get('characters:0'), 1)
  assert.equal([...calls.keys()].some(key => key.includes('/coverage:')), false)
  assert.equal(story.characters.length, 60)
})

test('a recovery marker cannot promote an otherwise valid character cache with a mismatched context hash', async () => {
  const { state, source } = manuscript(), calls = new Map<string, number>()
  let stop = true
  const generate = async (prompt: string) => {
    const input = inputFrom(prompt)
    calls.set(input.part.key, (calls.get(input.part.key) || 0) + 1)
    if (stop && input.part.key === 'timeline:0') throw new Error('checkpoint inspection stop')
    return JSON.stringify(reply(input))
  }
  await assert.rejects(synthesizeSourceStory(state, generate, () => {}, signal(), undefined, 1000, source), /checkpoint inspection stop/)
  const restored = JSON.parse(JSON.stringify(state)) as ScriptSourceAnalysis
  const parent = restored.story_work!.tasks.find(task => task.key === 'characters:1')!
  parent.recovery = 'character-coverage-v1'
  parent.context!.input_hash = 'different-context-hash'
  ;(parent.result as { characters: Character[] }).characters[0]!.description = '失配缓存中的过期描述'
  stop = false
  const story = await synthesizeSourceStory(restored, generate, () => {}, signal(), undefined, 1000, source)
  assert.equal(calls.get('overview'), 1); assert.equal(calls.get('characters:0'), 1)
  assert.equal(calls.get('characters:1'), 1, 'regenerate via smaller tasks instead of accepting or rerunning the stale parent')
  assert.ok(Array.from({ length: 4 }, (_, index) => calls.get(`characters:1/coverage:${index}`) === 1).every(Boolean))
  assert.equal(story.characters.some(character => character.description.includes('失配缓存')), false)
  assert.equal(story.characters.length, 60)
})

test('interruption resumes only unfinished synthesis tasks after a serialized checkpoint is restored', async () => {
  const { state, source } = manuscript(), calls = new Map<string, number>()
  let fail = true
  const generate = async (prompt: string) => {
    const input = inputFrom(prompt)
    calls.set(input.part.key, (calls.get(input.part.key) || 0) + 1)
    if (fail && input.part.key === 'timeline:1') throw new Error('整合连接中断')
    return JSON.stringify(reply(input))
  }
  await assert.rejects(synthesizeSourceStory(state, generate, () => {}, signal(), undefined, 1000, source), /整合连接中断/)
  assert.equal(state.story, undefined)
  assert.ok(state.story_work!.tasks.filter(task => task.result !== undefined).length > 3)
  const restored = JSON.parse(JSON.stringify(state)) as ScriptSourceAnalysis
  fail = false
  const story = await synthesizeSourceStory(restored, generate, () => {}, signal(), undefined, 1000, source)
  assert.equal(calls.get('overview'), 1); assert.equal(calls.get('characters:0'), 1)
  assert.equal(calls.get('timeline:0'), 1); assert.equal(calls.get('timeline:1'), 2)
  assert.equal(calls.get('threads:0'), 1)
  assert.match(story.ending.summary, /城市恢复/)
})

test('a damaged cached task is revalidated and regenerated without discarding valid siblings', async () => {
  const { state, source } = manuscript(), calls = new Map<string, number>()
  let interrupt = true
  const generate = async (prompt: string) => {
    const input = inputFrom(prompt)
    calls.set(input.part.key, (calls.get(input.part.key) || 0) + 1)
    if (interrupt && input.part.kind === 'threads') throw new Error('伏笔任务中断')
    return JSON.stringify(reply(input))
  }
  await assert.rejects(synthesizeSourceStory(state, generate, () => {}, signal(), undefined, 1000, source), /伏笔任务中断/)
  state.story_work!.tasks.find(task => task.key === 'characters:0')!.result = { characters: [{ name: '凭空捏造', aliases: [], description: '无原文证据', section_ids: [999] }] }
  interrupt = false
  const story = await synthesizeSourceStory(state, generate, () => {}, signal(), undefined, 1000, source)
  assert.equal(calls.get('characters:0'), 2); assert.equal(calls.get('overview'), 1)
  assert.equal(calls.get('timeline:1'), 1); assert.equal(calls.get('threads:0'), 2)
  assert.equal(story.characters.some(character => character.name === '凭空捏造'), false)
})

test('a checkpoint from different full source content cannot be adopted even when the source version and directory are unchanged', async () => {
  const { state, source } = manuscript(), calls = new Map<string, number>()
  let interrupt = true
  const generate = async (prompt: string) => {
    const input = inputFrom(prompt)
    calls.set(input.part.key, (calls.get(input.part.key) || 0) + 1)
    if (interrupt && input.part.kind === 'threads') throw new Error('暂停')
    return JSON.stringify(reply(input))
  }
  await assert.rejects(synthesizeSourceStory(state, generate, () => {}, signal(), undefined, 1000, source), /暂停/)
  const previousHash = state.story_work!.input_hash
  interrupt = false
  await synthesizeSourceStory(state, generate, () => {}, signal(), undefined, 1000, { ...source, content: `${source.content}新版补充事实。` })
  assert.equal(calls.get('overview'), 2); assert.equal(calls.get('characters:0'), 2); assert.equal(calls.get('timeline:1'), 2)
  assert.ok(previousHash)
})

test('short overlapping aliases require a full-source identity check and may remain separate people', async () => {
  const { state, source } = manuscript({ 0: '街坊称角色0为赵师傅。', 20: '角色20也被称为赵师傅，与角色0是不同的人。' })
  let mergeCalls = 0
  const story = await synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt)
    if (input.part.kind === 'characters_merge') {
      mergeCalls++
      assert.equal(input.source.content, source.content)
      assert.equal(input.materials.length, state.sections.length)
      assert.deepEqual(new Set(input.part.target_names), new Set(['角色0', '角色20', '赵师傅']))
      assert.ok(input.part.merge_candidates!.every(character => character.description.length < 100))
      return JSON.stringify({ characters: [
        { name: '角色0', aliases: ['赵师傅'], description: '第一集的赵师傅，与角色20是不同的人。', section_ids: [0] },
        { name: '角色20', aliases: ['赵师傅'], description: '第二十一集的赵师傅，与角色0是不同的人。', section_ids: [20] },
      ] })
    }
    const value = reply(input) as { characters?: Character[] }
    if (input.part.kind === 'characters') for (const character of value.characters!) {
      if (character.name === '角色0' || character.name === '角色20') character.aliases = ['赵师傅']
    }
    return JSON.stringify(value)
  }, () => {}, signal(), undefined, 1000, source)
  assert.equal(mergeCalls, 1, 'short descriptions must not bypass the shared-alias identity check')
  assert.equal(story.characters.length, 60)
  assert.deepEqual(story.characters.find(character => character.name === '角色0')!.section_ids, [0])
  assert.deepEqual(story.characters.find(character => character.name === '角色20')!.section_ids, [20])
  assert.equal(story.characters.filter(character => character.aliases.includes('赵师傅')).length, 2)
})

test('full-source identity checking can retain two independent people with the same name', async () => {
  const { state, source } = manuscript({ 0: '第一集另有一名角色20，他与第二十一集的同名人物并非同一人。' })
  let mergeCalls = 0
  const story = await synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt)
    if (input.part.kind === 'characters_merge') {
      mergeCalls++
      assert.equal(input.source.content, source.content)
      assert.deepEqual(input.part.target_names, ['角色20'])
      return JSON.stringify({ characters: [
        { name: '角色20', aliases: [], description: '第一集的角色20，与第二十一集同名人物独立。', section_ids: [0] },
        { name: '角色20', aliases: [], description: '第二十一集的角色20，与第一集同名人物独立。', section_ids: [20] },
      ] })
    }
    const value = reply(input) as { characters?: Character[] }
    if (input.part.key === 'characters:0') value.characters!.push({ name: '角色20', aliases: [], description: '第一集出现的同名人物。', section_ids: [0] })
    return JSON.stringify(value)
  }, () => {}, signal(), undefined, 1000, source)
  assert.equal(mergeCalls, 1)
  assert.equal(story.characters.length, 61)
  const homonyms = story.characters.filter(character => character.name === '角色20')
  assert.equal(homonyms.length, 2)
  assert.deepEqual(homonyms.map(character => character.section_ids), [[0], [20]])
  assert.deepEqual(validateSourceStory(state, story), story)
})

test('identical cross-batch records are deduplicated without an extra identity request', async () => {
  const { state, source } = manuscript()
  let mergeCalls = 0
  const story = await synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt)
    if (input.part.kind === 'characters_merge') mergeCalls++
    const value = reply(input) as { characters?: Character[] }
    if (input.part.kind === 'characters') value.characters!.push({ name: '角色0', aliases: [], description: '原稿人物角色0', section_ids: [0] })
    return JSON.stringify(value)
  }, () => {}, signal(), undefined, 1000, source)
  assert.equal(mergeCalls, 0)
  assert.equal(story.characters.length, 60)
  assert.equal(story.characters.filter(character => character.name === '角色0').length, 1)
})

test('a short-description identity check resumes its failed merge without repeating completed story work', async () => {
  const { state, source } = manuscript(), calls = new Map<string, number>()
  let interrupt = true
  const generate = async (prompt: string) => {
    const input = inputFrom(prompt) as Input & { previous_failure?: { message: string } }
    calls.set(input.part.key, (calls.get(input.part.key) || 0) + 1)
    if (input.part.kind === 'characters_merge') {
      assert.equal(input.source.content, source.content)
      assert.deepEqual(input.part.target_names, ['角色20'])
      if (interrupt) throw new Error('短描述人物身份核实中断')
      assert.match(input.previous_failure!.message, /短描述人物身份核实中断/)
    }
    const value = reply(input) as { characters?: Character[] }
    if (input.part.key === 'characters:0') value.characters!.push({ name: '角色20', aliases: [], description: '首批补充的角色20行动后果。', section_ids: [20] })
    return JSON.stringify(value)
  }
  await assert.rejects(synthesizeSourceStory(state, generate, () => {}, signal(), undefined, 1000, source), /短描述人物身份核实中断/)
  assert.equal(state.story, undefined)
  const failedMerge = state.story_work!.tasks.find(task => task.key.startsWith('characters_merge:'))!
  assert.equal(failedMerge.result, undefined)
  assert.match(failedMerge.failure!.message, /短描述人物身份核实中断/)
  const restored = JSON.parse(JSON.stringify(state)) as ScriptSourceAnalysis
  interrupt = false
  const story = await synthesizeSourceStory(restored, generate, () => {}, signal(), undefined, 1000, source)
  assert.equal(calls.get(failedMerge.key), 2)
  for (const [key, count] of calls) if (key !== failedMerge.key) assert.equal(count, 1, `completed task ${key} must be reusable`)
  assert.match(story.characters.find(character => character.name === '角色20')!.description, /首批补充.*行动后果/)
  assert.equal(story.characters.length, 60)
  assert.equal(restored.story_work, undefined)
})

test('overlong descriptions of the same person use a durable merge task and resume without repeating valid story tasks', async () => {
  const { state, source } = manuscript(), calls = new Map<string, number>()
  let stopMerge = true
  const generate = async (prompt: string) => {
    const input = inputFrom(prompt)
    assert.equal(input.source.content, source.content)
    assert.equal(input.materials.length, 59)
    calls.set(input.part.key, (calls.get(input.part.key) || 0) + 1)
    if (input.part.kind === 'characters_merge') {
      assert.deepEqual(new Set(input.part.target_names), new Set(['林舟', '阿舟']))
      if (stopMerge) throw new Error('人物归并暂时中断')
      return JSON.stringify({ characters: [{ name: '林舟', aliases: ['阿舟'], description: '林舟调查停摆之城，终场揭示阿舟为其别名；归还开篇信物，使城市恢复。', section_ids: [0, 58] }] })
    }
    const value = reply(input) as { characters?: Array<{ name: string; description: string }> }
    if (input.part.kind === 'characters') for (const character of value.characters!) {
      if (character.name === '林舟') character.description = input.part.target_names!.includes('林舟')
        ? '林舟调查停摆之城并保留开篇信物的线索。'.repeat(22)
        : '终场揭示林舟又名阿舟，归还信物令城市恢复。'.repeat(22)
      assert.ok(character.description.length <= 600)
    }
    return JSON.stringify(value)
  }
  await assert.rejects(synthesizeSourceStory(state, generate, () => {}, signal(), undefined, 1000, source), /人物归并暂时中断/)
  assert.equal(state.story, undefined)
  const mergeKey = state.story_work!.tasks.find(task => task.key.startsWith('characters_merge:'))!.key
  assert.equal(state.story_work!.tasks.filter(task => task.result !== undefined).length, state.story_work!.tasks.length - 1)
  const restored = JSON.parse(JSON.stringify(state)) as ScriptSourceAnalysis
  stopMerge = false
  const story = await synthesizeSourceStory(restored, generate, () => {}, signal(), undefined, 1000, source)
  assert.equal(calls.get(mergeKey), 2)
  assert.equal(calls.get('overview'), 1); assert.equal(calls.get('characters:0'), 1)
  assert.equal(calls.get('timeline:1'), 1); assert.equal(calls.get('threads:1'), 1)
  assert.equal(story.characters.length, 60)
  const main = story.characters.find(character => character.name === '林舟')!
  assert.ok(main.description.length <= 600); assert.match(main.description, /调查.*别名.*归还.*恢复/)
  assert.deepEqual(main.aliases, ['阿舟']); assert.deepEqual(main.section_ids, [0, 58])
})

test('cross-batch facts exceeding the description limit use a resumable merge instead of truncating or rejecting the batch', async () => {
  const { state, source } = manuscript(), calls = new Map<string, number>()
  let interrupt = true
  const generate = async (prompt: string) => {
    const input = inputFrom(prompt)
    calls.set(input.part.key, (calls.get(input.part.key) || 0) + 1)
    if (input.part.kind === 'characters_merge') {
      assert.deepEqual(input.part.target_names, ['角色20'])
      if (interrupt) throw new Error('跨批人物归并中断')
      return JSON.stringify({ characters: [{ name: '角色20', aliases: [], description: '角色20听见钟声，保留此前调查的行动后果。', section_ids: [20] }] })
    }
    const value = reply(input) as { characters?: Array<{ name: string; aliases: string[]; description: string; section_ids: number[] }> }
    if (input.part.kind === 'characters') {
      const own = value.characters!.find(character => character.name === '角色20')
      if (own) own.description = '角色20保留此前调查的行动后果。'.repeat(25)
      if (input.part.key === 'characters:0') value.characters!.push({ name: '角色20', aliases: [],
        description: '角色20在第二十一集听见钟声。'.repeat(25), section_ids: [20] })
    }
    return JSON.stringify(value)
  }
  await assert.rejects(synthesizeSourceStory(state, generate, () => {}, signal(), undefined, 1000, source), /跨批人物归并中断/)
  assert.equal(state.story, undefined)
  const mergeKey = state.story_work!.tasks.find(task => task.key.startsWith('characters_merge:'))!.key
  const restored = JSON.parse(JSON.stringify(state)) as ScriptSourceAnalysis
  interrupt = false
  const story = await synthesizeSourceStory(restored, generate, () => {}, signal(), undefined, 1000, source)
  assert.equal(calls.get('characters:0'), 1); assert.equal(calls.get('characters:1'), 1)
  assert.equal(calls.get('timeline:1'), 1); assert.equal(calls.get(mergeKey), 2)
  const matches = story.characters.filter(character => character.name === '角色20')
  assert.equal(matches.length, 1); assert.match(matches[0]!.description, /听见钟声.*行动后果/)
  assert.deepEqual(matches[0]!.section_ids, [20]); assert.equal(story.characters.length, 60)
})

test('long-story event coverage and identity evidence gates reject unresolved errors after one correction', async t => {
  for (const issue of ['event', 'invented_alias', 'thread_scope'] as const) await t.test(issue, async () => {
    const { state, source } = manuscript()
    let invalidCalls = 0
    await assert.rejects(synthesizeSourceStory(state, async prompt => {
      const input = inputFrom(prompt), value = reply(input) as Record<string, unknown>
      if (issue === 'invented_alias' && input.part.key === 'characters:0') {
        invalidCalls++; (value.characters as Array<{ aliases: string[] }>)[0]!.aliases.push('原文不存在的神秘身份')
      }
      if (issue === 'event' && input.part.kind === 'timeline' && input.part.section_ids!.includes(58)) {
        invalidCalls++; (value.timeline as unknown[]).pop()
      }
      if (issue === 'thread_scope' && input.part.key === 'threads:0') {
        invalidCalls++; (value.threads as Array<{ section_ids: number[] }>)[0]!.section_ids = [58]
      }
      return JSON.stringify(value)
    }, () => {}, signal(), undefined, 1000, source), issue === 'event' ? /遗漏.*关键事件/
      : issue === 'thread_scope' ? /伏笔必须引用本次范围内/ : /没有所引章节.*证据/)
    assert.equal(invalidCalls, 2); assert.equal(state.story, undefined)
  })
})
