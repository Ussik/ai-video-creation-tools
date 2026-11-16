import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { test } from 'node:test'
import { generateStructuredOutput, outputContract, type StructuredOutputCheckpoint } from '../src/modules/generation/model-output.js'
import { TextProviderError } from '../src/infrastructure/providers/text-errors.js'
import { sourceMapSchema } from '../src/modules/script/script-source-map.js'
import { normalizeSourceOutput } from '../src/modules/generation/source-output-normalization.js'

const candidate = () => ({ sections: [{ start_unit: 0, title: '渡口', episode_number: 1,
  summary: '主角在渡口得知父亲去向。', continues_previous: false, open_threads: ['父亲去向'],
  characters: [{ name: '林天', description: '保留 details 与 description 字样的原文说明。', evidence: { unit_id: 0 } }],
  events: [{ summary: '主角得知父亲去向。', evidence: { unit_id: 1 } }],
}] })
const aliases = () => {
  const value: Record<string, any> = candidate()
  const character = value.sections[0].characters[0]
  character.details = character.description; delete character.description
  const event = value.sections[0].events[0]
  event.description = event.summary; delete event.summary
  return value
}
const prompt = '依据完整原文分析目录，不创作新事实。'

test('completed boundary answers may omit the unused operation array without refreshing paid correction intent', async () => {
  const schema = z.object({ prefix_sections: z.array(sourceMapSchema.shape.sections.element),
    starts: z.array(z.object({ section_index: z.number().int(), start_unit: z.number().int() }).strict()),
  }).strict()
  for (const rawValue of [{ starts: [{ section_index: 0, start_unit: 0 }] }, { prefix_sections: candidate().sections }]) {
    const raw = JSON.stringify(rawValue), hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const correction = { input_hash: 'used-original-correction', raw: 'invalid later correction retained verbatim' }
    const checkpoint: StructuredOutputCheckpoint = {
      input_hash: hash(['script_source_map_boundary_repair', outputContract('script_source_map_boundary_repair', schema).schema, prompt]),
      raw, original_raw: raw, correction, correction_started: { input_hash: correction.input_hash },
    }
    const result = await generateStructuredOutput('script_source_map_boundary_repair', schema,
      async () => assert.fail('saved complete boundary answer must revalidate locally'), prompt, { checkpoint })
    assert.deepEqual(result, { prefix_sections: [], starts: [], ...rawValue })
    assert.equal(checkpoint.original_raw, raw)
    assert.deepEqual(checkpoint.correction, correction)
    assert.deepEqual(checkpoint.correction_started, { input_hash: correction.input_hash })
  }
})

test('boundary operation defaults never coerce null, overwrite explicit choices or remove unknown facts', () => {
  const name = 'script_source_map_boundary_repair'
  for (const value of [{}, { starts: null }, { starts: 'wrong' }, { starts: [], prefix_sections: null },
    { starts: [{ section_index: 0, start_unit: 0 }], prefix_sections: [{ start_unit: 0 }] }]) {
    assert.deepEqual(normalizeSourceOutput(name, value), value)
  }
  const value = { starts: [{ section_index: 0, start_unit: 0 }], unknown_fact: '原资料仍保留' }
  assert.deepEqual(normalizeSourceOutput(name, value), { ...value, prefix_sections: [] })
  for (const other of ['other_boundary_repair', name + '_untrusted']) assert.deepEqual(normalizeSourceOutput(other, value), value)
})

test('source directory aliases normalize losslessly with one request and normal business validation', async () => {
  const initial = aliases(), before = structuredClone(initial)
  let calls = 0, validations = 0
  const value = await generateStructuredOutput('script_source_map', sourceMapSchema, async () => {
    calls++; return JSON.stringify(initial)
  }, prompt, { validate: parsed => { validations++; assert.deepEqual(parsed, candidate()) } })
  assert.deepEqual(value, candidate()); assert.equal(calls, 1); assert.equal(validations, 1)
  assert.deepEqual(initial, before)
})

test('duplicate aliases are removed only when their canonical text is identical', async () => {
  const initial: Record<string, any> = candidate()
  initial.sections[0].characters[0].details = initial.sections[0].characters[0].description
  initial.sections[0].events[0].description = initial.sections[0].events[0].summary
  let calls = 0
  const value = await generateStructuredOutput('script_source_map', sourceMapSchema, async () => {
    calls++; return JSON.stringify(initial)
  }, prompt)
  assert.deepEqual(value, candidate()); assert.equal(calls, 1)
})

test('conflicting aliases require correction instead of dropping either fact', async () => {
  for (const field of ['character', 'event'] as const) {
    const initial: Record<string, any> = candidate()
    if (field === 'character') initial.sections[0].characters[0].details = '另一个身份，不能直接删除。'
    else initial.sections[0].events[0].description = '另一个事件，不能直接删除。'
    let calls = 0
    const value = await generateStructuredOutput('script_source_map', sourceMapSchema, async text => {
      calls++; if (calls === 2) assert.match(text, /一次格式修正/)
      return JSON.stringify(calls === 1 ? initial : candidate())
    }, prompt)
    assert.deepEqual(value, candidate()); assert.equal(calls, 2)
  }
})

test('unknown semantic fields still require correction after known aliases normalize', async () => {
  for (const field of ['top', 'section', 'character', 'event'] as const) {
    const initial = aliases()
    if (field === 'top') Object.assign(initial, { document_kind: '正文', open_threads: ['独立全局事实'] })
    if (field === 'section') initial.sections[0].additional_fact = '章节额外事实'
    if (field === 'character') initial.sections[0].characters[0].identity = '未知身份'
    if (field === 'event') initial.sections[0].events[0].cause = '额外原因'
    let calls = 0
    const value = await generateStructuredOutput('script_source_map', sourceMapSchema, async () => {
      calls++; return JSON.stringify(calls === 1 ? initial : candidate())
    }, prompt)
    assert.deepEqual(value, candidate()); assert.equal(calls, 2)
  }
})

test('other contracts with identical fields retain their existing validation behavior', async () => {
  for (const name of ['other_directory', 'script_source_map_untrusted', 'script_source_story']) {
    let calls = 0
    const value = await generateStructuredOutput(name, sourceMapSchema, async () => {
      calls++; return JSON.stringify(calls === 1 ? aliases() : candidate())
    }, prompt)
    assert.deepEqual(value, candidate()); assert.equal(calls, 2)
  }
})

test('malformed JSON and non-string aliases cannot be accepted by normalization', async () => {
  const invalidAlias = aliases(); invalidAlias.sections[0].characters[0].details = { description: '嵌套新结构' }
  for (const initial of [JSON.stringify(aliases()).slice(0, -1), JSON.stringify(invalidAlias)]) {
    let calls = 0
    const value = await generateStructuredOutput('script_source_map', sourceMapSchema, async () => {
      calls++; return calls === 1 ? initial : JSON.stringify(candidate())
    }, prompt)
    assert.deepEqual(value, candidate()); assert.equal(calls, 2)
  }
})

test('normalized directory is stored canonically and replayed without another model request', async () => {
  const checkpoint: StructuredOutputCheckpoint = {}
  let calls = 0
  await generateStructuredOutput('script_source_map', sourceMapSchema, async () => {
    calls++; return JSON.stringify(aliases())
  }, prompt, { checkpoint })
  assert.equal(calls, 1); assert.deepEqual(JSON.parse(checkpoint.raw!), candidate())
  const value = await generateStructuredOutput('script_source_map', sourceMapSchema, async () => {
    assert.fail('complete directory replay cannot dispatch another request')
  }, prompt, { checkpoint: structuredClone(checkpoint) })
  assert.deepEqual(value, candidate())
  // A complete provider reply may have been saved before validation in an
  // older process. Replaying that raw checkpoint applies the same rules.
  const legacy = { ...checkpoint, raw: JSON.stringify(aliases()) }
  assert.deepEqual(await generateStructuredOutput('script_source_map', sourceMapSchema, async () => {
    assert.fail('saved alias-only raw output must normalize locally')
  }, prompt, { checkpoint: legacy }), candidate())
  assert.deepEqual(JSON.parse(legacy.raw!), candidate())
})

test('normalized fields still require independent business validation', async () => {
  let calls = 0, validations = 0
  await assert.rejects(generateStructuredOutput('script_source_map', sourceMapSchema, async () => {
    calls++; return JSON.stringify(aliases())
  }, prompt, { validate: () => { validations++; throw new Error('原文证据不支持该人物') } }), /原文证据不支持该人物/)
  assert.equal(calls, 2); assert.equal(validations, 2)
})


test('directory continuation normalizes only its known item aliases without another model call', async () => {
  const schema = z.object({ items: sourceMapSchema.shape.sections, complete: z.boolean() }).strict()
  let calls = 0
  const result = await generateStructuredOutput('script_source_map_page', schema, async () => {
    calls++; return JSON.stringify({ items: aliases().sections, complete: true })
  }, prompt)
  assert.equal(calls, 1)
  assert.deepEqual(result, { items: candidate().sections, complete: true })
})


for (const name of ['script_source_map', 'script_source_map_page'] as const) {
  for (const defaults of ['missing', 'wire-null', 'present'] as const) {
    test(`${name} repairs a missing leaf against canonical strings and ${defaults} defaults`, async () => {
      const initial: Record<string, any> = candidate(), expected = candidate()
      const section = initial.sections[0]
      delete section.episode_number
      section.title = `  ${section.title}  `
      section.summary = `  ${section.summary}  `
      section.characters[0].name = `  ${section.characters[0].name}  `
      section.characters[0].description = `  ${section.characters[0].description}  `
      section.events[0].summary = `  ${section.events[0].summary}  `
      if (defaults === 'missing') { delete section.continues_previous; delete section.open_threads }
      else if (defaults === 'wire-null') { section.continues_previous = null; section.open_threads = null }
      else section.open_threads = section.open_threads.map((thread: string) => `  ${thread}  `)
      expected.sections[0]!.episode_number = null as unknown as number
      if (defaults !== 'present') expected.sections[0]!.open_threads = []
      const before = structuredClone(initial)
      const paged = name.endsWith('_page')
      const schema = paged ? z.object({ items: sourceMapSchema.shape.sections, complete: z.boolean() }).strict() : sourceMapSchema
      let calls = 0
      const value = await generateStructuredOutput(name, schema, async (_request, contract) => {
        if (++calls === 1) return JSON.stringify(paged ? { items: initial.sections, complete: true } : initial)
        assert.equal(contract!.name, `${name}_structure_repair`)
        assert.deepEqual((contract!.schema.properties as any).repairs.required, ['repair_0'])
        return JSON.stringify({ repairs: { repair_0: null } })
      }, prompt, { structuralRepair: true })
      assert.equal(calls, 2)
      assert.deepEqual(value, paged ? { items: expected.sections, complete: true } : expected)
      assert.deepEqual(initial, before, 'canonicalization must not mutate the provider response')
    })
  }
}

test('source canonicalization retains unknown facts for guarded repair and preserves valid siblings against model rewrites', async () => {
  const initial: Record<string, any> = aliases(), expected = candidate()
  delete initial.sections[0].continues_previous
  initial.sections[0].open_threads = null
  initial.sections[0].summary = `  ${initial.sections[0].summary}  `
  initial.sections[0].characters[0].name = `  ${initial.sections[0].characters[0].name}  `
  initial.sections[0].characters[0].identity = '未知但有语义的身份字段，必须经过修复'
  expected.sections[0]!.open_threads = []
  let calls = 0
  const result = await generateStructuredOutput('script_source_map', sourceMapSchema, async (_request, contract) => {
    if (++calls === 1) return JSON.stringify(initial)
    assert.equal(contract!.name, 'script_source_map_structure_repair')
    return JSON.stringify({ repairs: { repair_0: { ...expected.sections[0]!.characters[0], name: '模型擅改姓名',
      description: '模型擅改了原身份', evidence: { unit_id: 999 } } } })
  }, prompt, { structuralRepair: true })
  assert.equal(calls, 2, 'unknown semantic fields cannot pass through local canonicalization')
  assert.deepEqual(result, expected, 'valid name, identity description and evidence remain from the original candidate')
})

test('source canonicalization does not coerce invalid default field types or discard conflicting aliases', async () => {
  for (const invalid of ['boolean', 'threads', 'alias'] as const) {
    const initial: Record<string, any> = candidate()
    if (invalid === 'boolean') initial.sections[0].continues_previous = 'false'
    else if (invalid === 'threads') initial.sections[0].open_threads = { fact: '未识别的线索内容' }
    else initial.sections[0].characters[0].details = '另一身份，不能静默覆盖description'
    let calls = 0
    const result = await generateStructuredOutput('script_source_map', sourceMapSchema, async () => {
      calls++; return JSON.stringify(calls === 1 ? initial : candidate())
    }, prompt)
    assert.equal(calls, 2, `${invalid} must still require model correction`)
    assert.deepEqual(result, candidate())
  }
})

test('a persisted raw directory replays canonical defaults and resumes only its exact missing-leaf repair', async () => {
  const initial: Record<string, any> = candidate(), expected = candidate(), checkpoint: StructuredOutputCheckpoint = {}
  delete initial.sections[0].episode_number
  delete initial.sections[0].continues_previous
  initial.sections[0].open_threads = null
  initial.sections[0].summary = `  ${initial.sections[0].summary}  `
  expected.sections[0]!.episode_number = null as unknown as number
  expected.sections[0]!.open_threads = []
  // Only a trusted pre-dispatch rejection releases the correction intent. An
  // ordinary disconnect is unknown and must never authorize a second call.
  const interruption = Object.assign(new TextProviderError('repair rejected before dispatch', false), { delivery: 'not_sent' as const })
  let initialCalls = 0
  await assert.rejects(generateStructuredOutput('script_source_map', sourceMapSchema, async (_request, contract) => {
    initialCalls++
    if (contract!.name.endsWith('_structure_repair')) throw interruption
    return JSON.stringify(initial)
  }, prompt, { checkpoint, structuralRepair: true }), issue => issue === interruption)
  assert.equal(initialCalls, 2)
  assert.deepEqual(JSON.parse(checkpoint.raw!), initial)
  const restored = structuredClone(checkpoint)
  let resumedCalls = 0
  const result = await generateStructuredOutput('script_source_map', sourceMapSchema, async (_request, contract) => {
    resumedCalls++
    assert.equal(contract!.name, 'script_source_map_structure_repair', 'do not request the original full directory again')
    return JSON.stringify({ repairs: { repair_0: null } })
  }, prompt, { checkpoint: restored, structuralRepair: true })
  assert.equal(resumedCalls, 1)
  assert.deepEqual(result, expected)
  assert.deepEqual(JSON.parse(restored.raw!), expected)
  assert.deepEqual(await generateStructuredOutput('script_source_map', sourceMapSchema, async () => {
    assert.fail('the normalized complete candidate must replay without another request')
  }, prompt, { checkpoint: restored, structuralRepair: true }), expected)
})

test('redundant event occurrence aliases normalize only when exactly equal to the primary numeric source ID', () => {
  const original = { sections: [{ events: [
    { summary: '事实', evidence: { unit_id: 3, occurrence_unit_id: 3, supporting_unit_ids: [4] } },
    { summary: '不同位置', evidence: { unit_id: 3, occurrence_unit_id: 8 } },
    { summary: '非法类型', evidence: { unit_id: '3', occurrence_unit_id: '3' } },
  ] }] }
  const copy = structuredClone(original)
  const normalized = normalizeSourceOutput('script_source_map', original) as typeof original
  assert.deepEqual(normalized.sections[0]!.events[0]!.evidence, { unit_id: 3, supporting_unit_ids: [4] })
  assert.deepEqual(normalized.sections[0]!.events[1], original.sections[0]!.events[1])
  assert.deepEqual(normalized.sections[0]!.events[2], original.sections[0]!.events[2])
  assert.deepEqual(original, copy)
})
