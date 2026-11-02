import type { Asset, Model, ProjectDetail, Shot } from '../../shared/api/api'
import type { CanvasGraph, CanvasNode, GenerationRequest } from './ProjectCanvas'
import { shotImagePrompt, shotVideoPrompt } from '@video-studio/shared/storyboard/shot-prompts'
import { imageGenerationDefaults } from './canvas-model-parameters'
import { storyboardRevision } from './canvas-storyboard-revision'
import { visualJobRequest } from './canvas-visual-profiles'
import { parsePromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'
import { tokenizePromptReferenceNumbers } from '@video-studio/shared/visuals/prompt-references'

/** Restore selected shots, current generation requests and reference assets into one graph. */
export function importShotGraph(current: CanvasGraph, shots: Shot[], detail: ProjectDetail,
  availableModels: Model[], models: Model[], blankNode: (type: CanvasNode['type'], x: number, y: number) => CanvasNode,
  nodeSize: (node: CanvasNode, asset?: Asset) => { height: number }) {
  const modelMap = new Map(models.map(model => [model.id, model]))
  const assetMap = new Map(detail.assets.map(asset => [asset.id, asset]))
  const activeShotIds = new Set([...(detail.shots || []), ...(detail.historical_shots || []), ...shots]
    .filter(shot => !shot.deleted_at).map(shot => shot.id))
  let addedShots = 0, addedJobs = 0, addedAssets = 0, missingReferences = 0
  let hitLimit = false
  let firstImported: CanvasNode | null = null
  const nodes = [...current.nodes]
  const edges = [...current.edges]
  let y = nodes.length ? Math.max(...nodes.map((node) => node.y + node.height)) + 100 : 80
  for (const shot of shots) {
    const revision = storyboardRevision(shot.storyboard_revision)
    const shotJobs = detail.jobs.filter((item) => {
      if (item.job_type !== 'generation' || item.shot_id !== shot.id) return false
      // Task history survives recycling. Restoring a shot alone must not
      // reattach an output that remains in the asset recycle bin.
      if (item.result_asset_id && !assetMap.has(item.result_asset_id)) return false
      const request = visualJobRequest(item)
      return storyboardRevision(request.storyboard_revision) === revision
        && !request.visual_profile_id && !request.asset_task_id && request.visual_reference_generation !== true
        && !request.visual_reference_view && !['character', 'location', 'prop'].includes(String(request.source_artifact_type || ''))
    })
    const job = shotJobs[0]
    const imageModel = availableModels.find(model => model.modality === 'image')
    let settings: CanvasNode['settings'] = { ...(!job ? { modality: 'image' as const, ...imageGenerationDefaults(imageModel) } : {}), duration: shot.duration, ratio: detail.ratio,
      group_id: shot.id, storyboard_revision: revision,
      group_title: `镜头 ${String(shot.position + 1).padStart(2, '0')} · ${shot.title}` }
    let referenceIds: string[] = []
    let restoredDraft = ''
    let prompt = job && modelMap.get(job.model_id || '')?.modality === 'video' ? shotVideoPrompt(shot) : shotImagePrompt(shot)
    if (job) {
      try {
        const request = JSON.parse(job.request) as Partial<GenerationRequest>
        settings = { ...settings, mode: request.mode, resolution: request.resolution, clarity: request.clarity,
          quality: request.quality, background: request.background, duration: request.duration,
          ratio: request.ratio, generate_audio: request.generate_audio, draft: request.draft,
          visual_reference_mode: request.visual_reference_mode,
          reference_video_url: request.reference_video_url }
        referenceIds = Array.isArray(request.reference_asset_ids)
          ? request.reference_asset_ids.filter((id): id is string => typeof id === 'string') : []
        prompt = request.visual_source_prompt ?? (typeof request.prompt === 'string' ? request.prompt : prompt)
        if (request.prompt_is_final && typeof request.prompt === 'string') {
          restoredDraft = request.prompt
          settings = { ...settings, prompt_is_final: true, prompt_override: true, prompt_base: prompt,
            prompt_document: request.prompt_document, prompt_body: request.prompt_body, prompt_template: request.prompt_template || '',
            ...(request.prompt_document ? { prompt_sections: parsePromptSectionDocument(tokenizePromptReferenceNumbers(request.prompt, referenceIds), {
              sourceText: tokenizePromptReferenceNumbers(request.prompt_template || '', referenceIds),
            }) } : {}) }
        }
      } catch { /* Keep the shot defaults for legacy jobs. */ }
    }
    const shotGenerations = nodes.filter((node) => node.type === 'generation' && node.shot_id === shot.id)
    let generation = job ? shotGenerations.find((node) => node.job_id === job.id) : shotGenerations[0]
    const newGeneration = !generation
    if (!generation) {
      if (nodes.length >= 500) { hitLimit = true; break }
      const rowY = shotGenerations.length
        ? Math.max(...nodes.filter((node) => node.shot_id === shot.id).map((node) => node.y + node.height)) + 80 : y
      generation = { ...blankNode('generation', 80, rowY), title: shot.title, shot_id: shot.id,
        model_id: job ? job.model_id : imageModel?.id || null, job_id: job?.id || null, prompt, text: restoredDraft,
        asset_id: job?.result_asset_id || null, settings }
      nodes.push(generation)
      if (!firstImported) firstImported = generation
      if (shotGenerations.length) addedJobs += 1
      else addedShots += 1
    }
    let leftY = generation.y
    if (newGeneration) for (const referenceId of referenceIds) {
      const asset = detail.assets.find((item) => item.id === referenceId && item.kind === 'image')
      if (!asset) { missingReferences += 1; continue }
      let source = nodes.find((node) => node.asset_id === asset.id && node.type === 'image')
      if (!source) {
        if (nodes.length >= 500) { hitLimit = true; break }
        source = { ...blankNode('image', generation.x - 350, leftY), title: asset.filename,
          asset_id: asset.id, shot_id: asset.shot_id && activeShotIds.has(asset.shot_id) ? asset.shot_id : null }
        nodes.push(source)
        addedAssets += 1
        leftY += source.height + 22
      }
      if (!edges.some((edge) => edge.source === source.id && edge.target === generation.id)) {
        if (edges.length >= 1000) { hitLimit = true; break }
        edges.push({ id: crypto.randomUUID(), source: source.id, target: generation.id, reference_asset_id: asset.id })
      }
    }
    const currentResults = new Set(shotJobs.map(item => item.result_asset_id))
    const assets = detail.assets.filter((asset) => asset.kind !== 'audio' && asset.source !== 'export' &&
      !referenceIds.includes(asset.id) && (asset.id === shot.selected_asset_id
        || asset.shot_id === shot.id && (revision === 0 || currentResults.has(asset.id))))
    let rightY = Math.max(generation.y, ...nodes.filter((node) => node.shot_id === shot.id &&
      (node.type === 'image' || node.type === 'video' || node.type === 'text')).map((node) => node.y + node.height + 22))
    for (const asset of assets) {
      const kind = asset.kind
      if (kind !== 'image' && kind !== 'video' && kind !== 'text') continue
      let media = nodes.find((node) => node.asset_id === asset.id && node.type === kind)
      if (!media) {
        if (nodes.length >= 500) { hitLimit = true; break }
        media = { ...blankNode(kind, generation.x + generation.width + 170, rightY), title: asset.filename, asset_id: asset.id,
          shot_id: shot.id, text: kind === 'text' ? asset.text || '' : '' }
        nodes.push(media)
        addedAssets += 1
        rightY += media.height + 25
        if (asset.id === job?.result_asset_id) {
          if (edges.length >= 1000) { hitLimit = true; break }
          edges.push({ id: crypto.randomUUID(), source: generation.id, target: media.id })
        }
      } else {
        const mediaId = media.id
        if (newGeneration && asset.id === job?.result_asset_id &&
          !edges.some((edge) => edge.source === generation.id && edge.target === mediaId)) {
          if (edges.length >= 1000) { hitLimit = true; break }
          edges.push({ id: crypto.randomUUID(), source: generation.id, target: mediaId })
        }
      }
    }
    y = Math.max(y, generation.y + nodeSize(generation, assetMap.get(generation.asset_id || '')).height + 60, rightY + 60, leftY + 60)
  }
  const graph = addedShots || addedJobs || addedAssets ? { ...current, nodes, edges } : current
  return { graph, addedShots, addedJobs, addedAssets, missingReferences, hitLimit, firstImported }
}
