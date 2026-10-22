import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { ScriptSourceAnalysis, ScriptSourceSection, ScriptSourceStory } from '@video-studio/shared/script/script-source-document'
import { modelStepSignal } from '../src/modules/generation/model-execution.js'
import { scriptSourceVersion } from '../src/modules/script/script-source-identity.js'
import { reviewSourceQuality } from '../src/modules/script/script-source-quality.js'
import { synthesizeSourceStory } from '../src/modules/script/script-source-story.js'

type Character = ScriptSourceStory['characters'][number]
type Input = {
  complete_source: boolean
  source: { filename: string; content?: string; total_length?: number }
  character_context?: { source_ranges: Array<{ offset: number; content: string; section_ids: number[] }> }
  materials: Array<{ section: ScriptSourceSection & { id: number } }>
  part: { key: string; kind: 'overview' | 'characters' | 'characters_merge' | 'timeline' | 'threads' | 'uncertainties'; target_names?: string[]; section_ids?: number[] }
}

const freshSignal = () => new AbortController().signal
const names = Array.from({ length: 40 }, (_, id) => `客${'甲乙丙丁戊己庚辛'[Math.floor(id / 5)]}${'一二三四五'[id % 5]}`)

function manuscript() {
  const sections: ScriptSourceSection[] = []
  let content = ''
  for (let id = 0; id < names.length; id++) {
    const opening = `第${id + 1}集，${names[id]}完成独立调查，留下专属标记${id}号。`
    const text = `${opening}\n${'城中每座钟楼都保留着当晚的记录，众人沿着既定线索继续调查。'.repeat(45)}\n`
    const evidence = { offset: content.length, quote: opening }
    sections.push({ offset: content.length, length: text.length, title: `第${id + 1}集`, episode_number: id + 1, summary: opening,
      characters: [{ name: names[id]!, description: `第${id + 1}集调查者`, evidence }],
      events: [{ summary: `${names[id]}完成独立调查`, evidence }], open_threads: [] })
    content += text
  }
  assert.ok(content.length > 32_000)
  const source = { filename: '四十集人物资料.md', content }
  const state: ScriptSourceAnalysis = { id: 'targeted-integration', source_version: scriptSourceVersion(source), model_id: 'model', status: 'running', phase: 'synthesis',
    completed_chunks: 1, total_chunks: 1, sections, error: null, updated_at: 'now' }
  return { state, source }
}

function inputFrom(prompt: string): Input {
  const marker = '【全剧整合资料】\n'
  return JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length))
}

function response(input: Input): Record<string, unknown> {
  if (input.part.kind === 'overview') return { covered_section_ids: input.materials.map(item => item.section.id), summary: '四十名调查者依次完成独立调查，最终归还记录并离开钟楼。',
    ending: { summary: '最后一位调查者归还记录，众人离开钟楼。', section_ids: [39] } }
  if (input.part.kind === 'characters' || input.part.kind === 'characters_merge') {
    const characters: Character[] = input.part.target_names!.map(name => ({ name, aliases: [], description: `${name}完成独立调查并留下记录。`,
      section_ids: input.materials.filter(item => item.section.characters.some(character => character.name === name)).map(item => item.section.id) }))
    return input.complete_source ? { characters } : { characters, needs_full_source: false, reason: '' }
  }
  if (input.part.kind === 'timeline') return { covered_section_ids: input.part.section_ids,
    timeline: input.part.section_ids!.map(id => ({ summary: input.materials[id]!.section.events[0]!.summary, section_ids: [id] })) }
  if (input.part.kind === 'threads') return { threads: [] }
  return { uncertainties: [] }
}

function characterResult(value: Record<string, unknown>) {
  return value.characters as Character[]
}

function providedSource(input: Input) {
  return input.complete_source ? input.source.content! : input.character_context!.source_ranges.map(range => range.content).join('')
}

test('long-source integration limits later character requests while retaining full discovery, chronology and independent review', async () => {
  const { state, source } = manuscript(), seen = new Map<string, Input>()
  const story = await synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt)
    seen.set(input.part.key, input)
    assert.equal(input.materials.length, state.sections.length, 'every task retains the complete directory')
    if (input.part.kind !== 'characters' || input.part.key === 'characters:0') {
      assert.equal(input.complete_source, true)
      assert.equal(input.source.content, source.content)
    } else {
      assert.equal(input.complete_source, false)
      assert.equal('content' in input.source, false)
      assert.ok(providedSource(input).length < source.content.length)
      for (const name of input.part.target_names!) assert.ok(providedSource(input).includes(name), `${name} must have actual source evidence`)
      for (const range of input.character_context!.source_ranges) assert.equal(range.content, source.content.slice(range.offset, range.offset + range.content.length))
      const { character_context: _context, ...common } = input
      const wholeSourceInput = { ...common, complete_source: true, source }
      assert.ok(Buffer.byteLength(JSON.stringify(input)) < Buffer.byteLength(JSON.stringify(wholeSourceInput)),
        'the complete synthetic local payload, including metadata and directory, must be smaller than the corresponding whole-source payload')
    }
    return JSON.stringify(response(input))
  }, () => {}, freshSignal(), undefined, 1000, source)
  assert.equal(story.characters.length, names.length)
  assert.equal(story.timeline.length, state.sections.length)
  assert.deepEqual(new Set(story.characters.map(character => character.name)), new Set(names))
  assert.equal(providedSource(seen.get('characters:1')!).includes('专属标记0号'), false, 'unrelated original is omitted, although its directory entry remains')
  assert.ok([...seen.values()].some(input => !input.complete_source))
  const cumulativeSourceCharacters = [...seen.values()].reduce((total, input) => total + providedSource(input).length, 0)
  assert.ok(cumulativeSourceCharacters < source.content.length * seen.size)
  await reviewSourceQuality(source, state, async prompt => {
    const marker = '【原稿分析核对资料】\n'
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) as {
      complete_source: boolean; units: Array<{ text: string }>; sections: Array<{ id: number }>; story: ScriptSourceStory
    }
    assert.equal(input.complete_source, true)
    assert.equal(input.units.map(unit => unit.text).join(''), source.content)
    assert.deepEqual(input.story, story)
    return JSON.stringify({ checked_section_ids: input.sections.map(section => section.id), findings: [] })
  }, () => {}, freshSignal(), 1000)
  assert.equal(state.quality!.status, 'passed')
})

test('an explicit request for more evidence reruns only that character batch against the full manuscript', async () => {
  const { state, source } = manuscript(), calls = new Map<string, boolean[]>()
  const story = await synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt)
    calls.set(input.part.key, [...calls.get(input.part.key) || [], input.complete_source])
    if (input.part.key === 'characters:1' && !input.complete_source) return JSON.stringify({ characters: [], needs_full_source: true, reason: '目标人物的关系涉及尚未读取的远处章节，需要全文确认。' })
    return JSON.stringify(response(input))
  }, () => {}, freshSignal(), undefined, 1000, source)
  assert.equal(story.characters.length, names.length)
  assert.deepEqual(calls.get('characters:1'), [false, true])
  assert.deepEqual(calls.get('overview'), [true])
  assert.deepEqual(calls.get('characters:0'), [true])
  assert.deepEqual(calls.get('characters:2'), [false])
  assert.ok([...calls].every(([key, attempts]) => key === 'characters:1' || attempts.length === 1))
})

test('incomplete targets, out-of-package facts and new local aliases trigger full-source verification rather than acceptance', async t => {
  for (const issue of ['citation', 'alias', 'missing_target', 'outside_character'] as const) await t.test(issue, async () => {
    const { state, source } = manuscript(), calls = new Map<string, boolean[]>()
    const alias = '远处称呼'
    if (issue === 'alias') {
      const extra = `最后一集记录明确说明：${names[12]}又称${alias}。`
      source.content += extra
      state.sections[39]!.length += extra.length
      state.source_version = scriptSourceVersion(source)
    }
    const story = await synthesizeSourceStory(state, async prompt => {
      const input = inputFrom(prompt), value = response(input)
      calls.set(input.part.key, [...calls.get(input.part.key) || [], input.complete_source])
      if (input.part.key === 'characters:1') {
        const character = characterResult(value)[0]!
        if (issue === 'citation') character.section_ids = input.complete_source ? [12] : [0, 12]
        if (issue === 'alias') {
          character.aliases = [alias]
          character.section_ids = input.complete_source ? [12, 39] : [12]
        }
        if (!input.complete_source && issue === 'missing_target') characterResult(value).pop()
        if (!input.complete_source && issue === 'outside_character') characterResult(value).push({ name: names[0]!, aliases: [], description: '其他人物的资料不能作为本批已核验正文。', section_ids: [0] })
      }
      return JSON.stringify(value)
    }, () => {}, freshSignal(), undefined, 1000, source)
    assert.deepEqual(calls.get('characters:1'), [false, true])
    assert.deepEqual(calls.get('characters:0'), [true])
    assert.deepEqual(calls.get('characters:2'), [false])
    assert.equal(story.characters.length, names.length)
    const character = story.characters.find(item => item.name === names[12])!
    assert.deepEqual(character.section_ids, issue === 'alias' ? [12, 39] : [12])
    assert.deepEqual(character.aliases, issue === 'alias' ? [alias] : [])
  })
})

test('cancelling a targeted request never starts the full-source fallback or persists after cancellation', async () => {
  const { state, source } = manuscript(), controller = new AbortController(), expected = new Error('用户停止人物整理')
  const calls: boolean[] = []
  await assert.rejects(synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt)
    if (input.part.key === 'characters:1') {
      calls.push(input.complete_source)
      controller.abort(expected)
      throw expected
    }
    return JSON.stringify(response(input))
  }, () => assert.equal(controller.signal.aborted, false), controller.signal, undefined, 1000, source), error => error === expected)
  assert.deepEqual(calls, [false])
  assert.equal(state.story, undefined)
  assert.ok(state.story_work!.tasks.find(task => task.key === 'overview')!.result)
  assert.ok(state.story_work!.tasks.find(task => task.key === 'characters:0')!.result)
  assert.equal(state.story_work!.tasks.find(task => task.key === 'characters:1')!.result, undefined)
})

test('a request failure does not turn a targeted character task into a full-source request', async () => {
  const { state, source } = manuscript(), calls: boolean[] = []
  await assert.rejects(synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt)
    if (input.part.key === 'characters:1') {
      calls.push(input.complete_source)
      throw new Error('测试传输失败，不包含证据不足结论')
    }
    return JSON.stringify(response(input))
  }, () => {}, freshSignal(), undefined, 1000, source), /测试传输失败/)
  assert.deepEqual(calls, [false])
  assert.equal(state.story, undefined)
  assert.ok(state.story_work!.tasks.find(task => task.key === 'characters:0')!.result)
})

test('two schema-only local failures do not trigger a full-source request', async () => {
  const { state, source } = manuscript(), calls: boolean[] = []
  await assert.rejects(synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt)
    if (input.part.key === 'characters:1') {
      calls.push(input.complete_source)
      // Missing the mandatory scope envelope is a format error, rather than
      // a statement that the source evidence is insufficient.
      return JSON.stringify({ characters: characterResult(response(input)) })
    }
    return JSON.stringify(response(input))
  }, () => {}, freshSignal(), undefined, 1000, source), /契约/)
  assert.deepEqual(calls, [false, false])
  assert.equal(state.story_work!.tasks.find(task => task.key === 'characters:1')!.result, undefined)
  assert.ok(state.story_work!.tasks.find(task => task.key === 'characters:0')!.result)
})

test('a targeted request deadline rejects late results without expanding scope or saving their output', async () => {
  const { state, source } = manuscript(), calls: boolean[] = []
  let saves = 0, requestSignal: AbortSignal | undefined
  let lateRequest: Promise<string> | undefined
  await assert.rejects(synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt)
    if (input.part.key === 'characters:1') {
      calls.push(input.complete_source)
      requestSignal = modelStepSignal()
      assert.equal(requestSignal!.aborted, false)
      // The mock deliberately ignores cancellation, as a provider response
      // might arrive after the enclosing deadline has already expired.
      lateRequest = delay(100).then(() => JSON.stringify({ characters: [], needs_full_source: true, reason: '迟到的资料不足结论不能触发扩读。' }))
      return lateRequest
    }
    return JSON.stringify(response(input))
  }, () => { saves++ }, freshSignal(), undefined, 40, source), /超时/)
  assert.equal(requestSignal!.aborted, true)
  const savesAtDeadline = saves
  await lateRequest
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [false])
  assert.equal(saves, savesAtDeadline)
  assert.equal(state.story, undefined)
  assert.equal(state.story_work!.tasks.find(task => task.key === 'characters:1')!.result, undefined)
  assert.ok(state.story_work!.tasks.find(task => task.key === 'characters:0')!.result)
})

test('a scope escalation after local format correction shares the three-request budget with full-source verification', async () => {
  const { state, source } = manuscript(), calls: boolean[] = []
  const story = await synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt)
    if (input.part.key === 'characters:1') {
      calls.push(input.complete_source)
      if (calls.length === 1) return 'not a JSON object'
      if (!input.complete_source) return JSON.stringify({ characters: [], needs_full_source: true, reason: '格式已修正，但人物关系仍需要全文核实。' })
    }
    return JSON.stringify(response(input))
  }, () => {}, freshSignal(), undefined, 1000, source)
  assert.equal(story.characters.length, names.length)
  assert.deepEqual(calls, [false, false, true])
})

test('full-source format correction cannot reset the character batch request budget after escalation', async () => {
  const { state, source } = manuscript(), calls: boolean[] = []
  await assert.rejects(synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt)
    if (input.part.key === 'characters:1') {
      calls.push(input.complete_source)
      if (!input.complete_source) return JSON.stringify({ characters: [], needs_full_source: true, reason: '需要全文核实。' })
      return 'not a JSON object'
    }
    return JSON.stringify(response(input))
  }, () => {}, freshSignal(), undefined, 1000, source), /契约|请求上限/)
  assert.deepEqual(calls, [false, true, true])
  assert.equal(state.story_work!.tasks.find(task => task.key === 'characters:1')!.result, undefined)
  assert.ok(state.story_work!.tasks.find(task => task.key === 'characters:0')!.result)
})

test('a failed full-source fallback resumes directly with full evidence and preserves completed sibling tasks', async () => {
  const { state, source } = manuscript(), calls = new Map<string, boolean[]>()
  let interrupt = true
  const generate = async (prompt: string) => {
    const input = inputFrom(prompt)
    calls.set(input.part.key, [...calls.get(input.part.key) || [], input.complete_source])
    if (input.part.key === 'characters:1') {
      if (!input.complete_source) return JSON.stringify({ characters: [], needs_full_source: true, reason: '需要扩大资料范围核验身份。' })
      if (interrupt) throw new Error('全文核验请求被中断')
    }
    return JSON.stringify(response(input))
  }
  await assert.rejects(synthesizeSourceStory(state, generate, () => {}, freshSignal(), undefined, 1000, source), /全文核验请求被中断/)
  const restored = JSON.parse(JSON.stringify(state)) as ScriptSourceAnalysis
  const failed = restored.story_work!.tasks.find(task => task.key === 'characters:1')! as { result?: unknown; context?: { strategy: string; fallback_from_hash?: string } }
  assert.equal(failed.result, undefined)
  assert.equal(failed.context!.strategy, 'whole-source-v1')
  assert.ok(failed.context!.fallback_from_hash)
  interrupt = false
  const story = await synthesizeSourceStory(restored, generate, () => {}, freshSignal(), undefined, 1000, source)
  assert.equal(story.characters.length, names.length)
  assert.deepEqual(calls.get('characters:1'), [false, true, true])
  assert.deepEqual(calls.get('overview'), [true])
  assert.deepEqual(calls.get('characters:0'), [true])
  assert.deepEqual(calls.get('characters:2'), [false])
})

test('a changed targeted context hash invalidates only the affected cached result', async () => {
  const { state, source } = manuscript(), calls = new Map<string, boolean[]>()
  let interrupt = true
  const generate = async (prompt: string) => {
    const input = inputFrom(prompt)
    calls.set(input.part.key, [...calls.get(input.part.key) || [], input.complete_source])
    if (interrupt && input.part.key === 'timeline:0') throw new Error('暂停以检查人物检查点')
    return JSON.stringify(response(input))
  }
  await assert.rejects(synthesizeSourceStory(state, generate, () => {}, freshSignal(), undefined, 1000, source), /暂停以检查/)
  const restored = JSON.parse(JSON.stringify(state)) as ScriptSourceAnalysis
  const cached = restored.story_work!.tasks.find(task => task.key === 'characters:1')! as { result?: unknown; context?: { strategy: string; input_hash: string } }
  assert.ok(cached.result)
  assert.equal(cached.context!.strategy, 'character-evidence-v1')
  cached.context!.input_hash = 'a-different-targeted-evidence-context'
  interrupt = false
  const story = await synthesizeSourceStory(restored, generate, () => {}, freshSignal(), undefined, 1000, source)
  assert.equal(story.characters.length, names.length)
  assert.deepEqual(calls.get('characters:1'), [false, false])
  assert.deepEqual(calls.get('characters:0'), [true])
  assert.deepEqual(calls.get('characters:2'), [false])
  assert.deepEqual(calls.get('characters:3'), [false])
  assert.deepEqual(calls.get('overview'), [true])
})

test('a cached local result with an unread citation is regenerated even when its context hash still matches', async () => {
  const { state, source } = manuscript(), calls = new Map<string, number>()
  let interrupt = true
  const generate = async (prompt: string) => {
    const input = inputFrom(prompt)
    calls.set(input.part.key, (calls.get(input.part.key) || 0) + 1)
    if (interrupt && input.part.key === 'timeline:0') throw new Error('暂停以检查人物结果')
    return JSON.stringify(response(input))
  }
  await assert.rejects(synthesizeSourceStory(state, generate, () => {}, freshSignal(), undefined, 1000, source), /暂停以检查人物/)
  const restored = JSON.parse(JSON.stringify(state)) as ScriptSourceAnalysis
  const cached = restored.story_work!.tasks.find(task => task.key === 'characters:1')!
  const originalContext = JSON.stringify((cached as { context?: unknown }).context)
  ;(cached.result as { characters: Character[] }).characters[0]!.section_ids = [0, 12]
  assert.equal(JSON.stringify((cached as { context?: unknown }).context), originalContext)
  interrupt = false
  const story = await synthesizeSourceStory(restored, generate, () => {}, freshSignal(), undefined, 1000, source)
  assert.equal(calls.get('characters:1'), 2)
  assert.equal(calls.get('characters:0'), 1)
  assert.equal(calls.get('characters:2'), 1)
  assert.equal(calls.get('overview'), 1)
  assert.deepEqual(story.characters.find(character => character.name === names[12])!.section_ids, [12])
})

test('either rollback switch replaces cached targeted results with full-source work while retaining valid full-source siblings', async t => {
  for (const setting of ['VIDEO_STUDIO_SCRIPT_CHARACTER_CONTEXT', 'VIDEO_STUDIO_SCRIPT_TARGETED_CONTEXT']) await t.test(setting, async () => {
    const previous = process.env[setting]
    try {
      delete process.env[setting]
      const { state, source } = manuscript(), calls = new Map<string, boolean[]>()
      let interrupt = true
      const generate = async (prompt: string) => {
        const input = inputFrom(prompt)
        calls.set(input.part.key, [...calls.get(input.part.key) || [], input.complete_source])
        if (interrupt && input.part.key === 'timeline:0') throw new Error('暂停以切换回全文模式')
        return JSON.stringify(response(input))
      }
      await assert.rejects(synthesizeSourceStory(state, generate, () => {}, freshSignal(), undefined, 1000, source), /暂停以切换/)
      process.env[setting] = '0'
      interrupt = false
      const story = await synthesizeSourceStory(state, generate, () => {}, freshSignal(), undefined, 1000, source)
      assert.equal(story.characters.length, names.length)
      assert.deepEqual(calls.get('overview'), [true])
      assert.deepEqual(calls.get('characters:0'), [true])
      assert.deepEqual(calls.get('characters:1'), [false, true])
      assert.deepEqual(calls.get('characters:2'), [false, true])
      assert.deepEqual(calls.get('characters:3'), [false, true])
    } finally {
      if (previous === undefined) delete process.env[setting]
      else process.env[setting] = previous
    }
  })
})

test('a successful full-source fallback remains reusable after targeted mode is disabled', async () => {
  const setting = 'VIDEO_STUDIO_SCRIPT_CHARACTER_CONTEXT', previous = process.env[setting]
  try {
    delete process.env[setting]
    const { state, source } = manuscript(), calls = new Map<string, boolean[]>()
    let interrupt = true
    const generate = async (prompt: string) => {
      const input = inputFrom(prompt)
      calls.set(input.part.key, [...calls.get(input.part.key) || [], input.complete_source])
      if (input.part.key === 'characters:1' && !input.complete_source) return JSON.stringify({ characters: [], needs_full_source: true, reason: '需要完整原文核实。' })
      if (interrupt && input.part.key === 'timeline:0') throw new Error('暂停以检查全文回退结果')
      return JSON.stringify(response(input))
    }
    await assert.rejects(synthesizeSourceStory(state, generate, () => {}, freshSignal(), undefined, 1000, source), /暂停以检查全文/)
    const restored = JSON.parse(JSON.stringify(state)) as ScriptSourceAnalysis
    const completed = restored.story_work!.tasks.find(task => task.key === 'characters:1')!
    assert.ok(completed.result)
    assert.ok(completed.context!.fallback_from_hash)
    process.env[setting] = '0'
    interrupt = false
    const story = await synthesizeSourceStory(restored, generate, () => {}, freshSignal(), undefined, 1000, source)
    assert.equal(story.characters.length, names.length)
    assert.deepEqual(calls.get('characters:1'), [false, true], 'the completed fallback is a validated full-source result')
    assert.deepEqual(calls.get('characters:2'), [false, true])
    assert.deepEqual(calls.get('characters:3'), [false, true])
    assert.deepEqual(calls.get('overview'), [true])
    assert.deepEqual(calls.get('characters:0'), [true])
  } finally {
    if (previous === undefined) delete process.env[setting]
    else process.env[setting] = previous
  }
})

test('changed discovery seeds rebuild dependent local results while preserving completed full-source results', async () => {
  const { state, source } = manuscript(), calls = new Map<string, boolean[]>()
  let interrupt = true
  const generate = async (prompt: string) => {
    const input = inputFrom(prompt)
    calls.set(input.part.key, [...calls.get(input.part.key) || [], input.complete_source])
    if (input.part.key === 'characters:1' && !input.complete_source) return JSON.stringify({ characters: [], needs_full_source: true, reason: '本批需要全文核实。' })
    if (interrupt && input.part.key === 'timeline:0') throw new Error('暂停以检查发现任务依赖')
    return JSON.stringify(response(input))
  }
  await assert.rejects(synthesizeSourceStory(state, generate, () => {}, freshSignal(), undefined, 1000, source), /暂停以检查发现/)
  const restored = JSON.parse(JSON.stringify(state)) as ScriptSourceAnalysis
  const originalInputHash = restored.story_work!.input_hash
  const discovery = restored.story_work!.tasks.find(task => task.key === 'characters:0')!.result as { characters: Character[] }
  discovery.characters[0]!.description += '已核对其独立调查记录。'
  interrupt = false
  const story = await synthesizeSourceStory(restored, generate, () => {}, freshSignal(), undefined, 1000, source)
  assert.equal(originalInputHash, createHash('sha256').update(JSON.stringify(['source-story-parts-v4', state.source_version, source, state.sections])).digest('hex'))
  assert.deepEqual(calls.get('characters:0'), [true])
  assert.deepEqual(calls.get('characters:1'), [false, true])
  assert.deepEqual(calls.get('characters:2'), [false, false])
  assert.deepEqual(calls.get('characters:3'), [false, false])
  assert.deepEqual(calls.get('overview'), [true])
  assert.match(story.characters.find(character => character.name === names[0])!.description, /已核对其独立调查记录/)
})

test('legacy validated full-source checkpoints survive adoption without replaying completed work', async () => {
  const { state, source } = manuscript()
  state.story_work = {
    input_hash: createHash('sha256').update(JSON.stringify(['source-story-parts-v3', state.source_version, source, state.sections])).digest('hex'),
    tasks: [
      { key: 'overview' }, ...Array.from({ length: 4 }, (_, id) => ({ key: `characters:${id}` })),
      ...(['timeline', 'threads', 'uncertainties'] as const).flatMap(kind => Array.from({ length: 4 }, (_, id) => ({ key: `${kind}:${id}` }))),
    ],
  }
  const legacyTasks = state.story_work.tasks
  const materials = state.sections.map((section, id) => ({ section: { ...section, id } }))
  legacyTasks[0]!.result = response({ complete_source: true, source, materials, part: { key: 'overview', kind: 'overview' } })
  legacyTasks[1]!.result = response({ complete_source: true, source, materials, part: { key: 'characters:0', kind: 'characters', target_names: names.slice(0, 12) } })
  legacyTasks[2]!.result = response({ complete_source: true, source, materials, part: { key: 'characters:1', kind: 'characters', target_names: names.slice(12, 24) } })
  const calls: string[] = []
  const story = await synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt)
    calls.push(input.part.key)
    return JSON.stringify(response(input))
  }, () => {}, freshSignal(), undefined, 1000, source)
  assert.equal(story.characters.length, names.length)
  assert.equal(calls.includes('overview'), false)
  assert.equal(calls.includes('characters:0'), false)
  assert.equal(calls.includes('characters:1'), false)
  assert.equal(calls.filter(key => key === 'characters:2').length, 1)
})

test('character merge requests retain full-source identity verification after targeted batches', async () => {
  const { state, source } = manuscript()
  let merges = 0
  const story = await synthesizeSourceStory(state, async prompt => {
    const input = inputFrom(prompt), value = response(input)
    if (input.part.kind === 'characters_merge') {
      merges++
      assert.equal(input.complete_source, true)
      assert.equal(input.source.content, source.content)
      assert.deepEqual(input.part.target_names, [names[12]])
      return JSON.stringify({ characters: [{ name: names[12], aliases: [], description: '该调查者完成调查、留下记录并保留身份线索。', section_ids: [12] }] })
    }
    if (input.part.key === 'characters:0') characterResult(value).push({ name: names[12]!, aliases: [], description: '该调查者完成独立调查并留下现场记录。'.repeat(25), section_ids: [12] })
    if (input.part.key === 'characters:1') characterResult(value)[0]!.description = '该调查者保留后续调查的身份与行动线索。'.repeat(25)
    return JSON.stringify(value)
  }, () => {}, freshSignal(), undefined, 1000, source)
  assert.equal(merges, 1)
  assert.equal(story.characters.length, names.length)
  assert.match(story.characters.find(character => character.name === names[12])!.description, /调查.*身份线索/)
})
