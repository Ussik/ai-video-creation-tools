import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { getManagedPromptBlocks, stripManagedPromptBlocks, validateManagedPromptDocument } from '@video-studio/shared/visuals/prompt-document'
import { visualSettingTemplates, withVisualSettingTemplate, type VisualSettingKind } from '@video-studio/shared/visuals/visual-setting-template'

test('reference setting templates rebuild image order without retaining removed images or overwriting creator instructions', () => {
  const body = '保留参考人物的灰色大衣；本次只把围巾改为红色。\n\n不要改变脸部特征。'
  const previous = withVisualSettingTemplate(body, 'character', [
    { asset_id: 'front', name: '原正面.png' }, { asset_id: 'side', name: '原侧面.png' },
  ])
  const current = withVisualSettingTemplate(previous, 'character', [
    { asset_id: 'side', name: '现主参考.png' }, { asset_id: 'detail', name: '面料细节.png' },
  ])
  assert.equal(stripManagedPromptBlocks(current), body)
  assert.match(current, /参考图 1：现主参考.png/)
  assert.match(current, /参考图 2：面料细节.png/)
  assert.doesNotMatch(current, /原正面|原侧面/)
  assert.equal(getManagedPromptBlocks(current, ['设定图固定要求']).length, 1)
  assert.equal(getManagedPromptBlocks(current, ['生成参考图']).length, 1)
  assert.match(current, /参考图 1 是主参考/)
  assert.match(current, /冲突时，以主参考为准/)
  assert.doesNotThrow(() => validateManagedPromptDocument(current))
  const disconnected = withVisualSettingTemplate(current, 'character', [])
  assert.equal(stripManagedPromptBlocks(disconnected), body)
  assert.equal(getManagedPromptBlocks(disconnected, ['生成参考图']).length, 0)
  assert.doesNotMatch(disconnected, /现主参考.png|面料细节.png/)
})

test('each category requests its own production views instead of treating a location or prop as a person', () => {
  const reference = [{ asset_id: 'reference', name: '自有图片.png' }]
  const character = withVisualSettingTemplate(visualSettingTemplates.character.body, 'character', reference)
  const location = withVisualSettingTemplate(visualSettingTemplates.location.body, 'location', reference)
  const prop = withVisualSettingTemplate(visualSettingTemplates.prop.body, 'prop', reference)
  assert.match(character, /人物视觉设定信息图/)
  assert.match(character, /完整全身正面、侧面、背面/)
  assert.match(location, /场景视觉设定信息图/)
  assert.match(location, /空间平面布局/)
  assert.doesNotMatch(location, /完整全身|面部轮廓/)
  assert.match(prop, /道具视觉设定信息图/)
  assert.match(prop, /连接部位|开合状态/)
  assert.doesNotMatch(prop, /完整全身|空间平面布局/)
})

const directory = await mkdtemp(join(tmpdir(), 'studio-canvas-visual-template-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, initDb, all, run, now } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}

test('standalone reference setting kinds and creator prompt edits survive default and named canvas reloads without creating profiles or jobs', async () => {
  const project = await call('POST', '/api/projects', { name: '自有图片设定' })
  const canvas = await call('POST', `/api/projects/${project.id}/canvases`, { name: '参考方案' })
  for (const [index, suffix] of ['canvas', `canvases/${canvas.id}`].entries()) {
    const url = `/api/projects/${project.id}/${suffix}`
    const initial = await call('GET', url)
    const saved = await call('PUT', url, { ...initial,
      nodes: (Object.keys(visualSettingTemplates) as VisualSettingKind[]).map(kind => ({
        id: `${kind}-${index}`, type: 'generation', x: 500, y: 10, width: 440, height: 420,
        title: visualSettingTemplates[kind].label, prompt: visualSettingTemplates[kind].body,
        text: `${kind} 的手工调整要求`,
        settings: { modality: 'image', visual_template_kind: kind, prompt_override: true },
      })),
    })
    assert.deepEqual(saved.nodes.map((node: { settings: { visual_template_kind: string } }) => node.settings.visual_template_kind),
      ['character', 'location', 'prop'])
    assert.deepEqual(await call('GET', url), saved)
    initDb()
    assert.deepEqual(await call('GET', url), saved)
    assert.deepEqual(await call('PUT', url, saved), saved)
  }
  assert.deepEqual(all('SELECT * FROM visual_profiles'), [])
  assert.deepEqual(all('SELECT * FROM jobs'), [])
})

test('invalid template kinds cannot replace saved graphs through either canvas endpoint', async () => {
  const project = await call('POST', '/api/projects', { name: '模板类型验证' })
  const canvas = await call('POST', `/api/projects/${project.id}/canvases`, { name: '验证方案' })
  for (const [index, suffix] of ['canvas', `canvases/${canvas.id}`].entries()) {
    const url = `/api/projects/${project.id}/${suffix}`, initial = await call('GET', url)
    const saved = await call('PUT', url, { ...initial, nodes: [{ id: `kept-${index}`, type: 'generation',
      x: 0, y: 0, width: 440, height: 420, prompt: '保留创作者提示词',
      settings: { modality: 'image', visual_template_kind: 'character' },
    }] })
    for (const invalid of ['unknown', '', null, 1, [], {}]) {
      const response = await app.inject({ method: 'PUT', url, payload: { ...saved, nodes: [{ ...saved.nodes[0],
        settings: { ...saved.nodes[0].settings, visual_template_kind: invalid },
      }] } })
      assert.equal(response.statusCode, 422, response.body)
      assert.deepEqual(await call('GET', url), saved)
    }
  }
})

test('reference setting previews and queued jobs preserve complete board prompts and input images without creating shots or profiles', async t => {
  // buildApp registers routes without starting a worker. Fail immediately if
  // this enqueue-only regression ever attempts a provider request.
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('this test must never call a provider') })
  const provider = await call('POST', '/api/providers', { name: '设定图隔离测试', base_url: 'https://example.invalid', adapter: 'http' })
  const model = await call('POST', '/api/models', { provider_id: provider.id, name: '参考图占位模型', remote_id: 'mock-image',
    modality: 'image', protocol: 'image_generations', settings: {
      request_path: '/images', request_template: { prompt: '{{prompt}}', images: '{{images}}' }, image_base64_path: 'data.0.b64_json',
    } })
  const imagePath = join(directory, 'reference.png')
  await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64'))
  for (const kind of Object.keys(visualSettingTemplates) as VisualSettingKind[]) {
    const project = await call('POST', '/api/projects', { name: `自有图片-${kind}` })
    const referenceIds = ['main', 'detail'].map(suffix => `${project.id}-${suffix}`)
    for (const assetId of referenceIds) run("INSERT INTO assets (id, project_id, kind, filename, path, source, created_at) VALUES (?, ?, 'image', ?, ?, 'upload', ?)",
      assetId, project.id, `${assetId}.png`, imagePath, now())
    const body = `${visualSettingTemplates[kind].body}\n保留手工补充：统一使用暖灰色背景。`
    const prompt = withVisualSettingTemplate(body, kind, referenceIds.map((asset_id, index) => ({ asset_id, name: index ? '局部参考.png' : '主体参考.png' })))
    const input = { shot_id: null, source_artifact_type: kind, model_id: model.id, mode: 'reference',
      prompt, prompt_document: true, prompt_is_final: true, prompt_body: body, prompt_template: prompt,
      reference_asset_ids: referenceIds, explicit_reference_asset_ids: referenceIds,
      visual_reference_mode: 'profiles', ratio: '16:9', duration: 1, resolution: null,
    }
    const url = `/api/projects/${project.id}/generate`
    const preview = await call('POST', `${url}/preview`, input)
    assert.equal(preview.prompt, prompt, 'complete setting board document remains authoritative')
    assert.deepEqual(preview.reference_asset_ids, referenceIds)
    assert.deepEqual(preview.explicit_reference_asset_ids, referenceIds)
    assert.equal(preview.shot_id, null)
    assert.equal(preview.source_artifact_type, kind)
    assert.doesNotMatch(preview.prompt, /只生成当前镜头的一幅完整画面|不要复制设定板的多视角/)
    assert.deepEqual(all('SELECT * FROM jobs WHERE project_id=?', project.id), [], 'preview does not enqueue')
    const job = await call('POST', url, preview)
    assert.equal(job.status, 'queued')
    assert.equal(job.shot_id, null)
    const request = JSON.parse(job.request)
    assert.equal(request.prompt, prompt)
    assert.equal(request.prompt_document, true)
    assert.equal(request.source_artifact_type, kind)
    assert.equal(request.shot_id, null)
    assert.deepEqual(request.reference_asset_ids, referenceIds)
    assert.deepEqual(request.explicit_reference_asset_ids, referenceIds)
    assert.equal(all('SELECT * FROM jobs WHERE project_id=?', project.id).length, 1)
    assert.deepEqual(all('SELECT * FROM shots WHERE project_id=?', project.id), [])
    assert.deepEqual(all('SELECT * FROM visual_profiles WHERE project_id=?', project.id), [])
    assert.deepEqual(all('SELECT * FROM asset_tasks WHERE project_id=?', project.id), [])
  }
  assert.equal(network.mock.calls.length, 0)
})
