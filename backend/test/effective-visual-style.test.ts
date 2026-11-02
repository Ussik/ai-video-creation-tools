import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isEffectiveVisualStyle, projectStyleInstructions } from '@video-studio/shared/visuals/visual-style'

const directory = await mkdtemp(join(tmpdir(), 'effective-visual-style-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { buildApp } = await import('../src/app.js')
const { db, newId, now, one, run } = await import('../src/infrastructure/database/db.js')
const { autoConfirmGeneratedProfileBoard } = await import('../src/modules/visuals/visual-profiles.js')
const { registerGeneratedVisualReference } = await import('../src/modules/visuals/visual-reference-assets.js')
const { effectiveVisualStyleForPrompt, generationEffectiveVisualStyle, projectVisualStyle, referenceStyleWarnings } = await import('../src/modules/visuals/project-visual-style.js')
type Job = import('../src/infrastructure/database/db.js').Job
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

async function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}

async function fixture() {
  const project = await call('POST', '/api/projects', { name: '实际生效画风' })
  await call('PUT', `/api/projects/${project.id}/script`, { outline: '故事', characters: '', generation_options: { visual_style: '项目水墨' } })
  const provider = await call('POST', '/api/providers', { name: '隔离占位', base_url: 'https://example.invalid', adapter: 'http' })
  const model = await call('POST', '/api/models', { provider_id: provider.id, name: '隔离图片模型', remote_id: 'mock', modality: 'image', protocol: 'image_generations',
    settings: { request_path: '/image', request_template: { prompt: '{{prompt}}', images: '{{images}}' }, image_base64_path: 'data.0.b64_json' } })
  const { visual_profiles: [profile] } = await call('POST', `/api/projects/${project.id}/visual-profiles`, {
    profiles: [{ kind: 'prop', name: '铜表', variant: '常态', definition: '黄铜怀表', view_requirements: '正侧背' }],
  })
  return { project, model, profile, style: projectVisualStyle(project.id) }
}

function complete(job: Job) {
  const assetId = newId()
  run("INSERT INTO assets (id, project_id, kind, filename, path, source, created_at) VALUES (?, ?, 'image', 'result.png', '/tmp/result.png', 'generated', ?)", assetId, job.project_id, now())
  run("UPDATE jobs SET status='succeeded', result_asset_id=? WHERE id=?", assetId, job.id)
  const request = JSON.parse(job.request)
  if (request.asset_task_id) run("UPDATE asset_tasks SET status='ready', result_asset_id=? WHERE id=?", assetId, request.asset_task_id)
  return { assetId, job: one<Job>('SELECT * FROM jobs WHERE id=?', job.id)! }
}

test('effective style records actual managed content separately from its project baseline', async () => {
  const { style } = await fixture(), inherited = projectStyleInstructions(style)
  const project = effectiveVisualStyleForPrompt(`正文。\n\n${inherited}`, style)
  const custom = effectiveVisualStyleForPrompt('正文。\n【项目画风约束】真人摄影【项目画风约束结束】', style)
  const removed = effectiveVisualStyleForPrompt('正文。', style)
  assert.equal(project.origin, 'project')
  assert.equal(custom.origin, 'custom')
  assert.equal(removed.origin, 'removed')
  assert.match(project.fingerprint, /^[a-f0-9]{64}$/)
  assert.notEqual(project.fingerprint, custom.fingerprint)
  assert.notEqual(custom.fingerprint, removed.fingerprint)
  // Existing full-document jobs did not save effective metadata; their actual
  // prompt and immutable project snapshot are enough to diagnose them.
  assert.deepEqual(generationEffectiveVisualStyle({ prompt: '正文。', prompt_document: true, project_visual_style: style,
    effective_visual_style: { ...project } }), removed)
  assert.equal(generationEffectiveVisualStyle({ prompt: '旧完整文稿。', prompt_document: true })?.origin, 'unknown')
  assert.equal(generationEffectiveVisualStyle({ prompt: '旧普通模板。', project_style_version: style.version }), undefined)
  assert.equal(isEffectiveVisualStyle({ origin: 'project', fingerprint: 'invalid' }), false)
  assert.equal(isEffectiveVisualStyle({ origin: 'invented', fingerprint: project.fingerprint }), false)
})

test('preview and queue derive style provenance on the server instead of trusting caller metadata', async () => {
  const { project, model, style } = await fixture()
  const prompt = '制作铜表。\n\n【项目画风约束】\n真人摄影。\n【项目画风约束结束】'
  const preview = await call('POST', `/api/projects/${project.id}/generate/preview`, {
    model_id: model.id, source_artifact_type: 'prop', prompt, prompt_document: true,
    effective_visual_style: { origin: 'project', fingerprint: '0'.repeat(64) },
  })
  assert.equal(preview.prompt, prompt)
  assert.equal(preview.project_style_version, style.version)
  assert.equal(preview.effective_visual_style.origin, 'custom')
  const queued = await call('POST', `/api/projects/${project.id}/generate`, preview)
  const request = JSON.parse(queued.request)
  assert.equal(request.prompt, prompt)
  assert.deepEqual(request.effective_visual_style, preview.effective_visual_style)
})

test('custom and removed board styles require per-image review before becoming project references', async () => {
  for (const origin of ['custom', 'removed'] as const) {
    const { project, model, profile, style } = await fixture()
    const prompt = '制作铜表。' + (origin === 'custom' ? '\n\n【项目画风约束】\n真人摄影。\n【项目画风约束结束】' : '')
    const input = { model_id: model.id, expected_revision: profile.revision, prompt_document: true, prompt_override: prompt }
    const preview = await call('POST', `/api/visual-profiles/${profile.id}/board-preview`, input)
    assert.equal(preview.prompt, prompt)
    assert.equal(preview.project_style_version, style.version)
    assert.equal(preview.effective_visual_style.origin, origin)
    const batch = await call('POST', `/api/visual-profiles/${profile.id}/generate`, { ...input,
      prompt: preview.prompt, reference_signature: preview.reference_signature, project_style_version: style.version,
      ratio: '16:9', resolution: null, quality: null, clarity: null, background: null,
    })
    const request = JSON.parse(batch.jobs[0].request)
    assert.deepEqual(request.effective_visual_style, preview.effective_visual_style)
    assert.equal(request.prompt, prompt)
    // Simulate an older saved document job: compatibility must derive the
    // effective style from its actual prompt and project snapshot as well.
    if (origin === 'custom') {
      delete request.effective_visual_style
      const historicalRequest = JSON.stringify(request)
      run('UPDATE jobs SET request=? WHERE id=?', historicalRequest, batch.jobs[0].id)
      batch.jobs[0].request = historicalRequest
      const publicDetail = await call('GET', `/api/projects/${project.id}`)
      const publicJob = publicDetail.jobs.find((item: { id: string }) => item.id === batch.jobs[0].id)
      const publicRequest = JSON.parse(publicJob.request)
      assert.equal(publicRequest.effective_visual_style.origin, 'custom')
      const { effective_visual_style: _derived, ...originalFields } = publicRequest
      assert.deepEqual(originalFields, request)
      assert.equal(one<Job>('SELECT * FROM jobs WHERE id=?', batch.jobs[0].id)!.request, historicalRequest, 'public derivation never writes to the saved request')
    }
    const { assetId, job } = complete(batch.jobs[0])
    autoConfirmGeneratedProfileBoard(job)
    assert.equal(one<{ board_asset_id: string | null }>('SELECT board_asset_id FROM visual_profiles WHERE id=?', profile.id)?.board_asset_id, null)
    assert.match(referenceStyleWarnings(project.id, [assetId], style).join(''), origin === 'custom' ? /自定义画风/ : /移除项目画风/)
    const bulk = await call('POST', `/api/projects/${project.id}/visual-profiles/confirm-first`, {
      profiles: [{ id: profile.id, expected_revision: profile.revision }], expected_style_version: style.version,
    })
    assert.equal(bulk.confirmed.length, 0)
    assert.match(bulk.skipped[0].message, /逐张核对/)
    const approved = await call('PATCH', `/api/visual-profiles/${profile.id}`, {
      expected_revision: profile.revision, expected_style_version: style.version, board_asset_id: assetId,
    })
    assert.equal(approved.board_style_status, 'current')
    assert.equal(approved.board_style_version, style.version)
    assert.deepEqual(referenceStyleWarnings(project.id, [assetId], style), [])
    assert.equal(generationEffectiveVisualStyle(JSON.parse(job.request))?.origin, origin, 'visual review does not rewrite generation provenance')
  }
})

test('inherited board styles still auto-confirm and legacy ordinary jobs remain compatible', async () => {
  for (const legacy of [false, true]) {
    const { project, model, profile, style } = await fixture()
    const preview = await call('POST', `/api/visual-profiles/${profile.id}/board-preview`, { model_id: model.id, expected_revision: profile.revision })
    assert.equal(preview.effective_visual_style.origin, 'project')
    const batch = await call('POST', `/api/visual-profiles/${profile.id}/generate`, {
      model_id: model.id, expected_revision: profile.revision, prompt: preview.prompt, reference_signature: preview.reference_signature,
      project_style_version: style.version, ratio: '16:9', resolution: null, quality: null, clarity: null, background: null,
    })
    if (legacy) {
      const request = JSON.parse(batch.jobs[0].request)
      delete request.effective_visual_style
      delete request.project_visual_style
      run('UPDATE jobs SET request=? WHERE id=?', JSON.stringify(request), batch.jobs[0].id)
      batch.jobs[0].request = JSON.stringify(request)
    }
    const { assetId, job } = complete(batch.jobs[0])
    autoConfirmGeneratedProfileBoard(job)
    assert.equal(one<{ board_asset_id: string }>('SELECT board_asset_id FROM visual_profiles WHERE id=?', profile.id)?.board_asset_id, assetId)
    assert.deepEqual(referenceStyleWarnings(project.id, [assetId], style), [])
  }
})

test('historical custom boards incorrectly auto-confirmed as current need a new explicit review', async () => {
  const { project, model, profile, style } = await fixture()
  const prompt = '制作铜表。\n\n【项目画风约束】真人摄影【项目画风约束结束】'
  const queued = await call('POST', `/api/projects/${project.id}/generate`, {
    model_id: model.id, source_artifact_type: 'prop', prompt, prompt_document: true,
  })
  const request = { ...JSON.parse(queued.request), visual_profile_id: profile.id, auto_confirm_first: true }
  delete request.effective_visual_style
  run('UPDATE jobs SET request=? WHERE id=?', JSON.stringify(request), queued.id)
  const { assetId, job } = complete({ ...queued, request: JSON.stringify(request) })
  run("UPDATE visual_profiles SET board_asset_id=?, board_style_version=?, definition_status='ready' WHERE id=?", assetId, style.version, profile.id)
  const detail = await call('GET', `/api/projects/${project.id}`)
  assert.equal(detail.visual_profiles[0].board_style_status, 'needs_review')
  assert.match(referenceStyleWarnings(project.id, [assetId], style).join(''), /自定义画风/)
  const shot = await call('POST', `/api/projects/${project.id}/shots`, { title: '铜表近景' })
  await call('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [{ profile_id: profile.id, required: true }] })
  const input = { shot_id: shot.id, model_id: model.id, prompt: '铜表近景。' }
  const blocked = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/generate/preview`, payload: input })
  assert.equal(blocked.statusCode, 422, blocked.body)
  await call('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: profile.revision, expected_style_version: style.version, board_asset_id: assetId })
  const reviewed = await call('GET', `/api/projects/${project.id}`)
  assert.equal(reviewed.visual_profiles[0].board_style_status, 'current')
  assert.deepEqual(referenceStyleWarnings(project.id, [assetId], style), [])
  await call('POST', `/api/projects/${project.id}/generate/preview`, input)
  const saved = JSON.parse(one<Job>('SELECT * FROM jobs WHERE id=?', job.id)!.request)
  assert.deepEqual(saved.visual_style_reviews.map(({ profile_id, style_version }: { profile_id: string; style_version: string }) => ({ profile_id, style_version })),
    [{ profile_id: profile.id, style_version: style.version }])
  const { visual_style_reviews: _reviews, ...unchanged } = saved
  assert.deepEqual(unchanged, request, 'review audit leaves every original generation field intact')
  // A locked shot can retain this reviewed image after the profile adopts a
  // later board. The candidate history plus review still establish ownership.
  await call('PUT', `/api/shots/${shot.id}/visual-bindings`, { bindings: [{ profile_id: profile.id, required: true, sync_mode: 'locked' }] })
  const laterAsset = newId()
  run("INSERT INTO assets (id, project_id, kind, filename, path, source, created_at) VALUES (?, ?, 'image', 'later.png', '/tmp/later.png', 'upload', ?)", laterAsset, project.id, now())
  await call('PATCH', `/api/visual-profiles/${profile.id}`, { expected_revision: profile.revision, expected_style_version: style.version, board_asset_id: laterAsset })
  const retained = await call('POST', `/api/projects/${project.id}/generate/preview`, input)
  assert.deepEqual(retained.reference_asset_ids, [assetId])
  assert.deepEqual(referenceStyleWarnings(project.id, [assetId], style), [])
  const unreviewed = await call('POST', `/api/projects/${project.id}/generate`, {
    model_id: model.id, source_artifact_type: 'prop', prompt, prompt_document: true,
  })
  const { assetId: unreviewedAsset } = complete(unreviewed)
  run('INSERT INTO visual_profile_candidates (profile_id, asset_id, archived, updated_at) VALUES (?, ?, 0, ?)', profile.id, unreviewedAsset, now())
  assert.equal(referenceStyleWarnings(project.id, [unreviewedAsset], style).length, 1, 'candidate ownership alone cannot substitute for a visual review')
})

test('independent generated views retain custom style fingerprints until explicitly reviewed', async () => {
  for (const origin of ['custom', 'removed'] as const) {
    const { project, model, profile, style } = await fixture()
    const prompt = '制作铜表正面参考。' + (origin === 'custom' ? '\n【项目画风约束】真人摄影【项目画风约束结束】' : '')
    const queued = await call('POST', `/api/projects/${project.id}/generate`, {
      model_id: model.id, source_artifact_type: 'prop', prompt, prompt_document: true,
    })
    const request = { ...JSON.parse(queued.request), visual_reference_generation: true, visual_profile_id: profile.id,
      visual_profile_revision: profile.revision, visual_reference_view: 'front', visual_reference_purpose: 'structure', visual_reference_label: '' }
    run('UPDATE jobs SET request=? WHERE id=?', JSON.stringify(request), queued.id)
    const { assetId, job } = complete({ ...queued, request: JSON.stringify(request) })
    registerGeneratedVisualReference(job, assetId)
    const result = await call('GET', `/api/projects/${project.id}`), reference = result.visual_profiles[0].reference_assets[0]
    assert.equal(reference.status, 'candidate')
    assert.equal(reference.style_version, request.effective_visual_style.fingerprint)
    assert.notEqual(reference.style_version, style.version)
    assert.equal(referenceStyleWarnings(project.id, [assetId], style).length, 1)
    // Older worker versions wrote the project baseline even for custom views.
    // That historical label must not bypass review when the image is reused.
    run("UPDATE visual_profile_reference_assets SET style_version=?, status='confirmed' WHERE id=?", style.version, reference.id)
    assert.equal(referenceStyleWarnings(project.id, [assetId], style).length, 1)
    const reviewed = await call('PATCH', `/api/visual-profiles/${profile.id}/reference-assets/${reference.id}`, {
      expected_revision: profile.revision, expected_style_version: style.version, status: 'confirmed',
    })
    assert.equal(reviewed.reference_assets[0].style_version, style.version)
    assert.equal(reviewed.reference_assets[0].status, 'confirmed')
    assert.deepEqual(referenceStyleWarnings(project.id, [assetId], style), [])
    registerGeneratedVisualReference(job, assetId)
    const retry = await call('GET', `/api/projects/${project.id}`)
    assert.equal(retry.visual_profiles[0].reference_assets[0].status, 'confirmed', 'a worker retry preserves the later visual review')
  }
})
