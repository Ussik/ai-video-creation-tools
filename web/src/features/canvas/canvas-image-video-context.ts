import type { Model, ProjectDetail, ShotVisualBinding } from '../../shared/api/api'
import type { CanvasGraph, CanvasNode } from './ProjectCanvas'
import { shotImagePrompt } from '@video-studio/shared/storyboard/shot-prompts'
import { extractPromptBody, type ManagedPromptBlockName } from '@video-studio/shared/visuals/prompt-document'
import { isPromptSectionDocument, parsePromptSectionDocument, serializePromptSectionDocument,
  type PromptSectionBlock } from '@video-studio/shared/visuals/prompt-section-document'
import { extractPromptReferenceIds, promptReferenceToken, resolvePromptReferences, tokenizePromptReferenceNumbers } from '@video-studio/shared/visuals/prompt-references'
import { scopedVisualReferenceAssetIds, videoReferenceManifest, visualBindingReferenceAssetIds } from '@video-studio/shared/media/video-reference-manifest'
import { visualBindingApplies } from '@video-studio/shared/visuals/visual-binding-usage'
import { visualGenerationPrompt } from '@video-studio/shared/visuals/visual-prompt'
import { enrichExplicitReferenceBindings } from '@video-studio/shared/visuals/explicit-reference-context'
import { withProjectStyle } from '@video-studio/shared/visuals/visual-style'
import { promptReferenceBindings } from './canvas-prompt-references'
import { videoPreferencePrompt } from './canvas-prompt-draft'
import { canvasPromptBody } from './canvas-prompt-composition'
import { visualNodeAsset } from './canvas-visual-profiles'

const compatibleNames: ManagedPromptBlockName[] = ['镜头视觉设定', '项目画风约束']
const imageOnlySentences = [
  '生成当前镜头的单幅首帧画面。固定一个瞬间，明确主体、场景、景别、构图、光线与材质；动作过程只用于理解情境，不表现多个时间点或分格。',
  '对白与旁白仅作为情绪背景，不绘制文字、字幕、水印或设定板。',
]

export type ImageVideoSourceContext = {
  signature: string
  customized: boolean
  body: string
  referenceAssetIds: string[]
  promptReferenceOverrides: Record<string, string | null>
  excludedVisualProfileIds: string[]
  /** Labels describe identities even when a strict first-frame run omits their original images. */
  referenceLabels: Record<string, string>
  compatibleSections: PromptSectionBlock[]
  customizedSections: PromptSectionBlock[]
}

/** Stable content identity: object insertion order and canvas geometry do not affect a handoff. */
export function imageVideoContentSignature(value: unknown): string {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, ordered(entry)])) : item
  const text = JSON.stringify(ordered(value)) || ''
  let left = 0x811c9dc5, right = 0x9e3779b9
  for (let index = 0; index < text.length; index++) {
    left = Math.imul(left ^ text.charCodeAt(index), 0x01000193)
    right = Math.imul(right ^ text.charCodeAt(index), 0x85ebca6b)
  }
  return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`
}

function screenplayText(script: ProjectDetail['script'] | undefined): string {
  if (!script) return ''
  const scenes = script.scenes.map((scene, index) => [
    `场次 ${index + 1}：${scene.heading}`, scene.location && `地点：${scene.location}`,
    scene.characters && `人物：${scene.characters}`, scene.action && `动作：${scene.action}`,
    scene.dialogue && `对白：${scene.dialogue}`, scene.narration && `旁白：${scene.narration}`,
    `时长：${scene.duration} 秒`,
  ].filter(Boolean).join('\n')).join('\n\n')
  const artifacts = (script.artifacts || []).filter(artifact => artifact.content?.trim()
    && !['outline', 'characters', 'structure'].includes(artifact.artifact_type))
    .map(artifact => `${artifact.title}：${artifact.content.trim()}`).join('\n\n')
  return [script.outline && `故事大纲：${script.outline}`, script.characters && `人物设定：${script.characters}`,
    artifacts && `剧本创作产物：\n${artifacts}`, scenes && `分场内容：\n${scenes}`].filter(Boolean).join('\n\n').slice(0, 30000)
}

function bindingLabel(binding: Pick<ShotVisualBinding, 'name' | 'variant'>): string {
  return `${binding.name}${binding.variant ? `（${binding.variant}）` : ''}`
}

/** Resolve the image composer's actual inputs, without allowing a prose mention to reconnect an image. */
export function imageVideoSourceContext(graph: CanvasGraph, source: CanvasNode, detail: ProjectDetail,
  _models: Model[]): ImageVideoSourceContext {
  const allBindings = (detail.shot_visual_bindings || []).filter(binding => binding.shot_id === source.shot_id)
  const excluded = [...new Set(source.settings.excluded_visual_profile_ids || [])]
  const bindings = allBindings.filter(binding => visualBindingApplies(binding, 'image'))
  const active = bindings.filter(binding => !excluded.includes(binding.profile_id))
  const referenceMode = source.settings.visual_reference_mode || 'profiles'
  const edges = graph.edges.filter(edge => edge.target === source.id && edge.source !== source.id
    && graph.nodes.some(node => node.id === edge.source))
  const incoming = edges.flatMap(edge => {
    const input = graph.nodes.find(node => node.id === edge.source)!
    // Fixed canvas inputs intentionally override a shot binding's default scope.
    const node = edge.reference_asset_id ? { ...input, asset_id: edge.reference_asset_id,
      settings: { ...input.settings, visual_profile_id: undefined } } : input
    if (source.type !== 'generation' && node.type === 'generation') return []
    const binding = allBindings.find(binding => binding.profile_id === node.settings.visual_profile_id)
    return binding && !visualBindingApplies(binding, 'image') ? [] : [node]
  })
  const inputTexts = incoming.map(node => node.type === 'project_script_ref' ? screenplayText(detail.script)
    : node.type === 'text' || node.type === 'image_analysis' || node.type === 'video_analysis' ? node.text.trim() : '').filter(Boolean)
  const assetMap = new Map(detail.assets.filter(asset => asset.kind === 'image'
    && (!asset.project_id || !detail.id || asset.project_id === detail.id)).map(asset => [asset.id, asset]))
  const imageEdges = edges.filter(edge => incoming.some(node => node.id === edge.source && node.type !== 'image_analysis' && node.type !== 'video_analysis'))
  if (imageEdges.some(edge => edge.reference_asset_id && !assetMap.has(edge.reference_asset_id))) {
    throw new Error('图片节点的参考已失效，请先重新选择参考图片')
  }
  const connected = [...new Set(incoming.flatMap(node => {
    const binding = referenceMode === 'profiles' && node.settings.visual_profile_id
      ? bindings.find(binding => binding.profile_id === node.settings.visual_profile_id) : undefined
    return binding ? visualBindingReferenceAssetIds(binding)
      : [visualNodeAsset(node, detail, true)?.id].filter((id): id is string => !!id)
  }).filter(id => assetMap.has(id)))]
  const pinned = imageEdges.flatMap(edge => edge.reference_asset_id || [])
  const rawIds = scopedVisualReferenceAssetIds(connected, allBindings, active, pinned)
  if (referenceMode === 'profiles') for (const binding of [...active].sort((left, right) => {
    const a = `${left.kind}\0${left.name}\0${left.profile_id}`, b = `${right.kind}\0${right.name}\0${right.profile_id}`
    return a < b ? -1 : a > b ? 1 : 0
  })) for (const id of visualBindingReferenceAssetIds(binding)) if (!rawIds.includes(id) && assetMap.has(id)) rawIds.push(id)
  const resolved = resolvePromptReferences({ prompt: '', referenceAssetIds: rawIds, overrides: source.settings.prompt_reference_overrides })
  if (resolved.referenceAssetIds.some(id => !assetMap.has(id))) throw new Error('图片节点的参考已失效，请先重新选择参考图片')
  // Legacy positions describe the list currently displayed by the composer,
  // after replacement/removal. Stable tokens already carry their own identity.
  const preparedIds = resolved.referenceAssetIds
  const sections = isPromptSectionDocument(source.settings.prompt_sections) ? source.settings.prompt_sections
    : (source.settings.prompt_document || source.settings.prompt_is_final) && source.text.trim()
      ? parsePromptSectionDocument(source.text, { sourceText: source.settings.prompt_template }) : undefined
  const shot = detail.shots.find(shot => shot.id === source.shot_id)
  const savedBody = sections ? extractPromptBody({ prompt: serializePromptSectionDocument(sections), prompt_template: source.settings.prompt_template })
    : source.settings.prompt_body !== undefined ? extractPromptBody({ prompt: '', prompt_body: source.settings.prompt_body })
      : source.settings.prompt_is_final || source.settings.prompt_document || source.settings.prompt_override
        ? extractPromptBody({ prompt: source.text, prompt_template: source.settings.prompt_template }) : undefined
  const ownPrompt = source.prompt.trim() && source.prompt !== shot?.prompt ? source.prompt
    : shot ? shotImagePrompt(shot) : source.prompt
  const ownBase = source.settings.prompt_is_final ? source.settings.prompt_base ?? ownPrompt
    : source.settings.prompt_override ? source.text : ownPrompt
  const compiled = tokenizePromptReferenceNumbers([...inputTexts, ownBase].filter(Boolean).join('\n\n'), preparedIds)
  let body = tokenizePromptReferenceNumbers(savedBody === undefined ? compiled : canvasPromptBody({
    prompt: savedBody, prompt_body: savedBody,
    prompt_template: tokenizePromptReferenceNumbers(source.settings.prompt_template || '', preparedIds),
  }, compiled), preparedIds)
  // A broad authored line edit can overlap an insertion in a line-based merge.
  // Keep newly connected instructions; an old input deliberately removed from
  // an authored document remains removed because it is present in its baseline.
  if (savedBody !== undefined) {
    const baseline = tokenizePromptReferenceNumbers(source.settings.prompt_template || '', preparedIds)
    const newInputs = inputTexts.map(text => tokenizePromptReferenceNumbers(text, preparedIds))
      .filter(text => !baseline.includes(text) && !body.includes(text))
    body = [...newInputs, body].filter(Boolean).join('\n\n')
  }
  const compatibleSections = sections?.blocks.filter(block => block.kind === 'managed' && compatibleNames.includes(block.name!))
    .map(block => ({ ...block, text: tokenizePromptReferenceNumbers(block.text, preparedIds),
      ...(block.sourceText !== undefined ? { sourceText: tokenizePromptReferenceNumbers(block.sourceText, preparedIds) } : {}),
      ...(block.pendingSourceText !== undefined ? { pendingSourceText: tokenizePromptReferenceNumbers(block.pendingSourceText, preparedIds) } : {}),
      ...(block.mergeBaseText !== undefined ? { mergeBaseText: tokenizePromptReferenceNumbers(block.mergeBaseText, preparedIds) } : {}),
    })) || []
  const customizedSections = compatibleSections.filter(block => block.deleted && block.deletionSource !== 'source'
    || !block.deleted && (block.sourceText === undefined || block.text !== block.sourceText))
  const labels: Record<string, string> = {}
  const identityIds = new Set<string>()
  for (const asset of detail.assets) labels[asset.id] = asset.filename || '参考对象'
  for (const node of incoming) {
    const id = visualNodeAsset(node, detail, true)?.id
    if (id && node.title) labels[id] = node.title
  }
  for (const binding of allBindings) for (const id of visualBindingReferenceAssetIds(binding)) {
    labels[id] = bindingLabel(binding)
    identityIds.add(id)
  }
  for (const profile of detail.visual_profiles || []) {
    for (const id of [profile.board_asset_id, ...(profile.reference_assets || []).map(reference => reference.asset_id)]) {
      if (id) { labels[id] = bindingLabel(profile); identityIds.add(id) }
    }
  }
  for (const [id, replacement] of Object.entries(resolved.replacements)) {
    if (replacement && !identityIds.has(replacement) && labels[id]
      && (identityIds.has(id) || labels[replacement] === assetMap.get(replacement)?.filename || !labels[replacement])) {
      labels[replacement] = labels[id]
    }
  }
  const customized = !!(source.settings.prompt_override || source.settings.prompt_is_final || source.settings.prompt_document
    || source.settings.prompt_sections || source.settings.prompt_body !== undefined || inputTexts.length
    || Object.keys(resolved.replacements).length || excluded.length
    || edges.some(edge => edge.reference_asset_id || !graph.nodes.find(node => node.id === edge.source)?.settings.visual_profile_id))
  const context = { customized, body, referenceAssetIds: resolved.referenceAssetIds,
    promptReferenceOverrides: resolved.replacements, excludedVisualProfileIds: excluded,
    referenceLabels: labels, compatibleSections, customizedSections }
  const explicitIds = resolvePromptReferences({ prompt: '', referenceAssetIds: pinned, overrides: resolved.replacements })
    .referenceAssetIds.filter(id => preparedIds.includes(id))
  const explicitContext = referenceMode === 'profiles' ? enrichExplicitReferenceBindings([], {
    referenceAssetIds: preparedIds, explicitReferenceAssetIds: explicitIds, savedBindings: allBindings,
    profiles: detail.visual_profiles, overrides: resolved.replacements, excludedVisualProfileIds: excluded,
  }).map(binding => ({ profile_id: binding.profile_id, kind: binding.kind, name: binding.name, variant: binding.variant,
    revision: binding.revision, definition: binding.definition, view_requirements: binding.view_requirements,
    board_asset_id: binding.board_asset_id, selected_reference_asset_ids: binding.selected_reference_asset_ids,
    reference_assets: binding.reference_assets?.map(reference => ({ id: reference.id, asset_id: reference.asset_id,
      view: reference.view, purpose: reference.purpose, label: reference.label, revision: reference.revision,
      style_version: reference.style_version })) }))
    .sort((left, right) => `${left.profile_id || ''}\0${left.kind}\0${left.name}`
      .localeCompare(`${right.profile_id || ''}\0${right.kind}\0${right.name}`)) : []
  const labelIds = new Set([...context.referenceAssetIds,
    ...extractPromptReferenceIds([body, ...compatibleSections.map(block => block.text)].join('\n'))])
  for (const id of [...labelIds]) if (resolved.replacements[id]) labelIds.add(resolved.replacements[id]!)
  return { ...context, signature: imageVideoContentSignature({ customized, body, references: context.referenceAssetIds,
    overrides: context.promptReferenceOverrides, excluded: [...excluded].sort(),
    explicitReferenceContext: explicitContext,
    labels: Object.fromEntries([...labelIds].map(id => [id, labels[id]])),
    sections: compatibleSections.map(block => ({ name: block.name, text: block.text, deleted: !!block.deleted,
      custom: customizedSections.includes(block) })) }) }
}

function inheritedText(text: string, context: ImageVideoSourceContext, references: string[], frame: boolean): string {
  return text.replace(/\[\[ref:([^\]\r\n]+)\]\]/g, (_token, id: string) => {
    const mapped = Object.hasOwn(context.promptReferenceOverrides, id) ? context.promptReferenceOverrides[id] : id
    if (mapped && references.includes(mapped)) return promptReferenceToken(mapped)
    const label = context.referenceLabels[mapped || id] || context.referenceLabels[id] || '对应参考对象'
    return `${frame ? '首帧' : '画面'}中的${label}`
  })
}

/** Build a fresh video document around the latest image design; source edits never revive the old shot video prose. */
export function applyImageVideoContext(node: CanvasNode, context: ImageVideoSourceContext, detail: ProjectDetail,
  _models: Model[]): CanvasNode {
  if (!context.customized) return node
  const mode = node.settings.mode || 'first_frame', frame = ['first_frame', 'first_last_frame'].includes(mode)
  const storyboardId = node.settings.storyboard_reference_asset_id || undefined
  const excluded = context.excludedVisualProfileIds
  const allBindings = (detail.shot_visual_bindings || []).filter(binding => binding.shot_id === node.shot_id)
  const bindings = promptReferenceBindings(allBindings.filter(binding => visualBindingApplies(binding, 'video'))
    .sort((left, right) => {
      const a = `${left.kind}\0${left.name}\0${left.profile_id}`, b = `${right.kind}\0${right.name}\0${right.profile_id}`
      return a < b ? -1 : a > b ? 1 : 0
    }), context.promptReferenceOverrides)
  const manualIds = [...new Set([...(storyboardId ? [storyboardId] : []), ...(frame ? [] : context.referenceAssetIds)])]
  const references = videoReferenceManifest(manualIds, bindings, { mode, visual_reference_mode: node.settings.visual_reference_mode || (frame ? 'keyframe' : 'profiles'),
    storyboard_reference_asset_id: storyboardId, excluded_visual_profile_ids: excluded }).map(entry => entry.asset_id)
  const templateBindings = !frame && (node.settings.visual_reference_mode || 'profiles') === 'profiles'
    ? enrichExplicitReferenceBindings(bindings, { referenceAssetIds: references,
      explicitReferenceAssetIds: context.referenceAssetIds, savedBindings: allBindings, profiles: detail.visual_profiles,
      overrides: context.promptReferenceOverrides, excludedVisualProfileIds: excluded })
    : bindings
  let imageBody = context.body
  for (const sentence of imageOnlySentences) imageBody = imageBody.replaceAll(sentence, '')
  imageBody = inheritedText(imageBody.trim(), context, references, frame)
  const shot = detail.shots.find(shot => shot.id === node.shot_id)
  const body = [
    '生成当前分镜的一个连续视频镜头。以下最新画面设计决定人物、服装、道具、场景、光线与空间关系，整段视频保持一致。',
    frame ? '从指定首帧的构图、人物位置、姿态和物体状态开始，连续展开动作。'
      : '以分镜构图参考和以下最新画面设计安排开镜，其他参考仅提供对应对象的身份、外形与空间信息。',
    `开镜画面设计：\n${imageBody}`,
    '动作与运镜：从上述状态自然展开与当前情境一致的动作和表情变化，明确动作主体与对象；镜头运动与节奏服务于当前画面，保持动作、视线和空间连续，不拼接无关镜头，不额外增加人物。',
    shot?.end_state?.trim() && `收镜意向（仅在与以上最新人物及画面设计兼容时采用）：${shot.end_state.trim()}`,
    shot?.cut_note?.trim() && `接镜意向（仅在与以上最新画面设计兼容时采用）：${shot.cut_note.trim()}`,
    '不添加画面文字、字幕或水印。',
  ].filter(Boolean).join('\n\n')
  const template = tokenizePromptReferenceNumbers(withProjectStyle(visualGenerationPrompt(videoPreferencePrompt(body, mode,
    node.settings.duration || shot?.duration || 5, { ratio: node.settings.ratio || 'adaptive', resolution: node.settings.resolution || undefined }),
  templateBindings, references, node.settings.visual_reference_mode || (frame ? 'keyframe' : 'profiles'), {
    mode, storyboard_reference_asset_id: storyboardId, excluded_visual_profile_ids: excluded,
    video_reference_usages: node.settings.video_reference_usages,
  }), detail.project_visual_style), references)
  const sections = parsePromptSectionDocument(template, { sourceText: template })
  const used = new Set(sections.blocks.map(block => block.id))
  const generatedSections = sections.blocks.filter(block => block.kind === 'managed')
  for (const inherited of context.customizedSections) {
    const occurrence = context.compatibleSections.filter(block => block.name === inherited.name).indexOf(inherited)
    const generated = generatedSections.filter(block => block.name === inherited.name)[occurrence]
    const next: PromptSectionBlock = { id: generated?.id || `inherited-${inherited.name}`, kind: 'managed', name: inherited.name,
      text: inherited.deleted ? '' : inheritedText(inherited.text, context, references, frame),
      sourceText: generated?.text || '', ...(inherited.deleted ? { deleted: true } : {}) }
    if (generated) sections.blocks[sections.blocks.indexOf(generated)] = next
    else {
      while (used.has(next.id)) next.id += '-copy'
      if (next.text && serializePromptSectionDocument(sections)) sections.blocks.push({ id: `${next.id}-separator`, kind: 'body', text: '\n\n' })
      sections.blocks.push(next)
    }
    used.add(next.id)
  }
  const document = serializePromptSectionDocument(sections)
  return { ...node, prompt: body, text: document, settings: { ...node.settings,
    prompt_override: true, prompt_is_final: true, prompt_document: true, prompt_sections: sections,
    prompt_body: body, prompt_base: body, prompt_template: template,
    prompt_reference_overrides: { ...context.promptReferenceOverrides }, excluded_visual_profile_ids: [...excluded],
  } }
}
