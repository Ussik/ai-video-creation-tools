import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScriptSourceAnalysis } from '@video-studio/shared/script/script-source-document'
import { TextOutputLimitError } from '../src/infrastructure/providers/text-errors.js'
import { reviewSourceQuality } from '../src/modules/script/script-source-quality.js'
import { scriptSourcePassages } from '../src/modules/script/script-source-map.js'

const document = { filename: '原稿.txt', content: '林舟归还钥匙，城市恢复。' }
const signal = () => new AbortController().signal
const stateFor = (): ScriptSourceAnalysis => ({ id: 'analysis', source_version: 'v1', model_id: 'model', status: 'running',
  completed_chunks: 1, total_chunks: 1, error: null, updated_at: 'now', sections: [{ offset: 0, length: document.content.length,
    title: '终章', summary: '归还钥匙', characters: [], events: [], open_threads: [] }] })

test('source quality preserves complete findings and full coverage through a later page failure', async () => {
  const state = stateFor(), finding = { kind: 'omission', explanation: '遗漏城市恢复的最终状态', unit_ids: [scriptSourcePassages(document.content)[0]!.units[0]!.id] }
  let pages = 0, originals = 0
  await assert.rejects(reviewSourceQuality(document, state, async (_prompt, contract) => {
    if (!contract!.name.endsWith('_page')) { originals++; throw new TextOutputLimitError('{"findings":[' + JSON.stringify(finding) + ',{"explanation":"cut', 'length') }
    if (++pages === 2) throw new Error('quality page disconnected')
    return JSON.stringify({ items: [{ kind: 'coverage', checked_section_ids: [0] }], complete: false })
  }, () => {}, signal()), /quality page disconnected/)
  assert.equal(state.quality, undefined)
  assert.ok(JSON.stringify(state.quality_work).includes(finding.explanation))
  await assert.rejects(reviewSourceQuality(document, state, async (_prompt, contract) => {
    assert.equal(contract!.name, 'script_source_quality_page')
    return JSON.stringify({ items: [], complete: true })
  }, () => {}, signal()), (issue: unknown) => (issue as { sourceQualityIssues?: boolean }).sourceQualityIssues === true)
  assert.equal(originals, 1)
  assert.deepEqual(state.quality!.findings, [finding])
  assert.equal(state.quality_work, undefined)
})

test('a source quality page cannot claim completion without complete chapter coverage', async () => {
  const state = stateFor()
  await assert.rejects(reviewSourceQuality(document, state, async (_prompt, contract) => {
    if (!contract!.name.endsWith('_page')) throw new TextOutputLimitError('', 'length')
    return JSON.stringify({ items: [], complete: true })
  }, () => {}, signal()), /script_source_quality_page/)
  assert.equal(state.quality, undefined)
})
