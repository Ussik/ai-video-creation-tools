import assert from 'node:assert/strict'
import { test } from 'node:test'

import { z } from 'zod'

import { parseStructuredOutput } from '../src/structured-output.js'

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

test('does not infer missing required fields or accept invalid JSON', () => {
  assert.equal(parseStructuredOutput('{"outline":"没有场景"}', scriptSchema), null)
  assert.equal(parseStructuredOutput('{"outline":"无效", "scenes": [}', scriptSchema), null)
  assert.equal(parseStructuredOutput('没有 JSON 内容', scriptSchema), null)
})
