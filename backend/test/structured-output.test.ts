import assert from 'node:assert/strict'
import { test } from 'node:test'

import { z } from 'zod'

import { parseStructuredOutput } from '../src/modules/generation/structured-output.js'

const scriptSchema = z.object({
  outline: z.string().min(1),
  scenes: z.array(z.object({ heading: z.string().min(1), action: z.string().min(1) })).min(1),
})

const script = { outline: '雨停之后', scenes: [{ heading: '街角', action: '雨丝渐停' }] }

test('parses plain, fenced and prose-wrapped JSON', () => {
  const json = JSON.stringify(script)
  assert.deepEqual(parseStructuredOutput(json, scriptSchema), script)
  assert.deepEqual(parseStructuredOutput(`说明文字\n\`\`\`json\n${json}\n\`\`\`\n剧本完成。`, scriptSchema), script)
})

test('ignores think blocks and uses the final schema-valid object', () => {
  const first = { outline: '旧版', scenes: [{ heading: '旧镜头', action: '旧动作' }] }
  const raw = `<think>内部草稿：${JSON.stringify(first)}</think>\n候选：${JSON.stringify(first)}\n最终：${JSON.stringify(script)}`
  assert.deepEqual(parseStructuredOutput(raw, scriptSchema), script)
  assert.equal(parseStructuredOutput(`<think>${JSON.stringify(script)}</think>`, scriptSchema), null)
  assert.equal(parseStructuredOutput(`<think>${JSON.stringify(script)}`, scriptSchema), null)
})

test('reasoning markers inside JSON strings remain exact source text', () => {
  for (const text of ['A<think>第一句</think>B', '<think>这是台词里未闭合的标记', '他说“<think>别改我的原话</think>”。']) {
    const value = { outline: text, scenes: [{ heading: '街角', action: text }] }
    assert.deepEqual(parseStructuredOutput(JSON.stringify(value), scriptSchema), value)
    assert.deepEqual(parseStructuredOutput(`<think>外部推理：${JSON.stringify(script)}</think>\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, scriptSchema), value)
  }
})

test('an abandoned string cannot promote an external reasoning draft to a valid response', () => {
  const draft = JSON.stringify(script)
  assert.equal(parseStructuredOutput('{"outline":"未闭合\n<think>' + draft + '</think>', scriptSchema), null)
  assert.deepEqual(parseStructuredOutput('{"outline":"未闭合\n<think>' + draft + '</think>\n' + draft, scriptSchema), script)
  assert.equal(parseStructuredOutput('<think>外层<think>内层</think>' + draft + '</think>', scriptSchema), null)
})

test('keeps braces inside JSON strings and can recover after an invalid candidate', () => {
  const withBraces = { outline: '牌子写着 {雨后}，他说 \\"走吧\\"', scenes: [{ heading: '街角', action: '雨丝渐停' }] }
  const raw = `无效：{"outline":"缺少场景"}\n有效：${JSON.stringify(withBraces)}`
  assert.deepEqual(parseStructuredOutput(raw, scriptSchema), withBraces)
})

test('recovers after an unterminated string or a raw newline in a JSON string', () => {
  const json = JSON.stringify(script)
  assert.deepEqual(parseStructuredOutput(`{"outline":"未闭合\n${json}`, scriptSchema), script)
  assert.deepEqual(parseStructuredOutput(`{"outline":"非法\n换行","scenes":[]}\n${json}`, scriptSchema), script)
})

test('recovers trailing commas only outside strings while retaining literal punctuation', () => {
  const value = { outline: '正文里的尾逗号 ,} 和 ,] 必须保留', scenes: [{ heading: '街角', action: '雨停了' }] }
  const raw = '{"outline":' + JSON.stringify(value.outline) + ',"scenes":[{"heading":"街角","action":"雨停了",},],}'
  assert.deepEqual(parseStructuredOutput(raw, scriptSchema), value)
})

test('recovers unescaped line breaks without changing CR, LF, quotes or escaped source text', () => {
  const text = '第一行\r\n第二行\n他说 "走吧"，路径是 C:\\temp。'
  const value = { outline: text, scenes: [{ heading: '街角', action: text }] }
  const raw = JSON.stringify(value).replaceAll('\\r', '\r').replaceAll('\\n', '\n')
  assert.deepEqual(parseStructuredOutput(raw, scriptSchema), value)
  assert.deepEqual(parseStructuredOutput(`${raw}\n${JSON.stringify(script)}`, scriptSchema), script, 'a later exact response still wins')
})

test('syntax recovery never fills missing values, guesses quotes or completes truncated roots', () => {
  const schema = z.object({ values: z.array(z.string()) }).strict()
  for (const raw of ['{"values":[,]}', '{"values":["one",,]}', '{"values":,}', '{"values":["one"]', '{"values":["one" "two"]}', '{"values":["one\\\ntwo"]}']) {
    assert.equal(parseStructuredOutput(raw, schema), null, raw)
  }
})

test('candidate metadata distinguishes a damaged root from a complete nested sound object', () => {
  const candidates: Array<{ depth: number; value: unknown }> = []
  const sound = { ambience: ['雨声'], acoustics: '室内', music_policy: 'timeline' }
  const raw = '{"scenes":[{"scene_direction":{"sound":' + JSON.stringify(sound)
  assert.equal(parseStructuredOutput(raw, scriptSchema, { onCandidate: (value, candidate) => candidates.push({ depth: candidate.depth, value }) }), null)
  assert.ok(candidates.some(candidate => candidate.depth === 4 && JSON.stringify(candidate.value) === JSON.stringify(sound)))
  assert.ok(candidates.every(candidate => candidate.depth > 0))
  candidates.length = 0
  const lineBreak = '{"scenes":[{"text":"前文\n后文","sound":' + JSON.stringify(sound)
  assert.equal(parseStructuredOutput(lineBreak, scriptSchema, { onCandidate: (value, candidate) => candidates.push({ depth: candidate.depth, value }) }), null)
  assert.ok(candidates.some(candidate => JSON.stringify(candidate.value) === JSON.stringify(sound)))
  assert.ok(candidates.every(candidate => candidate.depth > 0), 'resetting a damaged string cannot promote nested sound to root diagnostics')
})

test('does not infer missing required fields or accept invalid JSON', () => {
  assert.equal(parseStructuredOutput('{"outline":"没有场景"}', scriptSchema), null)
  assert.equal(parseStructuredOutput('{"outline":"无效", "scenes": [}', scriptSchema), null)
  assert.equal(parseStructuredOutput('没有 JSON 内容', scriptSchema), null)
})
