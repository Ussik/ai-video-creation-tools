import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { GenerationModel } from '../src/infrastructure/providers/providers.js'
import type { CreationSkillReferenceSelectionInput, CreationSkillSelector } from '../src/modules/skills/model-skill-selection.js'

const directory = await mkdtemp(join(tmpdir(), 'skill-reference-selection-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { initDb, db, all, run } = await import('../src/infrastructure/database/db.js')
const { initSkills, configureSkill, installSkillBundle, optionalSkillReferenceCatalog, readOptionalSkillReference, setSkillTaskDefault, skillContext, skillPolicy, skillTaskPolicies } = await import('../src/modules/skills/skills.js')
const { chooseCreationSkillReferences, clearCreationSkillSelectionCache, resolveCreationSkillContext } = await import('../src/modules/skills/model-skill-selection.js')
initDb()
initSkills()
run("INSERT INTO projects(id,name,created_at,updated_at) VALUES('project','补充资料','now','now')")
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
function bundle(name: string, revision = 'a'.repeat(40), content = '# 人物选择的后果\n' + '摘要。'.repeat(100) + '\nDEEP_REFERENCE_RULE') {
  return { repo: 'fixture/reference-selection', path: name, name, description: '按人物选择推进冲突', revision,
    license: null, tool_requirements: [] as string[], suggested_stages: ['image_prompt' as const], url: '', files: [
      { path: `${name}/SKILL.md`, content: `---\nname: ${name}\ndescription: 人物选择\n---\nMAIN_RULE` },
      { path: `${name}/references/stage-contract.md`, content: 'MANDATORY_CONTRACT' },
      { path: `${name}/references/decisions.md`, content },
      { path: `${name}/references/unused.md`, content: '# 无关资料\nUNSELECTED_REFERENCE_RULE' },
      { path: `${name}/references/context.json`, content: '{"continuity":"保存设定"}' },
    ] }
}
function install(name: string) {
  const skill = installSkillBundle(bundle(name))
  configureSkill(skill.id, true, ['image_prompt'])
  return skill.id
}
const provider = { adapter: 'http' as const, base_url: 'https://reference-selection.invalid/v1' }
const model = (protocol: 'responses' | 'chat_completions'): GenerationModel => ({ id: 'text', remote_id: 'mock', modality: 'text', protocol,
  settings: { request_path: protocol === 'responses' ? 'responses' : 'chat/completions', stream: false,
    request_template: protocol === 'responses' ? { model: '{{model}}', input: '{{prompt}}' }
      : { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] } } })
function tool(protocol: 'responses' | 'chat_completions', name: string, args: unknown, index: number) {
  const argumentsText = JSON.stringify(args)
  return protocol === 'responses' ? Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: `call-${index}`, name, arguments: argumentsText }] })
    : Response.json({ choices: [{ message: { tool_calls: [{ id: `call-${index}`, type: 'function', function: { name, arguments: argumentsText } }] }, finish_reason: 'tool_calls' }] })
}
function text(protocol: 'responses' | 'chat_completions', value: string) {
  return protocol === 'responses'
    ? Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }] }] })
    : Response.json({ choices: [{ message: { role: 'assistant', content: value }, finish_reason: 'stop' }] })
}
function referenceInput(skillId: string): CreationSkillReferenceSelectionInput {
  const context = skillContext('image_prompt', '确认人物决心。', [skillId])
  return { stage: 'image_prompt', task: '确认人物决心。', skill_ids: [skillId], loaded_rules: context.text,
    catalog: optionalSkillReferenceCatalog('image_prompt', [skillId]), available_characters: 100_000 - context.text.length }
}

test('optional reference loading is available to manual, fixed and automatic selections without changing chosen skills', async () => {
  const skillId = install('selection-modes'), catalog = optionalSkillReferenceCatalog('image_prompt', [skillId])
  const chosen = catalog.find(file => file.path.endsWith('decisions.md'))!
  setSkillTaskDefault('image_prompt', { primary_id: skillId, auxiliary_ids: [] })
  const before = JSON.stringify(all('SELECT * FROM skill_task_defaults'))
  for (const mode of ['manual', 'fixed', 'automatic']) {
    clearCreationSkillSelectionCache()
    let selections = 0, references = 0
    const select: CreationSkillSelector = Object.assign(async () => { selections++; return { skill_ids: [skillId], reason: '理解人物选择。' } }, {
      references: async (_project: string, _model: string, input: CreationSkillReferenceSelectionInput) => {
        references++; assert.deepEqual(input.skill_ids, [skillId]); assert.ok(input.catalog.some(file => file.id === chosen.id))
        assert.doesNotMatch(JSON.stringify(input), /DEEP_REFERENCE_RULE/)
        return { reference_ids: [chosen.id], reason: '参考人物选择的后果。' }
      },
    })
    const result = await resolveCreationSkillContext({ projectId: 'project', modelId: 'model', stage: 'image_prompt', task: '让他的抉择改变同伴命运。',
      ...(mode === 'manual' ? { selectedIds: [skillId] } : {}), ...(mode === 'automatic' ? { assignmentTask: { selection_mode: 'model' as const } } : {}),
      select, generate: async () => { throw new Error('Unexpected model generation') } })
    assert.equal(result.assignment.source, mode); assert.equal(selections, mode === 'automatic' ? 1 : 0); assert.equal(references, 1)
    assert.match(result.text, /MAIN_RULE/); assert.match(result.text, /MANDATORY_CONTRACT/); assert.match(result.text, /DEEP_REFERENCE_RULE/)
    assert.doesNotMatch(result.text, /UNSELECTED_REFERENCE_RULE/)
    assert.ok(result.files.includes(chosen.path))
  }
  assert.equal(JSON.stringify(all('SELECT * FROM skill_task_defaults')), before)
})

test('native retrieval reads only installed locked files and submits by Function Calling on both protocols', async t => {
  const skillId = install('native-reading'), context = skillContext('image_prompt', '确认人物决心。', [skillId])
  const catalog = optionalSkillReferenceCatalog('image_prompt', [skillId]), chosen = catalog.find(file => file.path.endsWith('decisions.md'))!
  const input: CreationSkillReferenceSelectionInput = { stage: 'image_prompt', task: '确认人物决心。', skill_ids: [skillId],
    loaded_rules: context.text, catalog, available_characters: 100_000 - context.text.length }
  for (const protocol of ['responses', 'chat_completions'] as const) {
    let requests = 0
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); requests++
      assert.ok(body.tools.some((item: any) => (item.name || item.function.name) === 'read_skill_reference'))
      if (requests === 1) { assert.doesNotMatch(JSON.stringify(body), /DEEP_REFERENCE_RULE/); return tool(protocol, 'read_skill_reference', { reference_id: 'outside:/etc/passwd' }, requests) }
      if (requests === 2) { assert.match(JSON.stringify(body), /不属于本次锁定技能目录/); return tool(protocol, 'read_skill_reference', { reference_id: chosen.id }, requests) }
      assert.match(JSON.stringify(body), /DEEP_REFERENCE_RULE/)
      return tool(protocol, 'submit_skill_references', { reference_ids: [chosen.id], reason: '已读人物选择资料。' }, requests)
    })
    const result = await chooseCreationSkillReferences(model(protocol), provider, input, () => '')
    assert.deepEqual(result.reference_ids, [chosen.id]); assert.equal(requests, 3)
    t.mock.restoreAll()
  }
})

test('a complete validated JSON reference choice finishes the first text-only response on both protocols', async t => {
  const input = referenceInput(install('text-only-choice')), choice = { reference_ids: [input.catalog[0]!.id], reason: '元信息已足够选择。' }
  for (const protocol of ['responses', 'chat_completions'] as const) for (const fenced of [false, true]) await t.test(`${protocol}:${fenced}`, async () => {
    let requests = 0
    t.mock.method(globalThis, 'fetch', async () => { requests++; return text(protocol,
      fenced ? `\`\`\`json\n${JSON.stringify(choice)}\n\`\`\`` : JSON.stringify(choice)) })
    assert.deepEqual(await chooseCreationSkillReferences(model(protocol), provider, input, () => ''), choice)
    assert.equal(requests, 1, 'a valid selection must not resend the complete task six times')
    t.mock.restoreAll()
  })
})

test('reference tools advertise exact catalog IDs and a real submission example on both protocols', async t => {
  const populated = referenceInput(install('catalog-bound-tool-contract'))
  for (const protocol of ['responses', 'chat_completions'] as const) for (const strict of [false, true]) for (const empty of [false, true]) {
    await t.test(`${protocol}:${strict}:${empty}`, async () => {
      const input = empty ? { ...populated, catalog: [] } : populated
      const configured = model(protocol)
      configured.settings = { ...configured.settings as Record<string, unknown>, strict_tool_arguments: strict }
      let requests = 0
      t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        requests++
        const body = JSON.parse(String(init.body))
        const definitions = body.tools.map((item: any) => protocol === 'responses' ? item : item.function)
        const read = definitions.find((item: any) => item.name === 'read_skill_reference').parameters
        const submit = definitions.find((item: any) => item.name === 'submit_skill_references').parameters
        if (empty) assert.equal(submit.properties.reference_ids.maxItems, 0)
        else {
          const ids = input.catalog.map(file => file.id)
          assert.deepEqual(read.properties.reference_id.enum, ids)
          assert.deepEqual(submit.properties.reference_ids.items.enum, ids)
          const prompt = protocol === 'responses' ? body.input[0].content : body.messages[0].content
          assert.ok(prompt.includes(`\"reference_ids\":${JSON.stringify([ids[0]])}`), 'the example must use a current exact catalog ID')
          assert.doesNotMatch(prompt, /目录中的精确ID/)
        }
        return tool(protocol, 'submit_skill_references', { reference_ids: [], reason: '目录规则已足够。' }, requests)
      })
      assert.deepEqual(await chooseCreationSkillReferences(configured, provider, input, () => ''), { reference_ids: [], reason: '目录规则已足够。' })
      assert.equal(requests, 1)
      t.mock.restoreAll()
    })
  }
})

test('invalid reference submissions receive safe catalog and budget guidance before a corrected selection', async t => {
  const base = referenceInput(install('catalog-bound-correction'))
  const chosen = base.catalog.find(file => file.path.endsWith('decisions.md'))!
  const small = base.catalog.find(file => file.path.endsWith('unused.md'))!
  const privateReason = 'PRIVATE_INSTRUCTION_MUST_NOT_BE_ECHOED'
  const variants = [
    { kind: 'unknown_reference', input: base, ids: [chosen.path], corrected: [chosen.id] },
    { kind: 'duplicate_reference', input: base, ids: [chosen.id, chosen.id], corrected: [chosen.id] },
    // The body alone fits; reference framing must count toward the budget.
    { kind: 'budget_exceeded', input: { ...base, available_characters: chosen.characters }, ids: [chosen.id], corrected: [small.id] },
  ]
  for (const protocol of ['responses', 'chat_completions'] as const) for (const variant of variants) await t.test(`${protocol}:${variant.kind}`, async () => {
    let requests = 0
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      requests++
      if (requests === 1) return tool(protocol, 'submit_skill_references', { reference_ids: variant.ids, reason: privateReason }, requests)
      const body = JSON.parse(String(init.body))
      const results = protocol === 'responses' ? body.input.filter((item: any) => item.type === 'function_call_output').map((item: any) => item.output)
        : body.messages.filter((item: any) => item.role === 'tool').map((item: any) => item.content)
      const correction = JSON.parse(results.at(-1))
      assert.deepEqual(correction.allowed_reference_ids, variant.input.catalog.map(file => file.id))
      assert.equal(correction.available_characters, variant.input.available_characters)
      assert.match(JSON.stringify(correction), new RegExp(variant.kind))
      assert.doesNotMatch(JSON.stringify(correction), new RegExp(privateReason))
      if (variant.kind === 'budget_exceeded') {
        const framedCharacters = chosen.characters + `\n\n参考资料 ${chosen.path}：\n`.length
        assert.match(JSON.stringify(correction), new RegExp(String(framedCharacters)))
      }
      return tool(protocol, 'submit_skill_references', { reference_ids: variant.corrected, reason: '已根据有效目录和预算修正。' }, requests)
    })
    const choice = await chooseCreationSkillReferences(model(protocol), provider, variant.input, () => '')
    assert.deepEqual(choice.reference_ids, variant.corrected)
    assert.equal(requests, 2, 'an invalid selection must be corrected rather than silently normalized or defaulted')
    t.mock.restoreAll()
  })
})

test('persisted reference diagnostics distinguish unknown, duplicate, budget, schema and JSON failures safely', async t => {
  const base = referenceInput(install('catalog-bound-diagnostics')), chosen = base.catalog[0]!
  const privateText = 'PRIVATE_REFERENCE_VALUE_MUST_NOT_ENTER_DIAGNOSTICS'
  const variants = [
    { kind: 'unknown_reference', input: base, value: { reference_ids: [privateText], reason: privateText }, fields: ['reference_ids'] },
    { kind: 'duplicate_reference', input: base, value: { reference_ids: [chosen.id, chosen.id], reason: privateText }, fields: ['reference_ids'] },
    { kind: 'budget_exceeded', input: { ...base, available_characters: 0 }, value: { reference_ids: [chosen.id], reason: privateText }, fields: ['reference_ids'] },
    { kind: 'schema', input: base, value: { reference_ids: privateText, reason: privateText }, fields: ['reference_ids'] },
    { kind: 'invalid_json', input: base, value: null, fields: ['$'] },
  ]
  for (const protocol of ['responses', 'chat_completions'] as const) for (const variant of variants) await t.test(`${protocol}:${variant.kind}`, async () => {
    let requests = 0
    t.mock.method(globalThis, 'fetch', async () => {
      requests++
      return variant.kind === 'invalid_json' ? text(protocol, `{"reference_ids":[${privateText}`)
        : tool(protocol, 'submit_skill_references', variant.value, requests)
    })
    await assert.rejects(chooseCreationSkillReferences(model(protocol), provider, variant.input, () => ''), (error: any) => {
      assert.equal(error.code, 'creation_skill_reference_selection_failed')
      assert.deepEqual(error.diagnostic.fields, variant.fields)
      assert.ok(error.diagnostic.issues.includes(variant.kind))
      assert.doesNotMatch(JSON.stringify({ message: error.message, diagnostic: error.diagnostic }), new RegExp(privateText))
      return true
    })
    assert.equal(requests, 2)
    t.mock.restoreAll()
  })
})

test('invalid text-only choices receive field diagnostics and can correct through the submission tool', async t => {
  const input = referenceInput(install('text-only-correction')), choice = { reference_ids: [input.catalog[0]!.id], reason: '补齐选择理由。' }
  for (const protocol of ['responses', 'chat_completions'] as const) await t.test(protocol, async () => {
    let requests = 0
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      requests++
      if (requests === 1) return text(protocol, JSON.stringify({ reference_ids: [] }))
      assert.match(String(init.body), /reason/)
      assert.match(String(init.body), /字段校验|字段不符/)
      return tool(protocol, 'submit_skill_references', choice, requests)
    })
    assert.deepEqual(await chooseCreationSkillReferences(model(protocol), provider, input, () => ''), choice)
    assert.equal(requests, 2)
    t.mock.restoreAll()
  })
})

test('missing calls and invalid selections stop after one correction with safe, precise diagnostics', async t => {
  const input = referenceInput(install('selection-no-progress')), privateText = 'PRIVATE_MANUSCRIPT_MUST_NOT_ENTER_DIAGNOSTICS'
  for (const protocol of ['responses', 'chat_completions'] as const) for (const kind of ['no_calls', 'invalid_selection'] as const) await t.test(`${protocol}:${kind}`, async () => {
    let requests = 0
    t.mock.method(globalThis, 'fetch', async () => { requests++; return text(protocol, kind === 'no_calls' ? privateText
      : JSON.stringify({ reference_ids: ['outside:/etc/passwd'], reason: privateText })) })
    await assert.rejects(chooseCreationSkillReferences(model(protocol), provider, input, () => ''), (error: any) => {
      assert.equal(error.code, 'creation_skill_reference_selection_failed')
      assert.equal(error.statusCode, 502)
      assert.equal(error.diagnostic.reason, kind)
      assert.equal(error.diagnostic.rounds, 2)
      assert.equal(error.diagnostic.stop_reason, 'no_progress')
      assert.equal(error.diagnostic.response_type, kind === 'no_calls' ? 'text' : 'json')
      if (kind === 'invalid_selection') assert.deepEqual(error.diagnostic.fields, ['reference_ids'])
      assert.doesNotMatch(JSON.stringify({ message: error.message, diagnostic: error.diagnostic }), new RegExp(privateText))
      return true
    })
    assert.equal(requests, 2)
    t.mock.restoreAll()
  })
})

test('a valid submission may share a turn with successful read-only catalog retrieval', async t => {
  const input = referenceInput(install('read-and-submit')), choice = { reference_ids: [input.catalog[0]!.id], reason: '选择目录资料。' }
  for (const protocol of ['responses', 'chat_completions'] as const) await t.test(protocol, async () => {
    let requests = 0
    t.mock.method(globalThis, 'fetch', async () => {
      requests++
      const read = await tool(protocol, 'read_skill_reference', { reference_id: choice.reference_ids[0] }, 1).json() as any
      const submit = await tool(protocol, 'submit_skill_references', choice, 2).json() as any
      if (protocol === 'responses') read.output.push(...submit.output)
      else read.choices[0].message.tool_calls.push(...submit.choices[0].message.tool_calls)
      return Response.json(read)
    })
    assert.deepEqual(await chooseCreationSkillReferences(model(protocol), provider, input, () => ''), choice)
    assert.equal(requests, 1)
    t.mock.restoreAll()
  })
})

test('text choices cannot bypass duplicate, rule-budget or strict-field validation', async t => {
  const input = referenceInput(install('text-choice-validation'))
  const variants = [
    { input, choice: { reference_ids: [input.catalog[0]!.id, input.catalog[0]!.id], reason: '重复选择。' }, field: 'reference_ids' },
    { input: { ...input, available_characters: 0 }, choice: { reference_ids: [input.catalog[0]!.id], reason: '超过预算。' }, field: 'reference_ids' },
    { input, choice: { reference_ids: [], reason: '不得带入正文。', content: 'PRIVATE_CREATIVE_BODY' }, field: '$' },
  ]
  for (const protocol of ['responses', 'chat_completions'] as const) for (const variant of variants) await t.test(`${protocol}:${variant.field}:${variant.choice.reason}`, async () => {
    let requests = 0
    t.mock.method(globalThis, 'fetch', async () => { requests++; return text(protocol, JSON.stringify(variant.choice)) })
    await assert.rejects(chooseCreationSkillReferences(model(protocol), provider, variant.input, () => ''), (error: any) => {
      assert.equal(error.diagnostic.reason, 'invalid_selection')
      assert.deepEqual(error.diagnostic.fields, [variant.field])
      assert.doesNotMatch(JSON.stringify(error.diagnostic), /PRIVATE_CREATIVE_BODY/)
      return true
    })
    assert.equal(requests, 2)
    t.mock.restoreAll()
  })
})

test('malformed selection arrays retain bounded schema paths rather than provider output', async t => {
  const input = referenceInput(install('bounded-selection-diagnostics'))
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return tool('responses', 'submit_skill_references', { reference_ids: Array.from({ length: 100 }, (_, index) => index), reason: '检查字段数量上限。' }, requests)
  })
  await assert.rejects(chooseCreationSkillReferences(model('responses'), provider, input, () => ''), (error: any) => {
    assert.equal(error.diagnostic.reason, 'invalid_selection')
    assert.equal(error.diagnostic.fields.length, 12)
    assert.equal(error.diagnostic.fields[0], 'reference_ids[0]')
    assert.equal(error.diagnostic.fields.at(-1), 'reference_ids[11]')
    assert.ok(error.message.length < 500)
    return true
  })
  assert.equal(requests, 2)
})

test('a valid submission never hides a failed read or unknown call regardless of call order', async t => {
  const input = referenceInput(install('mixed-invalid-choice')), choice = { reference_ids: [], reason: '无需资料。' }
  for (const protocol of ['responses', 'chat_completions'] as const) for (const submitFirst of [false, true]) for (const name of ['read_skill_reference', 'untrusted_tool']) {
    await t.test(`${protocol}:${submitFirst}:${name}`, async () => {
      let requests = 0
      t.mock.method(globalThis, 'fetch', async () => {
        requests++
        const read = await tool(protocol, name, { reference_id: 'outside:/etc/passwd' }, 1).json() as any
        const submit = await tool(protocol, 'submit_skill_references', choice, 2).json() as any
        if (protocol === 'responses') read.output = submitFirst ? [...submit.output, ...read.output] : [...read.output, ...submit.output]
        else read.choices[0].message.tool_calls = submitFirst
          ? [...submit.choices[0].message.tool_calls, ...read.choices[0].message.tool_calls]
          : [...read.choices[0].message.tool_calls, ...submit.choices[0].message.tool_calls]
        return Response.json(read)
      })
      await assert.rejects(chooseCreationSkillReferences(model(protocol), provider, input, () => ''), (error: any) => {
        assert.equal(error.diagnostic.reason, 'invalid_selection')
        assert.deepEqual(error.diagnostic.fields, [name === 'read_skill_reference' ? 'reference_id' : 'tools'])
        assert.ok(error.diagnostic.tool_names.includes(name === 'read_skill_reference' ? name : 'unknown'))
        return true
      })
      assert.equal(requests, 2)
      t.mock.restoreAll()
    })
  }
})

test('repeated reads stop for lack of progress and productive reading reserves a final submission round', async t => {
  const name = 'reference-reading-limit', pack = bundle(name)
  for (let index = 0; index < 6; index++) pack.files.push({ path: `${name}/references/extra-${index}.md`, content: `# 资料${index}\n只读补充。` })
  const skill = installSkillBundle(pack); configureSkill(skill.id, true, ['image_prompt'])
  const input = referenceInput(skill.id)
  for (const protocol of ['responses', 'chat_completions'] as const) for (const progressing of [false, true]) await t.test(`${protocol}:${progressing}`, async () => {
    let requests = 0
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      requests++
      if (progressing && requests === 6) assert.match(String(init.body), /停止读取.*只提交最终选择/)
      return tool(protocol, 'read_skill_reference', { reference_id: input.catalog[progressing ? requests - 1 : 0]!.id }, requests)
    })
    await assert.rejects(chooseCreationSkillReferences(model(protocol), provider, input, () => ''), (error: any) => {
      assert.equal(error.diagnostic.reason, 'read_limit')
      assert.equal(error.diagnostic.rounds, progressing ? 6 : 3)
      assert.equal(error.diagnostic.stop_reason, progressing ? 'round_limit' : 'no_progress')
      assert.equal(error.diagnostic.response_type, 'tools')
      return true
    })
    assert.equal(requests, progressing ? 6 : 3)
    t.mock.restoreAll()
  })
})

test('reference revision conflicts and cancellation pass through without a selection retry', async t => {
  const name = 'reference-terminal-errors', skillId = install(name), input = referenceInput(skillId)
  await t.test('revision drift', async () => {
    let requests = 0
    t.mock.method(globalThis, 'fetch', async () => {
      requests++
      installSkillBundle(bundle(name, 'b'.repeat(40)), skillId); configureSkill(skillId, true, ['image_prompt'])
      return tool('responses', 'read_skill_reference', { reference_id: input.catalog[0]!.id }, requests)
    })
    await assert.rejects(chooseCreationSkillReferences(model('responses'), provider, input, () => ''), (error: any) => error.statusCode === 409)
    assert.equal(requests, 1)
    t.mock.restoreAll()
  })
  await t.test('cancelled request', async () => {
    const controller = new AbortController(); let requests = 0
    t.mock.method(globalThis, 'fetch', async () => {
      requests++; controller.abort()
      return tool('responses', 'submit_skill_references', { reference_ids: [], reason: '不应接受已取消的选择。' }, requests)
    })
    await assert.rejects(chooseCreationSkillReferences(model('responses'), provider, input, () => '', controller.signal), (error: any) => error.name === 'AbortError')
    assert.equal(requests, 1)
    t.mock.restoreAll()
  })
})

test('structured selection fallback chooses from metadata and context loading still validates exact IDs', async () => {
  const skillId = install('structured-fallback'), catalog = optionalSkillReferenceCatalog('image_prompt', [skillId]), chosen = catalog[0]!
  clearCreationSkillSelectionCache()
  let contracts: string[] = []
  const result = await resolveCreationSkillContext({ projectId: 'project', modelId: 'model', stage: 'image_prompt', task: '确定行动的后果。', selectedIds: [skillId],
    generate: async (prompt, contract) => { contracts.push(contract!.name); assert.doesNotMatch(prompt, /DEEP_REFERENCE_RULE/)
      const properties = contract!.schema.properties as Record<string, any>
      assert.deepEqual(properties.reference_ids.items.enum, catalog.map(file => file.id))
      return JSON.stringify({ reference_ids: [chosen.id], reason: '补充行动后果规则。' }) } })
  assert.deepEqual(contracts, ['creation_skill_reference_selection']); assert.match(result.text, /DEEP_REFERENCE_RULE/)
  const data = catalog.find(file => file.path.endsWith('.json'))!
  assert.match(skillContext('image_prompt', '', [skillId], undefined, undefined, [data.id]).text, /"continuity":"保存设定"/)
  assert.throws(() => skillContext('image_prompt', '', [skillId], undefined, undefined, ['foreign:file']), /不属于本次技能/)
})

test('optional choices are reused only for identical task, catalog contents and model configuration', async () => {
  const skillId = install('reference-cache'); clearCreationSkillSelectionCache()
  let requests = 0
  const select: CreationSkillSelector = Object.assign(async () => ({ skill_ids: [skillId], reason: '锁定。' }), {
    references: async (_project: string, _model: string, input: CreationSkillReferenceSelectionInput) => { requests++
      return { reference_ids: [input.catalog[0]!.id], reason: '本次需要该资料。' } },
  })
  const options = { projectId: 'project', modelId: 'model', stage: 'image_prompt' as const, task: '同一任务。', selectedIds: [skillId],
    select, reuseKey: 'config-a', generate: async () => { throw new Error('Unexpected generation') } }
  await resolveCreationSkillContext(options); await resolveCreationSkillContext(options); assert.equal(requests, 1)
  await resolveCreationSkillContext({ ...options, task: '不同任务。' }); assert.equal(requests, 2)
  await resolveCreationSkillContext({ ...options, reuseKey: 'config-b' }); assert.equal(requests, 3)
  installSkillBundle(bundle('reference-cache', 'a'.repeat(40), '# 内容变化\nCHANGED_REFERENCE'), skillId)
  configureSkill(skillId, true, ['image_prompt'])
  const changed = await resolveCreationSkillContext(options)
  assert.equal(requests, 4); assert.match(changed.text, /CHANGED_REFERENCE/)
})

test('revision drift, foreign selections and total rule budget fail explicitly instead of silently falling back', async () => {
  const skillId = install('reference-drift'), descriptor = optionalSkillReferenceCatalog('image_prompt', [skillId])[0]!
  installSkillBundle(bundle('reference-drift', 'b'.repeat(40)), skillId); configureSkill(skillId, true, ['image_prompt'])
  assert.throws(() => readOptionalSkillReference('image_prompt', [skillId], descriptor), /已更新/)
  clearCreationSkillSelectionCache()
  const select: CreationSkillSelector = Object.assign(async () => ({ skill_ids: [skillId], reason: '锁定。' }), {
    references: async () => ({ reference_ids: ['unlocked:file.md'], reason: '错误选择。' }),
  })
  await assert.rejects(resolveCreationSkillContext({ projectId: 'project', modelId: 'model', stage: 'image_prompt', task: '读取资料。', selectedIds: [skillId], select,
    generate: async () => { throw new Error('Unexpected generation') } }), /目录外文件/)
  installSkillBundle(bundle('reference-drift', 'c'.repeat(40), '长'.repeat(100_000)), skillId); configureSkill(skillId, true, ['image_prompt'])
  const large = optionalSkillReferenceCatalog('image_prompt', [skillId])[0]!
  assert.throws(() => skillContext('image_prompt', '', [skillId], undefined, undefined, [large.id]), /过长|超过/)
})

test('reference choices are not reused without an explicit model configuration key', async () => {
  const skillId = install('reference-no-config-cache'); clearCreationSkillSelectionCache()
  let requests = 0
  const select: CreationSkillSelector = Object.assign(async () => ({ skill_ids: [skillId], reason: '锁定。' }), {
    references: async (_project: string, _model: string, input: CreationSkillReferenceSelectionInput) => {
      requests++
      return { reference_ids: [input.catalog[0]!.id], reason: '读取本次模型选择的资料。' }
    },
  })
  const options = { projectId: 'project', modelId: 'model', stage: 'image_prompt' as const, task: '配置可能已变更。', selectedIds: [skillId],
    select, generate: async () => { throw new Error('Unexpected generation') } }
  await resolveCreationSkillContext(options)
  await resolveCreationSkillContext(options)
  assert.equal(requests, 2)
})

test('tool-dependent skills disclose rules-only integration in real selection catalogs and loaded rules without rewriting defaults', async () => {
  const source = bundle('tool-dependent-character-refs')
  source.tool_requirements = ['Read', 'Bash', '外部生成 CLI']
  const skill = installSkillBundle(source)
  configureSkill(skill.id, true, ['image_prompt'])
  const before = JSON.stringify(all('SELECT * FROM skill_task_defaults'))
  const entry = skillPolicy().find(policy => policy.stage === 'image_prompt')!.skills.find(item => item.id === skill.id)!
  assert.equal(entry.integration?.mode, 'rules_only')
  assert.deepEqual(entry.integration.tool_requirements, source.tool_requirements)
  assert.match(entry.integration.note, /工具、脚本及其产物未接入/)
  assert.deepEqual(skillTaskPolicies().find(policy => policy.task === 'image_prompt')!.skills.find(item => item.id === skill.id), entry)
  let selections = 0
  const select: CreationSkillSelector = Object.assign(async (_project: string, _model: string, input: Parameters<CreationSkillSelector>[2]) => {
    selections++
    assert.deepEqual(input.skills.find(item => item.id === skill.id), entry)
    return { skill_ids: [skill.id], reason: '仅采用人物身份一致性规则。' }
  }, { references: async () => ({ reference_ids: [], reason: '本次不需要工具产物。' }) })
  const result = await resolveCreationSkillContext({ projectId: 'project', modelId: 'model', stage: 'image_prompt', task: '整理人物参考规则。',
    assignmentTask: { selection_mode: 'model' }, select, generate: async () => { throw new Error('Unexpected generation') } })
  assert.equal(selections, 1)
  assert.deepEqual(result.assignment.ids, [skill.id])
  assert.match(result.text, /接入范围 rules_only/)
  assert.match(result.text, /外部生成 CLI/)
  assert.match(result.text, /不宣称已执行工具或得到其产物/)
  assert.equal(JSON.stringify(all('SELECT * FROM skill_task_defaults')), before)
})

test('configured dialect excludes incompatible references from both catalogs and loading while unknown targets retain them', () => {
  const source = bundle('novel-storyboard')
  const dialects = ['seedance-2.0', 'seedance-2.5', 'minimax-h3', 'wan-3.0'] as const
  source.files.push(...[...dialects, 'h3-prompt', 'seedance-prompt'].map(name => ({ path: `${source.path}/references/${name}.md`, content: `# ${name}\nDIALECT_${name}` })))
  const skill = installSkillBundle(source)
  configureSkill(skill.id, true, ['video_prompt', 'storyboard'])
  const allReferences = optionalSkillReferenceCatalog('video_prompt', [skill.id])
  assert.equal(allReferences.filter(file => file.path.match(/(?:seedance|h3|wan)/)).length, 6)
  assert.deepEqual(optionalSkillReferenceCatalog('video_prompt', [skill.id], { target_model: 'custom-unknown' }), allReferences)
  assert.deepEqual(skillContext('video_prompt', '故事中的台词提到 Seedance 2.5 和 MiniMax H3', [skill.id]).files,
    skillContext('video_prompt', '整理视频', [skill.id]).files, 'creative prose cannot determine the model dialect')
  for (const dialect of dialects) {
    const context = { target_dialect: dialect, target_model: 'custom-display-name' }
    const catalog = optionalSkillReferenceCatalog('video_prompt', [skill.id], context)
    assert.ok(catalog.some(file => file.path.endsWith('decisions.md')), 'ordinary creative references remain available')
    assert.ok(!catalog.some(file => /(?:seedance|h3|wan)/.test(file.path)), 'matching dialect is mandatory, incompatible dialects are absent')
    const loaded = skillContext('video_prompt', '', [skill.id], undefined, context)
    assert.ok(loaded.files.some(path => path.endsWith(`${dialect}.md`)))
    for (const other of dialects.filter(value => value !== dialect)) {
      const excluded = allReferences.find(file => file.path.endsWith(`${other}.md`))!
      assert.ok(!loaded.files.includes(excluded.path))
      assert.throws(() => skillContext('video_prompt', '', [skill.id], undefined, context, [excluded.id]), /不属于本次技能/)
      assert.throws(() => readOptionalSkillReference('video_prompt', [skill.id], excluded, context), /已更新或不属于/)
    }
    const storyboardCatalog = optionalSkillReferenceCatalog('storyboard', [skill.id], context)
    assert.ok(storyboardCatalog.some(file => file.path.endsWith(`${dialect}.md`)), 'storyboard may optionally load the compatible dialect')
    assert.ok(!storyboardCatalog.some(file => dialects.some(other => other !== dialect && file.path.endsWith(`${other}.md`))))
  }
  const explicit = skillContext('video_prompt', '', [skill.id], undefined, { target_model: 'minimax-h3', target_dialect: 'seedance-2.5' })
  assert.ok(explicit.files.some(path => path.endsWith('seedance-2.5.md')))
  assert.ok(!explicit.files.some(path => path.endsWith('minimax-h3.md')))
  const unknownSource = bundle('unknown-seedance-guide')
  unknownSource.files.push({ path: `${unknownSource.path}/references/seedance-prompt.md`, content: '# 未声明版本的参考文档\nUNKNOWN_DIALECT_REFERENCE' })
  const unknownSkill = installSkillBundle(unknownSource)
  configureSkill(unknownSkill.id, true, ['video_prompt'])
  const unknownReference = optionalSkillReferenceCatalog('video_prompt', [unknownSkill.id], { target_dialect: 'seedance-2.5' })
    .find(file => file.path.endsWith('seedance-prompt.md'))!
  assert.ok(unknownReference, 'an unversioned document in an unknown skill must not inherit Shuohao-specific compatibility')
  assert.match(skillContext('video_prompt', '', [unknownSkill.id], undefined, { target_dialect: 'seedance-2.5' }, [unknownReference.id]).text, /UNKNOWN_DIALECT_REFERENCE/)
})
