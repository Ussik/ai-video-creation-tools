import { sourceScopeResponse } from './helpers/source-scope-response.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { ZipFile } from 'yazl'
import { scriptStageArtifacts, scriptStageOrder, scriptArtifactLabels } from '@video-studio/shared/script/script-stage-content'
import { sourceAnalysisFixture } from './fixtures/script-source-analysis.js'
import { workflowFixtureTypes } from './fixtures/script-workflow.js'
import { draftCompletenessFixtureResponse } from './fixtures/script-draft-completeness.js'

const testData = await mkdtemp(join(tmpdir(), 'studio-script-source-'))
process.env.VIDEO_STUDIO_DATA_DIR = testData
const { extractScriptText, scriptSourceContext, scriptSourceIndex, readScriptSource, searchScriptSource } = await import('../src/modules/script/script-source-documents.js')
const { commitScriptSourceUpdate } = await import('../src/modules/script/script-source-versions.js')
const { buildApp } = await import('../src/app.js')
const { db } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(testData, { recursive: true, force: true }) })

function pdfFixture(text: string) {
  const stream = `BT /F1 12 Tf 50 750 Td (${text}) Tj ET`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = body.length
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(body)
}

async function docxFixture() {
  const zip = new ZipFile()
  zip.addBuffer(Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'), '[Content_Types].xml')
  zip.addBuffer(Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'), '_rels/.rels')
  zip.addBuffer(Buffer.from('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第1集：回家</w:t></w:r></w:p><w:p><w:r><w:t>林舟：我回来了。</w:t></w:r></w:p></w:body></w:document>'), 'word/document.xml')
  const chunks: Buffer[] = []
  const result = new Promise<Buffer>((resolve, reject) => { zip.outputStream.on('data', chunk => chunks.push(chunk)); zip.outputStream.on('end', () => resolve(Buffer.concat(chunks))); zip.outputStream.on('error', reject) })
  zip.end()
  return result
}

async function upload(projectId: string, filename: string, content: Buffer, modelId?: string) {
  const boundary = 'script-source-boundary'
  return app.inject({ method: 'POST', url: `/api/projects/${projectId}/script/source${modelId ? `?model_id=${modelId}` : ''}`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), content, Buffer.from(`\r\n--${boundary}--\r\n`)]) })
}

test('TXT, Markdown, DOCX and PDF extract full readable text including dialogue and final paragraphs', async () => {
  assert.equal(await extractScriptText('剧本.txt', Buffer.from('\uFEFF第一场\r\n人物：你好。\r\n结尾')), '第一场\n人物：你好。\n结尾')
  assert.equal(await extractScriptText('draft.md', Buffer.from('# 第1集\n对白\n最后一句')), '# 第1集\n对白\n最后一句')
  assert.equal(await extractScriptText('gbk.txt', Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), '中文')
  assert.equal(await extractScriptText('windows.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文剧本\n对白', 'utf16le')])), '中文剧本\n对白')
  assert.match(await extractScriptText('剧本.docx', await docxFixture()), /第1集：回家[\s\S]*林舟：我回来了。/)
  assert.match(await extractScriptText('script.pdf', pdfFixture('Opening scene and final dialogue.')), /Opening scene and final dialogue\./)
})

test('upload returns before background analysis completes and the next conversation receives the full source and story', async t => {
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '后台分析上传' } })).json()
  const provider = (await app.inject({ method: 'POST', url: '/api/providers', payload: { name: '分析', base_url: 'https://analysis.example/v1' } })).json()
  const model = (await app.inject({ method: 'POST', url: '/api/models', payload: { provider_id: provider.id, name: '文本', remote_id: 'test', modality: 'text', protocol: 'chat_completions', settings: {
    request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } } })).json()
  let release: () => void = () => {}, began: () => void = () => {}, chatCalls = 0
  const started = new Promise<void>(resolve => { began = resolve })
  const content = `第1集\n林舟回到故乡。\n${'旧街的日常。'.repeat(500)}\n剧本最后的重要事实。`
  t.mock.method(globalThis, 'fetch', async (_url, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)), prompt = body.messages[0].content as string
    if (prompt.includes('只为创作者上传的原剧本建立检索地图')) {
      assert.equal(body.response_format?.type, 'json_schema', 'upload analysis negotiates native structured output')
      assert.ok(prompt.includes('剧本最后的重要事实。'))
      const batch = JSON.parse(prompt.slice(prompt.lastIndexOf('【原文片段】\n') + '【原文片段】\n'.length))
      const units = batch.passages.flatMap((passage: { units: Array<{ id: number; text: string }> }) => passage.units)
      return new Promise<Response>(resolve => {
        release = () => resolve(Response.json({ choices: [{ message: { content: JSON.stringify({ sections: [{ start_unit: units[0].id,
          title: '第1集 回到故乡', episode_number: 1, summary: 'MAP_STORY_SUMMARY: 林舟返乡。', characters: [{ name: '林舟', description: '返乡的人物', evidence: { unit_id: units.find((unit: { text: string }) => unit.text.includes('林舟回到故乡')).id } }], events: [] }] }) }, finish_reason: 'stop' }] }))
        began()
      })
    }
    if (prompt.includes('【全剧整合资料】') || prompt.includes('【原稿分析核对资料】')) return Response.json({ choices: [{ message: { content: sourceAnalysisFixture(prompt) }, finish_reason: 'stop' }] })
    const scope = sourceScopeResponse(prompt)
    if (scope) return Response.json({ choices: [{ message: { content: scope }, finish_reason: 'stop' }] })
    chatCalls++
    assert.ok(prompt.includes('INPUT_VISUAL_STYLE: 日漫二维画风'))
    if (prompt.includes('本次独立调用只理解创作者意图')) assert.ok(prompt.includes('MAP_STORY_SUMMARY'))
    else {
      assert.equal(prompt.split(JSON.stringify(content)).length - 1, 1, 'discussion receives the complete source once without a locator request')
      assert.equal(prompt.split('主角返乡，保留全剧事实与结局。').length - 1, 1, 'discussion retains whole-story understanding without duplicating it in project metadata')
    }
    return Response.json({ choices: [{ message: { content: prompt.includes('本次独立调用只理解创作者意图') ? JSON.stringify({ action: 'discuss', settings_patch: {} }) : '收到你的画风要求。' }, finish_reason: 'stop' }] })
  })
  try {
    const uploaded = await upload(project.id, 'original.txt', Buffer.from(content), model.id)
    assert.equal(uploaded.statusCode, 200, uploaded.body)
    assert.equal(uploaded.json().content, content)
    assert.ok(['queued', 'running'].includes(uploaded.json().analysis.status))
    await started
    const path = `/api/projects/${project.id}/script/source/analysis`
    const running = (await app.inject({ method: 'GET', url: path })).json()
    assert.equal(running.status, 'running'); assert.equal(running.work, undefined); assert.equal(running.synthesis, undefined)
    const same = await app.inject({ method: 'POST', url: path, payload: { model_id: model.id, source_updated_at: uploaded.json().updated_at } })
    assert.equal(same.statusCode, 200, same.body); assert.equal(same.json().id, running.id)
    assert.equal(same.json().work, undefined); assert.equal(same.json().synthesis, undefined)
    release()
    let ready
    for (let attempt = 0; attempt < 100; attempt++) {
      ready = (await app.inject({ method: 'GET', url: path })).json()
      if (ready.status === 'ready') break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(ready.status, 'ready', JSON.stringify(ready))
    assert.equal(scriptSourceIndex(project.id)!.story_map![0]!.episode_number, 1)
    assert.equal(scriptSourceIndex(project.id)!.analysis_source_version, ready.source_version)
    assert.equal(scriptSourceIndex(project.id)!.source_version, readScriptSource(project.id, 0, 1).source_version)
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: {
      model_id: model.id, mode: 'script', use_tools: true, messages: [{ role: 'user', text: 'INPUT_VISUAL_STYLE: 日漫二维画风' }] } })
    assert.equal(response.statusCode, 200, response.body); assert.equal(chatCalls, 2)
    assert.equal((await app.inject({ method: 'GET', url: `/api/projects/${project.id}/script` })).json().artifacts?.length || 0, 0)
    assert.equal((await app.inject({ method: 'POST', url: path, payload: { model_id: model.id, source_updated_at: 'old-version' } })).statusCode, 409)
  } finally { release() }
})

test('first chat reads the complete source directly and preserves the exact creator request', async t => {
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '原话与原文兜底' } })).json()
  const provider = (await app.inject({ method: 'POST', url: '/api/providers', payload: { name: '原话', base_url: 'https://original-request.example/v1' } })).json()
  const model = (await app.inject({ method: 'POST', url: '/api/models', payload: { provider_id: provider.id, name: '文本', remote_id: 'test', modality: 'text', protocol: 'chat_completions', settings: {
    request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } } })).json()
  const original = `${'故事铺垫。'.repeat(1500)}SOURCE_FINAL_FACT: 主角最后回家。`
  await upload(project.id, 'original.txt', Buffer.from(original))
  const request = '按原剧本生成大纲，采用日漫二维画风，INPUT_REQUIREMENT_TOKEN: 保留结尾。'
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url, init?: RequestInit) => {
    const review = draftCompletenessFixtureResponse(init); if (review) return review
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const analysis = sourceAnalysisFixture(prompt); if (analysis) return Response.json({ choices: [{ message: { content: analysis }, finish_reason: 'stop' }] })
    if (!prompt.includes('本次独立调用只理解创作者意图')) assert.ok(prompt.includes('SOURCE_FINAL_FACT'))
    assert.ok(prompt.includes(request), 'the raw creator request must survive intent summarization')
    calls++
    const intent = prompt.includes('本次独立调用只理解创作者意图')
    return Response.json({ choices: [{ message: { content: JSON.stringify(intent
      ? { action: 'draft', authorization: 'explicit', operation: 'create', workflow: { stage: 'outline', episode_number: 0 }, creative_brief: '仅整理故事大纲', settings_patch: {} }
      : { artifacts: workflowFixtureTypes(prompt).map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type], content: '林舟回家，保留原文故事。' })), scenes: [] }) }, finish_reason: 'stop' }] })
  })
  const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: {
    model_id: model.id, mode: 'script', use_tools: true, messages: [{ role: 'user', text: request }] } })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(calls, 2)
  assert.ok(response.json().tool_draft)
})

test('unreadable, empty, unsupported and oversized scripts fail explicitly', async () => {
  await assert.rejects(extractScriptText('empty.txt', Buffer.from('  ')), /未提取到文字/)
  await assert.rejects(extractScriptText('empty.pdf', pdfFixture('')), /OCR/)
  await assert.rejects(extractScriptText('corrupt.docx', Buffer.from('broken')), /无法提取/)
  await assert.rejects(extractScriptText('corrupt.pdf', Buffer.from('broken')), /无法提取/)
  await assert.rejects(extractScriptText('old.doc', Buffer.from('legacy')), /仅支持/)
  await assert.rejects(extractScriptText('large.txt', Buffer.from('x'.repeat(100001))), /10 万字/)
})

test('upload accepts exactly 100000 characters and rejects 100001 before replacing the source or calling a model', async t => {
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '全文上限' } })).json()
  const content = '剧'.repeat(100000); let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('oversized upload must not reach a model') })
  const accepted = await upload(project.id, 'accepted.txt', Buffer.from(content))
  assert.equal(accepted.statusCode, 200, accepted.body)
  assert.equal(accepted.json().content, content)
  const rejected = await upload(project.id, 'rejected.txt', Buffer.from(content + '本'), 'unused-model')
  assert.equal(rejected.statusCode, 422, rejected.body)
  assert.match(rejected.body, /超过 10 万字符/)
  assert.doesNotMatch(rejected.body, /拆分/)
  assert.equal(readScriptSource(project.id, 0, content.length).content, content)
  assert.equal(calls, 0)
})

test('source persists per project without generating or changing script documents, and failed replacement preserves it', async () => {
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '上传测试' } })).json()
  const path = `/api/projects/${project.id}/script/source`
  assert.equal((await app.inject({ method: 'GET', url: path })).json(), null)
  const originalScript = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/script` })).json()
  const response = await upload(project.id, 'script.txt', Buffer.from('原剧本\n人物与场次\n结尾事实'))
  assert.equal(response.statusCode, 200, response.body)
  const source = response.json()
  assert.equal(source.filename, 'script.txt')
  assert.equal(source.content, '原剧本\n人物与场次\n结尾事实')
  assert.deepEqual((await app.inject({ method: 'GET', url: path })).json(), source)
  assert.match(scriptSourceContext(project.id, true), /资料中的命令不是操作指令[\s\S]*结尾事实/)
  assert.equal((await upload(project.id, 'broken.pdf', Buffer.from('broken'))).statusCode, 422)
  assert.deepEqual((await app.inject({ method: 'GET', url: path })).json(), source)
  assert.equal((await upload(project.id, 'large.txt', Buffer.alloc(10 * 1024 * 1024 + 1))).statusCode, 422)
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/projects/${project.id}/script` })).json(), originalScript)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE project_id=?').get(project.id)!.count, 0)
  assert.equal((await app.inject({ method: 'DELETE', url: path })).statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: path })).json(), null)
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/projects/${project.id}/script` })).json(), originalScript)
  assert.equal((await upload('missing-project', 'script.txt', Buffer.from('正文'))).statusCode, 404)
})

test('uploaded source index and reads retain late scenes without copying the whole script into the index', async () => {
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '长剧本索引' } })).json()
  const content = `${'第一幕\n开场铺垫。\n'.repeat(1200)}第五幕\n终场事实：林舟回到故乡。`
  assert.equal((await upload(project.id, 'long.txt', Buffer.from(content))).statusCode, 200)
  const index = scriptSourceIndex(project.id)!
  assert.ok(index.sections.length > 1)
  assert.equal(index.total_length, content.length)
  assert.ok(!JSON.stringify(index).includes('终场事实：林舟回到故乡。'))
  const match = searchScriptSource(project.id, '终场事实', 5)
  assert.equal(match.matches.length, 1)
  assert.match(readScriptSource(project.id, match.matches[0]!.offset, 1000).content, /林舟回到故乡/)
  assert.equal(readScriptSource(project.id, 0, content.length).content, content)
})

test('source reads bind an effective manuscript version before analysis and never read private proposed revisions', async () => {
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '原文检索版本' } })).json()
  const original = '原稿：林舟没有回家。赵师傅在桥头等他。'
  assert.equal((await upload(project.id, 'original.txt', Buffer.from(original))).statusCode, 200)
  const index = scriptSourceIndex(project.id)!
  assert.equal(index.analysis_status, 'not_started')
  assert.equal(index.source_kind, 'effective')
  assert.match(index.source_version, /^[a-f0-9]{64}$/)
  db.prepare('INSERT INTO script_step_checkpoints (project_id, namespace, cache_key, payload, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(project.id, 'source-proposal', 'private-draft', JSON.stringify({ content: 'PRIVATE_UNCONFIRMED：林舟已经回家。' }), 'now')
  const read = readScriptSource(project.id, 0, 1000, { source_version: index.source_version })
  assert.equal(read.content, original)
  assert.equal(read.source_version, index.source_version)
  assert.equal(searchScriptSource(project.id, 'PRIVATE_UNCONFIRMED', 8).total_matches, 0)
  const revised = '已确认修订稿：林舟已经回家。赵师傅在门前等他。'
  commitScriptSourceUpdate(project.id, { id: `revision-${project.id}`, base_version: index.source_version, original_content: original, content: revised, replacements: [] })
  assert.throws(() => readScriptSource(project.id, 0, 100, { source_version: index.source_version }), { statusCode: 409 })
  assert.throws(() => searchScriptSource(project.id, '赵师傅', 8, { source_version: index.source_version }), { statusCode: 409 })
  const next = scriptSourceIndex(project.id)!
  assert.notEqual(next.source_version, index.source_version)
  assert.equal(next.revision, 1)
  assert.equal(readScriptSource(project.id, 0, 1000, { source_version: next.source_version }).content, revised)
  assert.equal((await app.inject({ method: 'GET', url: `/api/projects/${project.id}/script/source/original` })).json().content, original)
  await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}/script/source` })
  assert.throws(() => readScriptSource(project.id, 0, 100, { source_version: next.source_version }), { statusCode: 409 })
  assert.throws(() => searchScriptSource(project.id, '赵师傅', 8, { source_version: next.source_version }), { statusCode: 409 })
})

test('literal source search counts and pages every result with exact Unicode manuscript offsets', async () => {
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '字面搜索分页' } })).json()
  const query = '赵师傅[A].*'
  const content = `${'İ😀'.repeat(300)}\n${Array.from({ length: 25 }, (_, i) => `第${i + 1}集：${query}。`).join('\n')}\nAlpha与ALPHA`
  assert.equal((await upload(project.id, 'literal.txt', Buffer.from(content))).statusCode, 200)
  const sourceVersion = scriptSourceIndex(project.id)!.source_version
  const found: number[] = []
  let cursor: string | undefined
  do {
    const result = searchScriptSource(project.id, query, 8, { source_version: sourceVersion, ...(cursor ? { cursor } : {}) })
    assert.equal(result.total_matches, 25)
    assert.equal(result.source_version, sourceVersion)
    for (const match of result.matches) {
      assert.equal(content.slice(match.match_offset, match.match_offset + match.match_length), query)
      assert.equal(content.slice(match.offset, match.offset + match.excerpt.length), match.excerpt)
      assert.equal(readScriptSource(project.id, match.match_offset, match.match_length, { source_version: result.source_version }).content, query)
      found.push(match.match_offset)
    }
    assert.equal(result.truncated, found.length < result.total_matches)
    assert.equal(result.next_cursor === null, !result.truncated)
    cursor = result.next_cursor || undefined
  } while (cursor)
  assert.equal(found.length, 25)
  assert.equal(new Set(found).size, 25)
  assert.deepEqual(found, [...content.matchAll(/赵师傅\[A\]\.\*/g)].map(match => match.index))
  const english = searchScriptSource(project.id, 'alpha', 8)
  assert.equal(english.total_matches, 2)
  assert.equal(english.matches[0]!.match_offset, content.indexOf('Alpha'))
  assert.equal(english.matches[1]!.match_offset, content.indexOf('ALPHA'))
  const absent = searchScriptSource(project.id, '没有出现的人物', 8)
  assert.equal(absent.total_matches, 0)
  assert.equal(absent.truncated, false)
  assert.equal(absent.next_cursor, null)
})

test('search cursors reject another query, project, malformed position and stale manuscript', async () => {
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '搜索游标作用域' } })).json()
  const other = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '另一项目' } })).json()
  const original = '赵师傅到场。赵师傅离开。赵师傅回来。'
  await upload(project.id, 'cursor.txt', Buffer.from(original))
  await upload(other.id, 'cursor.txt', Buffer.from(original))
  const first = searchScriptSource(project.id, '赵师傅', 1), cursor = first.next_cursor!
  assert.throws(() => searchScriptSource(project.id, '离开', 1, { cursor }), { statusCode: 422 })
  assert.throws(() => searchScriptSource(other.id, '赵师傅', 1, { cursor }), { statusCode: 422 })
  for (const malformed of ['', 'not+a+cursor', Buffer.from('{}').toString('base64url')]) {
    assert.throws(() => searchScriptSource(project.id, '赵师傅', 1, { cursor: malformed }), { statusCode: 422 })
  }
  const invalidPosition = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  invalidPosition.next_match = 999
  assert.throws(() => searchScriptSource(project.id, '赵师傅', 1, { cursor: Buffer.from(JSON.stringify(invalidPosition)).toString('base64url') }), { statusCode: 422 })
  await upload(project.id, 'cursor.txt', Buffer.from(`新版前文。${original}`))
  assert.throws(() => searchScriptSource(project.id, '赵师傅', 1, { cursor }), { statusCode: 409 })
})

test('source retrieval rejects unsafe ranges and empty or excessive search parameters', async () => {
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '原文检索参数校验' } })).json()
  await upload(project.id, 'validation.txt', Buffer.from('赵师傅与林舟。'))
  for (const [offset, length] of [[-1, 2], [0.5, 2], [NaN, 2], [0, 0], [0, -1], [0, Infinity], [0, 100001], [100, 1]]) {
    assert.throws(() => readScriptSource(project.id, offset!, length!), { statusCode: 422 })
  }
  for (const query of ['', '  ', '人'.repeat(201)]) assert.throws(() => searchScriptSource(project.id, query, 8), { statusCode: 422 })
  for (const limit of [0, -1, 1.5, 21, Infinity]) assert.throws(() => searchScriptSource(project.id, '赵师傅', limit), { statusCode: 422 })
  assert.throws(() => readScriptSource(project.id, 0, 1, { source_version: '' }), { statusCode: 422 })
  const length = scriptSourceIndex(project.id)!.total_length
  assert.equal(readScriptSource(project.id, length, 1).complete, true)
  assert.equal(readScriptSource(project.id, length, 1).content, '')
})

test('every stage writer and completeness check receive the original script independently of chat history', async t => {
  const provider = (await app.inject({ method: 'POST', url: '/api/providers', payload: { name: '测试', base_url: 'https://script-source.example/v1' } })).json()
  const model = (await app.inject({ method: 'POST', url: '/api/models', payload: { provider_id: provider.id, name: '文本', remote_id: 'test', modality: 'text', protocol: 'chat_completions', settings: { request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } } })).json()
  for (const useTools of [false, true]) for (const stage of scriptStageOrder) {
    const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: `来源-${stage}` } })).json()
    assert.equal((await upload(project.id, 'original.txt', Buffer.from('SOURCE_SCRIPT_FINAL_FACT: the protagonist returns home.'))).statusCode, 200)
    for (const previous of scriptStageOrder.slice(0, scriptStageOrder.indexOf(stage))) {
      const artifact_type = scriptStageArtifacts[previous][0]
      db.prepare('INSERT INTO script_artifacts (id, project_id, artifact_type, title, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(`${project.id}-${previous}`, project.id, artifact_type, previous, '已经确认的设定', 'ready', 'now', 'now')
    }
    let writerCalls = 0
    t.mock.method(globalThis, 'fetch', async (_url, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const prompt = body.messages[0].content as string
      const analysis = sourceAnalysisFixture(prompt); if (analysis) return Response.json({ choices: [{ message: { content: analysis }, finish_reason: 'stop' }] })
      if (!prompt.includes('本次独立调用只理解创作者意图')) assert.ok(prompt.includes('SOURCE_SCRIPT_FINAL_FACT'), `${stage} must receive original script`)
      const reviewed = draftCompletenessFixtureResponse(init); if (reviewed) return reviewed
      const intent = prompt.includes('本次独立调用只理解创作者意图')
      if (!intent) writerCalls++
      if (useTools && !intent) assert.equal(body.tools, undefined)
      const content = intent ? { action: 'draft', authorization: 'explicit', operation: 'create', workflow: { stage, episode_number: stage === 'episode' ? 1 : 0 }, creative_brief: '根据原剧本整理指定阶段', settings_patch: {} }
        : { artifacts: workflowFixtureTypes(prompt, scriptStageArtifacts[stage]).map(artifact_type => ({ artifact_type, title: scriptArtifactLabels[artifact_type], content: '主角回家，保持原文事实。' })), scenes: stage === 'episode' ? [{ heading: '第1场 家中', action: '主角回家', dialogue: '我回来了。', duration: 10 }] : [] }
      return Response.json({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] })
    })
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat${useTools ? '/stream' : ''}`, payload: { model_id: model.id, mode: 'script', use_tools: useTools, workflow: { stage, episode_number: stage === 'episode' ? 1 : 0 }, messages: [{ role: 'user', text: '基于已上传剧本生成本阶段草稿' }] } })
    assert.equal(response.statusCode, 200, `${stage}: ${response.body}`)
    const result = useTools ? response.body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(event => event.type === 'done') : response.json()
    assert.ok(useTools ? result?.tool_draft : result?.draft, `${stage}: ${response.body}`)
    assert.equal(writerCalls, stage === 'outline' ? 1 : scriptStageArtifacts[stage].length, stage)
  }
})

test('replacing an uploaded script during stage generation rejects the stale draft', async t => {
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '原剧本并发更新' } })).json()
  const provider = (await app.inject({ method: 'POST', url: '/api/providers', payload: { name: '并发测试', base_url: 'https://source-race.example/v1' } })).json()
  const model = (await app.inject({ method: 'POST', url: '/api/models', payload: { provider_id: provider.id, name: '文本', remote_id: 'test', modality: 'text', protocol: 'chat_completions', settings: {
    request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } } })).json()
  assert.equal((await upload(project.id, 'original.txt', Buffer.from('旧版事实：林舟留在故乡。'))).statusCode, 200)
  let replaced = false
  t.mock.method(globalThis, 'fetch', async (_url, init?: RequestInit) => {
    const review = draftCompletenessFixtureResponse(init)
    if (review) return review
    const prompt = JSON.parse(String(init?.body)).messages[0].content as string
    const analysis = sourceAnalysisFixture(prompt); if (analysis) return Response.json({ choices: [{ message: { content: analysis }, finish_reason: 'stop' }] })
    assert.match(prompt, /旧版事实：林舟留在故乡/)
    if (!replaced) {
      replaced = true
      assert.equal((await upload(project.id, 'revised.txt', Buffer.from('新版事实：林舟离开故乡。'))).statusCode, 200)
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify({ artifacts: workflowFixtureTypes(prompt).map(artifact_type => ({
      artifact_type, title: scriptArtifactLabels[artifact_type], content: '林舟留在故乡，完成主线。' })), scenes: [] }) }, finish_reason: 'stop' }] })
  })
  const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: {
    model_id: model.id, mode: 'script', use_tools: true, workflow: { stage: 'outline' }, messages: [{ role: 'user', text: '按原剧本生成大纲' }] } })
  assert.equal(response.statusCode, 409, response.body)
  assert.match(response.body, /上传剧本已变化/)
  assert.equal((await app.inject({ method: 'GET', url: `/api/projects/${project.id}/script/source` })).json().content, '新版事实：林舟离开故乡。')
  assert.equal((await app.inject({ method: 'GET', url: `/api/projects/${project.id}/script` })).json().artifacts?.length || 0, 0)
})

test('scoped document review can read uploaded source through tools without logging its text', async t => {
  const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '补齐阶段读取原文' } })).json()
  const provider = (await app.inject({ method: 'POST', url: '/api/providers', payload: { name: '工具测试', base_url: 'https://source-tools.example/v1' } })).json()
  const model = (await app.inject({ method: 'POST', url: '/api/models', payload: { provider_id: provider.id, name: '文本', remote_id: 'test', modality: 'text', protocol: 'chat_completions', settings: {
    request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } } })).json()
  const content = `${'前半段剧情。'.repeat(1000)}终场秘密：林舟没有回家。`
  assert.equal((await upload(project.id, 'long.txt', Buffer.from(content))).statusCode, 200)
  db.prepare('INSERT INTO script_artifacts (id, project_id, artifact_type, title, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`${project.id}-outline`, project.id, 'outline', '全剧大纲', '已保存的主线开头。', 'ready', 'now', 'now')
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    const analysis = sourceAnalysisFixture(body.messages[0].content); if (analysis) return Response.json({ choices: [{ message: { content: analysis }, finish_reason: 'stop' }] })
    const names = body.tools.map((tool: { function: { name: string } }) => tool.function.name)
    assert.ok(names.includes('read_source_document'))
    assert.ok(names.includes('search_source_document'))
    assert.ok(names.includes('read_documents'))
    if (++calls === 1) return Response.json({ choices: [{ message: { tool_calls: [{ id: 'source-read', type: 'function', function: {
      name: 'read_source_document', arguments: JSON.stringify({ offset: content.length - 40, length: 40 }) } }] }, finish_reason: 'tool_calls' }] })
    const result = JSON.parse(body.messages.at(-1).content)
    assert.match(result.result.content, /林舟没有回家/)
    return Response.json({ choices: [{ message: { content: '已核对终场原文。' }, finish_reason: 'stop' }] })
  })
  const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: {
    model_id: model.id, mode: 'script', use_tools: true, document_action: { operation: 'review', document_ids: [`${project.id}-outline`] }, messages: [{ role: 'user', text: '核对大纲与原稿终场是否一致' }] } })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(calls, 2)
  const sourceActivity = response.json().activity.find((entry: { name?: string }) => entry.name === 'read_source_document')
  assert.ok(sourceActivity)
  assert.ok(!sourceActivity.output.includes('林舟没有回家'))
})

test('long upload-to-outline returns a complete unsaved preview for JSON and native creation', async t => {
  for (const useTools of [false, true]) {
    const project = (await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '长稿全链路' } })).json()
    const provider = (await app.inject({ method: 'POST', url: '/api/providers', payload: { name: '长稿', base_url: 'https://long-source.invalid/v1' } })).json()
    const model = (await app.inject({ method: 'POST', url: '/api/models', payload: { provider_id: provider.id, name: '长稿模型', remote_id: 'text', modality: 'text', protocol: 'chat_completions', settings: {
      structured_output_mode: 'json_schema', request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } } })).json()
    const original = '第1集\n林舟拿到钥匙。' + '连续剧情发展。'.repeat(2500) + '\n第9集\n林舟交还钥匙。'
    await upload(project.id, 'original.txt', Buffer.from(original))
    let writers = 0, reviews = 0
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const body = JSON.parse(String(init?.body)), prompt = body.messages[0].content, contract = body.response_format?.json_schema
      const analysis = sourceAnalysisFixture(prompt); let content: unknown
      if (analysis) content = JSON.parse(analysis)
      else if (prompt.includes('本次独立调用只理解创作者意图')) content = { action: 'draft', authorization: 'explicit', operation: 'create', workflow: { stage: 'outline', episode_number: 0 }, creative_brief: '原稿9集，水墨风格', settings_patch: {} }
      else if (contract?.name === 'workflow_draft') {
        writers++; assert.match(prompt, /STYLE_REQUIREMENT: 水墨/); assert.ok(prompt.includes(JSON.stringify(original)))
        content = { artifacts: workflowFixtureTypes(prompt)
          .map(type => ({ artifact_type: type, title: '剧情资料', content: type === 'episode_outline' ? Array.from({ length: 9 }, (_, i) => `第${i + 1}集：完整因果。`).join('\n') : '林舟得到钥匙，与伙伴共同经历冲突后交还钥匙。' })), scenes: [] }
      } else { const review = draftCompletenessFixtureResponse(init); assert.ok(review, 'unexpected model request'); reviews++; assert.ok(prompt.includes(JSON.stringify(original))); return review }
      return Response.json({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }] })
    })
    const result = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/script/director/chat`, payload: { model_id: model.id, mode: 'script', use_tools: useTools,
      workflow: { stage: 'outline' }, messages: [{ role: 'user', text: '生成完整大纲，STYLE_REQUIREMENT: 水墨。' }] } })
    assert.equal(result.statusCode, 200, result.body)
    const preview = useTools ? result.json().tool_draft?.workflow : result.json().draft
    assert.ok(preview, result.body); assert.equal(preview.artifacts.length, 1)
    assert.equal(writers, 1); assert.equal(reviews, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM script_artifacts WHERE project_id=?').get(project.id)!.count, 0)
    assert.equal(readScriptSource(project.id, 0, original.length).content, original)
    t.mock.restoreAll()
  }
})
