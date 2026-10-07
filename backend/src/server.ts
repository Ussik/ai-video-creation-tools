import Fastify, { type FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { ZodError, z } from 'zod'
import { all, dataDir, db, initDb, mediaDir, newId, now, one, required, run } from './db.js'
import type { Asset, AssetReview, AssetTask, AssetTaskEvent, CanvasEdge, CanvasNode, CutReview, Job, Model, Project, Provider, ScriptArtifact, ScriptConversation, ScriptMessage, ScriptScene, Shot, TimelineClip } from './db.js'
import { decryptKey, encryptKey } from './secrets.js'
import { generate, recoverImage, streamText } from './providers.js'
import { parseStructuredOutput } from './structured-output.js'
import { workflowRequest, workflowDraftInput, normalizeWorkflowRequest, workflowInstructions, parseWorkflowDraft, workflowReply } from './script-workflow.js'
import { scriptSettingsSchema, scriptIntentPrompt, parseScriptIntent } from './script-intent.js'
import { themeVisualInput, themeVisualPrompt, parseThemeVisuals } from './script-theme-visuals.js'
import { isScriptThemeCategory } from './script-theme-catalog.js'
import { inputFields, replyClassification, replyClassificationPrompt, parseReplyClassifications, replyClassificationVersion, replyFollowingMessages, type ReplySource } from './script-reply-classification.js'
import { referenceDocuments, decodeReferenceDocuments, referenceContext } from './script-references.js'
import { semanticContinuityPrompt, parseSemanticContinuity } from './continuity-semantics.js'
import { fetchModelCatalog, type ModelCatalogConfig } from './model-catalog.js'
import { extractVideoFrame, probeVideoDurationMs, render, type RenderClip } from './render.js'

const idParams = z.object({ id: z.string().min(1) })
const projectInput = z.object({ name: z.string().trim().min(1).max(120), brief: z.string().default(''), ratio: z.enum(['16:9', '9:16']).default('16:9') })
const projectPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(), brief: z.string().optional(),
  ratio: z.enum(['16:9', '9:16']).optional(), music_asset_id: z.string().nullable().optional(),
})
const productionRangeInput = z.object({
  start_shot_id: z.string().min(1).nullable(), end_shot_id: z.string().min(1).nullable(),
}).strict()
const shotInput = z.object({
  title: z.string().trim().min(1).max(120), prompt: z.string().default(''),
  duration: z.number().int().min(1).max(30).default(5),
  source_scene_id: z.string().min(1).nullable().optional(),
  start_state: z.string().max(2000).default(''), end_state: z.string().max(2000).default(''),
  cut_note: z.string().max(2000).default(''),
})
const shotPatch = z.object({
  title: z.string().trim().min(1).max(120).optional(), prompt: z.string().optional(),
  duration: z.number().int().min(1).max(30).optional(), position: z.number().int().min(0).optional(),
  start_state: z.string().max(2000).optional(), end_state: z.string().max(2000).optional(),
  cut_note: z.string().max(2000).optional(),
})
const scriptSceneFields = z.object({
  episode_number: z.number().int().min(0).max(200).default(0),
  heading: z.string().trim().min(1).max(120),
  location: z.string().max(500).default(''), time_of_day: z.string().max(120).default(''),
  characters: z.string().max(2000).default(''), action: z.string().max(10000).default(''),
  dialogue: z.string().max(10000).default(''), narration: z.string().max(10000).default(''),
  duration: z.number().int().min(1).max(30).default(5),
})
const scriptGenerationOptions = scriptSettingsSchema

const scriptInput = z.object({
  brief: z.string().max(20000).optional(),
  outline: z.string().max(20000), characters: z.string().max(20000),
  generation_options: scriptGenerationOptions.optional(),
  scenes: z.array(scriptSceneFields.extend({ id: z.string().min(1).optional() })).max(100).optional(),
})
const scriptArtifactType = z.enum([
  'outline', 'synopsis', 'world', 'characters', 'relationships', 'locations', 'props',
  'structure', 'hooks', 'foreshadowing', 'reversals', 'constraints', 'episode_outline', 'episode_script',
])
const scriptArtifactInput = z.object({
  id: z.string().trim().min(1).max(120).optional(),
  artifact_type: scriptArtifactType,
  episode_number: z.number().int().min(0).max(200).default(0),
  title: z.string().trim().min(1).max(160),
  content: z.string().max(100000).default(''),
  position: z.number().int().min(0).max(100).optional(),
  status: z.enum(['draft', 'ready', 'edited']).default('draft'),
})
const scriptArtifactsInput = z.object({ artifacts: z.array(scriptArtifactInput).max(40) }).strict()
const scriptArtifactPatch = scriptArtifactInput.partial().omit({ id: true, artifact_type: true }).strict()
const scriptArtifactGenerationInput = z.object({
  model_id: z.string().min(1), artifact_type: scriptArtifactType,
  prompt_override: z.string().trim().min(1).max(200000).optional(),
}).strict()
const scriptScenePatch = scriptSceneFields.partial().extend({ position: z.number().int().min(0).optional() })
const scriptConversationMessage = z.object({
  id: z.string().trim().min(1).max(120).optional(),
  role: z.enum(['assistant', 'user']),
  text: z.string().trim().min(1).max(8000),
  reference_documents: referenceDocuments.optional(),
  processing_duration_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().superRefine((message, context) => {
  if (message.role !== 'assistant' && message.processing_duration_ms !== undefined) {
    context.addIssue({ code: 'custom', message: '仅模型回复可记录处理用时', path: ['processing_duration_ms'] })
  }
})
const scriptConversationInput = z.object({
  id: z.string().trim().min(1).max(120).optional(),
  label: z.string().trim().min(1).max(120).optional(),
  messages: z.array(scriptConversationMessage).max(80).default([]),
}).strict()
const scriptGenerationInput = z.object({
  model_id: z.string().min(1), idea: z.string().max(20000).optional(),
  // Optional compatibility override for older callers. The creator UI leaves
  // this unset so the text model can judge the runtime from story rhythm.
  target_duration: z.number().int().min(5).max(600).optional(),
  generation_options: scriptGenerationOptions.default({}),
  prompt_override: z.string().trim().min(1).max(500000).optional(),
  reference_documents: referenceDocuments.optional(),
})
const scriptDirectorChatInput = z.object({
  model_id: z.string().min(1),
  mode: z.enum(['all', 'script', 'director']),
  focus_artifact: z.enum(['all', 'character', 'location', 'prop']).default('all'),
  generation_options: scriptGenerationOptions.default({}),
  workflow: workflowRequest.optional(),
  intent_context: z.object({ pending_draft: workflowRequest.optional(), selected_episode: z.number().int().min(1).max(200).optional() }).strict().optional(),
  adopt_source: z.object({ text: z.string().trim().min(1).max(20000), episode_number: z.number().int().min(1).max(200) }).strict().optional(),
  question_response: z.object({ status: z.literal('skipped'), question: z.string().trim().min(1).max(1000) }).strict().optional(),
  messages: z.array(z.object({
    role: z.enum(['assistant', 'user']), text: z.string().trim().min(1).max(8000),
    reference_documents: referenceDocuments.optional(),
  }).strict()).min(1).max(32),
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(JSON.stringify(value.messages.map(message => message.reference_documents || [])), 'utf8') > 610000) {
    context.addIssue({ code: 'custom', message: '本轮引用文档总量不能超过 600 KB', path: ['messages'] })
  }
  if (value.messages.some(message => message.role !== 'user' && message.reference_documents?.length)) {
    context.addIssue({ code: 'custom', message: '只有创作者消息可以引用文档', path: ['messages'] })
  }
  if ((value.workflow || value.adopt_source) && value.focus_artifact !== 'all') {
    context.addIssue({ code: 'custom', message: '阶段创作不能用于视觉资产对话', path: ['workflow'] })
  }
  if (value.question_response && (value.workflow || value.adopt_source || value.focus_artifact !== 'all')) {
    context.addIssue({ code: 'custom', message: '跳过问题只能继续剧本讨论，不能同时生成或采用文档', path: ['question_response'] })
  }
  if (value.messages.at(-1)?.role !== 'user') {
    context.addIssue({ code: 'custom', message: '最后一条对话必须是创作者消息', path: ['messages'] })
  }
  // Match web/src/director-chat-context.ts. The former 40 KB cap rejected
  // ordinary Chinese conversations well before their 32-message limit.
  if (value.messages.reduce((total, message) => total + Buffer.byteLength(message.text, 'utf8'), 0) > 256_000) {
    context.addIssue({ code: 'custom', message: '本轮对话上下文超过 256 KB，请减少历史消息', path: ['messages'] })
  }
})
const scriptGenerationPromptInput = scriptGenerationInput.omit({ model_id: true, prompt_override: true, reference_documents: true })
const scriptDraftArtifact = z.object({
  artifact_type: scriptArtifactType,
  title: z.string().trim().max(160).optional(),
  content: z.string().max(100000),
})
const scriptDraft = z.object({
  outline: z.string().max(20000), characters: z.string().max(20000),
  scenes: z.array(scriptSceneFields.extend({ duration: z.number().int().min(1).max(30) })).min(1).max(100),
  artifacts: z.array(scriptDraftArtifact).max(20).optional(),
})
const scriptCommitInput = scriptInput.extend({ artifacts: z.array(scriptArtifactInput).max(40).default([]) }).strict()
const workflowCommitInput = workflowDraftInput.safeExtend({
  brief: z.string().trim().min(1).max(20000).optional(),
  generation_options: scriptGenerationOptions.optional(),
}).transform(normalizeWorkflowRequest)
const sceneConversionInput = z.object({ scene_ids: z.array(z.string().min(1)).min(1).max(100) })
const shotPlanningInput = z.object({
  model_id: z.string().min(1), scene_ids: z.array(z.string().min(1)).min(1).max(10),
  shots_per_scene: z.number().int().min(2).max(5).default(3),
  prompt_override: z.string().trim().min(1).max(500000).optional(),
})
const shotPlanningPromptInput = shotPlanningInput.omit({ model_id: true, prompt_override: true })
const plannedShot = z.object({
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(10000),
  duration: z.number().int().min(1).max(30),
  start_state: z.string().max(2000).default(''),
  end_state: z.string().max(2000).default(''),
  cut_note: z.string().max(2000).default(''),
})
const shotPlanDraft = z.object({
  scenes: z.array(z.object({ scene_id: z.string().min(1), shots: z.array(plannedShot).min(1).max(5) })).min(1).max(10),
})
const createPlannedShotsInput = shotPlanDraft.extend({ request_id: z.uuid() })
const modelCatalogInput = z.object({
  path: z.string().trim().min(1).max(1024).default('models'),
  list_path: z.string().trim().max(200).default('data'),
  id_path: z.string().trim().min(1).max(200).default('id'),
  name_path: z.string().trim().min(1).max(200).default('id'),
  modality_path: z.string().trim().max(200).default(''),
}).strict()
const providerInput = z.object({
  name: z.string().trim().min(1).max(120), adapter: z.literal('http').default('http'),
  base_url: z.string().min(1), auth_header: z.string().min(1).default('Authorization'),
  auth_prefix: z.string().default('Bearer '), api_key: z.string().nullable().optional(),
  enabled: z.boolean().default(true), model_catalog: modelCatalogInput.default({
    path: 'models', list_path: 'data', id_path: 'id', name_path: 'id', modality_path: '',
  }),
})
const providerPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(), adapter: z.literal('http').optional(),
  base_url: z.string().min(1).optional(), auth_header: z.string().min(1).optional(),
  auth_prefix: z.string().optional(), api_key: z.string().nullable().optional(),
  enabled: z.boolean().optional(), model_catalog: modelCatalogInput.optional(),
})
const modality = z.enum(['text', 'image', 'video'])
const protocol = z.enum(['responses', 'chat_completions', 'image_generations', 'async_video'])
const modelInput = z.object({
  provider_id: z.string().min(1), name: z.string().trim().min(1).max(120),
  remote_id: z.string().trim().min(1), modality, protocol,
  settings: z.record(z.string(), z.unknown()).default({}), enabled: z.boolean().default(true),
})
const modelPatch = z.object({
  provider_id: z.string().min(1).optional(), name: z.string().trim().min(1).max(120).optional(),
  remote_id: z.string().trim().min(1).optional(), modality: modality.optional(), protocol: protocol.optional(),
  settings: z.record(z.string(), z.unknown()).optional(), enabled: z.boolean().optional(),
})
const modelCatalogImport = z.object({
  models: z.array(z.object({
    remote_id: z.string().trim().min(1),
    name: z.string().trim().min(1).max(120).optional(),
    modality, protocol,
    settings: z.record(z.string(), z.unknown()).default({}),
    enabled: z.boolean().default(false),
  })).min(1).max(100),
})
const generationInput = z.object({
  // Image assets created from the script director are project-level and do
  // not belong to a shot yet. Video generation still requires a shot in the
  // route below; keeping the field nullable lets both flows use the same
  // provider-neutral queue and worker.
  shot_id: z.string().min(1).nullable().optional(), model_id: z.string().min(1), prompt: z.string().trim().min(1),
  mode: z.enum(['text', 'first_frame', 'first_last_frame', 'reference', 'edit', 'extend']).default('text'),
  reference_asset_ids: z.array(z.string()).max(10).default([]),
  reference_video_url: z.string().nullable().optional(), resolution: z.string().nullable().optional(),
  // Optional image-generation controls are kept provider-neutral. Providers
  // can map them through request_template variables without coupling the
  // server to a specific image API's enum values.
  quality: z.string().trim().max(80).nullable().optional(),
  clarity: z.string().trim().max(80).nullable().optional(),
  background: z.string().trim().max(80).nullable().optional(),
  duration: z.number().int().min(1).max(120).default(5), ratio: z.string().default('16:9'),
  generate_audio: z.boolean().default(true), draft: z.boolean().default(false),
  source_artifact_type: z.enum(['character', 'location', 'prop']).nullable().optional(),
})
const canvasId = z.string().min(1).max(100)
type CanvasTextMark = { type: 'bold' | 'italic' }
type CanvasTextInline = { type: 'text'; text: string; marks?: CanvasTextMark[] } | { type: 'hardBreak'; marks?: CanvasTextMark[] }
type CanvasTextBlock =
  | { type: 'paragraph'; content?: CanvasTextInline[] }
  | { type: 'heading'; attrs: { level: 1 | 2 | 3 }; content?: CanvasTextInline[] }
  | { type: 'bulletList'; content: CanvasTextListItem[] }
  | { type: 'orderedList'; attrs?: { start?: number }; content: CanvasTextListItem[] }
  | { type: 'horizontalRule' }
type CanvasTextListItem = { type: 'listItem'; content: CanvasTextBlock[] }
const canvasTextMark = z.object({ type: z.enum(['bold', 'italic']) }).strict()
const canvasTextMarks = z.array(canvasTextMark).max(2).refine(marks => new Set(marks.map(mark => mark.type)).size === marks.length,
  '文本格式不可重复')
const canvasTextInline: z.ZodType<CanvasTextInline> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(20_000),
    marks: canvasTextMarks.optional() }).strict(),
  z.object({ type: z.literal('hardBreak'), marks: canvasTextMarks.optional() }).strict(),
])
const canvasTextBlock: z.ZodType<CanvasTextBlock> = z.lazy(() => z.discriminatedUnion('type', [
  z.object({ type: z.literal('paragraph'), content: z.array(canvasTextInline).optional() }).strict(),
  z.object({ type: z.literal('heading'), attrs: z.object({ level: z.union([z.literal(1), z.literal(2), z.literal(3)]) }).strict(),
    content: z.array(canvasTextInline).optional() }).strict(),
  z.object({ type: z.literal('bulletList'), content: z.array(canvasTextListItem).min(1) }).strict(),
  z.object({ type: z.literal('orderedList'), attrs: z.object({ start: z.number().int().positive().max(1_000_000).optional() }).strict().optional(),
    content: z.array(canvasTextListItem).min(1) }).strict(),
  z.object({ type: z.literal('horizontalRule') }).strict(),
]))
const canvasTextListItem: z.ZodType<CanvasTextListItem> = z.lazy(() => z.object({
  type: z.literal('listItem'), content: z.array(canvasTextBlock).min(1),
}).strict().refine(item => item.content[0]?.type === 'paragraph', '列表项必须以段落开始'))
// Bound the document before recursive parsing, so a deeply nested payload
// cannot exhaust the parser's call stack. Only the safe JSON document is
// persisted; arbitrary HTML, attributes and node/mark types are rejected.
const canvasTextDocument = z.unknown().superRefine((value, context) => {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }]
  let nodes = 0
  let textLength = 0
  while (pending.length) {
    const entry = pending.pop()!
    if (++nodes > 2_000 || entry.depth > 16) {
      context.addIssue({ code: 'custom', message: '富文本节点不能超过 2,000 个，嵌套不能超过 16 层' })
      return
    }
    if (!entry.value || typeof entry.value !== 'object' || Array.isArray(entry.value)) continue
    const node = entry.value as Record<string, unknown>
    if (typeof node.text === 'string') textLength += node.text.length
    if (textLength > 20_000) {
      context.addIssue({ code: 'custom', message: '富文本内容不能超过 20,000 字符' })
      return
    }
    if (Array.isArray(node.content)) {
      if (node.content.length + nodes + pending.length > 2_000) {
        context.addIssue({ code: 'custom', message: '富文本节点不能超过 2,000 个' })
        return
      }
      for (const child of node.content) pending.push({ value: child, depth: entry.depth + 1 })
    }
  }
}).pipe(z.object({ type: z.literal('doc'), content: z.array(canvasTextBlock).optional() }).strict())
  .superRefine((value, context) => {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 256_000) {
    context.addIssue({ code: 'custom', message: '富文本文档不能超过 256 KB' })
  }
})
const canvasSettings = z.object({
  role: z.enum(['script']).optional(),
  text_mode: z.enum(['choose', 'write', 'video']).optional(),
  text_document: canvasTextDocument.nullable().optional(),
  group_id: z.string().max(100).nullable().optional(),
  group_title: z.string().max(160).nullable().optional(),
  modality: z.enum(['text', 'image', 'video']).optional(),
  prompt_override: z.boolean().optional(),
  mode: z.enum(['text', 'first_frame', 'first_last_frame', 'reference', 'edit', 'extend']).optional(),
  resolution: z.string().max(100).nullable().optional(),
  // Image generation controls are persisted on the canvas node so reopening
  // a project keeps the exact composer choices. They are provider-neutral and
  // mapped by the configured model template at submission time.
  quality: z.string().max(80).nullable().optional(),
  clarity: z.string().max(80).nullable().optional(),
  background: z.string().max(80).nullable().optional(),
  duration: z.number().int().min(1).max(120).optional(),
  ratio: z.string().max(20).optional(),
  generate_audio: z.boolean().optional(),
  candidate_count: z.number().int().min(1).max(4).optional(),
  draft: z.boolean().optional(),
  reference_video_url: z.string().max(2048).nullable().optional(),
}).strict()
const canvasNodeInput = z.object({
  id: canvasId, type: z.enum(['text', 'image', 'video', 'generation', 'project_script_ref']),
  x: z.number().finite().min(-1_000_000).max(1_000_000),
  y: z.number().finite().min(-1_000_000).max(1_000_000),
  width: z.number().finite().min(1).max(5_000),
  height: z.number().finite().min(1).max(5_000),
  title: z.string().max(160).default(''), text: z.string().max(20_000).default(''),
  asset_id: canvasId.nullable().default(null), shot_id: canvasId.nullable().default(null),
  model_id: canvasId.nullable().default(null), job_id: canvasId.nullable().default(null),
  prompt: z.string().max(20_000).default(''), settings: canvasSettings.default({}),
}).strict()
const canvasEdgeInput = z.object({ id: canvasId, source: canvasId, target: canvasId }).strict()
const canvasInput = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  nodes: z.array(canvasNodeInput).max(500), edges: z.array(canvasEdgeInput).max(1_000),
}).strict()
const timelineClipPatch = z.object({
  in_ms: z.number().int().min(0).optional(),
  out_ms: z.number().int().min(1).optional(),
  source_audio_gain: z.number().finite().min(0).max(2).optional(),
  source_audio_fade_ms: z.number().int().min(0).max(500).optional(),
}).strict().refine(data => Object.values(data).some(value => value !== undefined), '请提供片段设置')
const retryJobInput = z.object({ prompt: z.string().trim().min(1).max(20_000).optional() }).strict()
const frameQuery = z.object({ time_ms: z.coerce.number().int().min(0) })
const frameExtractionInput = z.object({
  frames: z.array(z.enum(['first', 'last'])).min(1).max(2),
}).strict().refine(data => new Set(data.frames).size === data.frames.length, {
  message: '首尾帧不能重复', path: ['frames'],
})
const assetReviewParams = z.object({ id: z.string().min(1), assetId: z.string().min(1) })
const assetReviewInput = z.object({
  status: z.enum(['pending', 'approved', 'rejected']),
  note: z.string().trim().max(2000),
}).strict()
const assetTaskFocus = z.enum(['character', 'location', 'prop'])
const assetTaskCreateInput = z.object({
  focus_artifact: assetTaskFocus,
  source_artifact_ids: z.array(z.string().min(1)).max(20).default([]),
  source_scene_ids: z.array(z.string().min(1)).max(100).default([]),
  prompt: z.string().trim().max(20_000).default(''),
}).strict()
const assetTaskPatchInput = z.object({
  prompt: z.string().trim().max(20_000).optional(),
  source_artifact_ids: z.array(z.string().min(1)).max(20).optional(),
  source_scene_ids: z.array(z.string().min(1)).max(100).optional(),
}).strict()
const assetTaskGenerateInput = z.object({
  model_id: z.string().min(1), prompt: z.string().trim().min(1).max(20_000).optional(),
  mode: z.enum(['text', 'reference']).default('text'),
  reference_asset_ids: z.array(z.string().min(1)).max(10).default([]),
  resolution: z.string().trim().max(80).nullable().optional(),
  quality: z.string().trim().max(80).nullable().optional(),
  clarity: z.string().trim().max(80).nullable().optional(),
  background: z.string().trim().max(80).nullable().optional(),
  ratio: z.string().trim().max(20).default('16:9'),
}).strict()
const cutReviewInput = z.object({
  from_shot_id: z.string().min(1), to_shot_id: z.string().min(1),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['pending', 'approved', 'needs_work']),
  note: z.string().trim().max(2000),
}).strict().refine(data => data.status !== 'needs_work' || data.note.length > 0,
  { message: '请填写接镜需要修改的具体问题', path: ['note'] })
const cutPointsInput = z.object({
  from_shot_id: z.string().min(1), to_shot_id: z.string().min(1),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
  from_out_ms: z.number().int().min(1), to_in_ms: z.number().int().min(0),
}).strict()

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw Object.assign(new Error(z.prettifyError(result.error)), { statusCode: 422 })
  return result.data
}

function invalid(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 422 })
}

function providerPublic(provider: Provider) {
  const { key_ciphertext, created_at, archived, model_catalog, ...publicFields } = provider
  return {
    ...publicFields, model_catalog: modelCatalogInput.parse(JSON.parse(model_catalog)),
    enabled: Boolean(provider.enabled), has_key: Boolean(key_ciphertext),
  }
}

function modelPublic(model: Model) {
  const { archived, ...publicFields } = model
  return { ...publicFields, settings: JSON.parse(model.settings) as Record<string, unknown>, enabled: Boolean(model.enabled) }
}

function assetPublic(asset: Asset) {
  const { path, remote_url, ...publicFields } = asset
  return {
    ...publicFields,
    saved: Boolean(one('SELECT 1 FROM saved_assets WHERE asset_id=?', asset.id)),
    remote_url: null, url: `/api/assets/${asset.id}/file`,
    ...(asset.kind === 'text' ? { text: existsSync(path) ? readFileSync(path, 'utf8') : '' } : {}),
  }
}

function jobPublic(job: Job) {
  return { ...job, recovery_available: Boolean(one('SELECT 1 FROM job_image_recovery WHERE job_id=?', job.id)) }
}

function jsonIds(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch { return [] }
}

function assetTaskPublic(task: AssetTask) {
  return {
    ...task,
    source_artifact_ids: jsonIds(task.source_artifact_ids),
    source_scene_ids: jsonIds(task.source_scene_ids),
    result_asset: task.result_asset_id
      ? (() => { const asset = one<Asset>('SELECT * FROM assets WHERE id=?', task.result_asset_id); return asset ? assetPublic(asset) : null })()
      : null,
    generation_job: task.generation_job_id
      ? (() => { const job = one<Job>('SELECT * FROM jobs WHERE id=?', task.generation_job_id); return job ? jobPublic(job) : null })()
      : null,
    events: all<AssetTaskEvent>('SELECT * FROM asset_task_events WHERE task_id=? ORDER BY created_at, id', task.id),
  }
}

function addAssetTaskEvent(taskId: string, stage: string, message: string): void {
  run('INSERT INTO asset_task_events (id, task_id, stage, message, created_at) VALUES (?, ?, ?, ?, ?)',
    newId(), taskId, stage, message, now())
}

function setAssetTaskStatus(taskId: string, status: AssetTask['status'], error: string | null = null): void {
  run('UPDATE asset_tasks SET status=?, error=?, updated_at=? WHERE id=?', status, error, now(), taskId)
}

function assetTaskIdFromJob(job: Job): string | null {
  try {
    const request = JSON.parse(job.request) as Record<string, unknown>
    return typeof request.asset_task_id === 'string' ? request.asset_task_id : null
  } catch { return null }
}

function touchProject(id: string): void {
  run('UPDATE projects SET updated_at=? WHERE id=?', now(), id)
}

function projectCanvas(projectId: string) {
  const nodes = all<CanvasNode>('SELECT * FROM canvas_nodes WHERE project_id=? ORDER BY position', projectId)
    .map(({ project_id, position, settings, ...node }) => ({ ...node, settings: JSON.parse(settings) as z.infer<typeof canvasSettings> }))
  const edges = all<CanvasEdge>('SELECT * FROM canvas_edges WHERE project_id=? ORDER BY position', projectId)
    .map(({ project_id, position, ...edge }) => edge)
  return { nodes, edges, revision: createHash('sha256').update(JSON.stringify({ nodes, edges })).digest('hex') }
}

function projectClips(projectId: string): TimelineClip[] {
  return all<TimelineClip>(`SELECT timeline_clips.* FROM timeline_clips
    JOIN shots ON shots.id=timeline_clips.shot_id
    WHERE timeline_clips.project_id=? ORDER BY shots.position`, projectId)
}

interface ProductionRange { start_shot_id: string | null; end_shot_id: string | null }

function projectProductionRange(projectId: string): ProductionRange {
  return one<ProductionRange>('SELECT start_shot_id, end_shot_id FROM production_ranges WHERE project_id=?', projectId) ??
    { start_shot_id: null, end_shot_id: null }
}

function selectedProductionShots(shots: Shot[], range: ProductionRange): Shot[] {
  if (!shots.length && range.start_shot_id === null && range.end_shot_id === null) return []
  const start = range.start_shot_id === null ? 0 : shots.findIndex(shot => shot.id === range.start_shot_id)
  const end = range.end_shot_id === null ? shots.length - 1 : shots.findIndex(shot => shot.id === range.end_shot_id)
  if (start < 0 || end < 0) invalid('制作范围引用的镜头不存在，请重新选择范围')
  if (start > end) invalid('制作范围的起始镜头不能晚于结束镜头')
  return shots.slice(start, end + 1)
}

interface CutSide {
  shot_id: string
  title: string
  asset_id: string | null
  asset_kind: Asset['kind'] | null
  clip_id: string | null
  clip_asset_id: string | null
  in_ms: number | null
  out_ms: number | null
  frame_url: string | null
}

interface CutSnapshot {
  from_selected_asset_id: string | null
  to_selected_asset_id: string | null
  from_clip_id: string | null
  to_clip_id: string | null
  from_clip_asset_id: string | null
  to_clip_asset_id: string | null
  from_in_ms: number | null
  from_out_ms: number | null
  to_in_ms: number | null
  to_out_ms: number | null
}

interface CutReviewView {
  from_shot_id: string
  to_shot_id: string
  from: CutSide
  to: CutSide
  status: CutReview['status']
  saved_status: CutReview['status'] | null
  note: string
  stale: boolean
  signature: string
  reviewed_at: string | null
  ready: boolean
}

function cutSide(shot: Shot, clip: TimelineClip | undefined, assetsById: Map<string, Asset>, tail: boolean): CutSide {
  const asset = shot.selected_asset_id ? assetsById.get(shot.selected_asset_id) : undefined
  let frameUrl: string | null = null
  if (asset && clip && clip.asset_id === asset.id && existsSync(asset.path)) {
    try {
      validateClipRange(clip, asset)
      frameUrl = asset.kind === 'image' ? `/api/assets/${asset.id}/file` :
        `/api/assets/${asset.id}/frame?time_ms=${tail ? Math.max(clip.in_ms, clip.out_ms - 50) : clip.in_ms}`
    } catch { /* A broken clip cannot be approved until it is corrected. */ }
  }
  return {
    shot_id: shot.id, title: shot.title, asset_id: shot.selected_asset_id,
    asset_kind: asset?.kind ?? null, clip_id: clip?.id ?? null,
    clip_asset_id: clip?.asset_id ?? null, in_ms: clip?.in_ms ?? null,
    out_ms: clip?.out_ms ?? null, frame_url: frameUrl,
  }
}

function cutSnapshot(from: Shot, to: Shot, clipsByShot: Map<string, TimelineClip>): CutSnapshot {
  const fromClip = clipsByShot.get(from.id)
  const toClip = clipsByShot.get(to.id)
  return {
    from_selected_asset_id: from.selected_asset_id,
    to_selected_asset_id: to.selected_asset_id,
    from_clip_id: fromClip?.id ?? null, to_clip_id: toClip?.id ?? null,
    from_clip_asset_id: fromClip?.asset_id ?? null, to_clip_asset_id: toClip?.asset_id ?? null,
    from_in_ms: fromClip?.in_ms ?? null, from_out_ms: fromClip?.out_ms ?? null,
    to_in_ms: toClip?.in_ms ?? null, to_out_ms: toClip?.out_ms ?? null,
  }
}

function projectCutReviews(projectId: string): { production_range: ProductionRange; cuts: CutReviewView[] } {
  const range = projectProductionRange(projectId)
  const shots = selectedProductionShots(all<Shot>('SELECT * FROM shots WHERE project_id=? ORDER BY position', projectId), range)
  const clipsByShot = new Map(projectClips(projectId).map(clip => [clip.shot_id, clip]))
  const assetsById = new Map(all<Asset>('SELECT * FROM assets WHERE project_id=?', projectId).map(asset => [asset.id, asset]))
  const reviewsByPair = new Map(all<CutReview>('SELECT * FROM cut_reviews WHERE project_id=?', projectId)
    .map(review => [`${review.from_shot_id}:${review.to_shot_id}`, review]))
  const cuts: CutReviewView[] = []
  for (let index = 1; index < shots.length; index += 1) {
    const fromShot = shots[index - 1]!
    const toShot = shots[index]!
    const from = cutSide(fromShot, clipsByShot.get(fromShot.id), assetsById, true)
    const to = cutSide(toShot, clipsByShot.get(toShot.id), assetsById, false)
    const signature = createHash('sha256').update(JSON.stringify({
      version: 1, from_shot_id: fromShot.id, to_shot_id: toShot.id,
      ...cutSnapshot(fromShot, toShot, clipsByShot),
    })).digest('hex')
    const review = reviewsByPair.get(`${fromShot.id}:${toShot.id}`)
    const stale = Boolean(review && review.signature !== signature)
    cuts.push({
      from_shot_id: fromShot.id, to_shot_id: toShot.id, from, to,
      status: stale ? 'pending' : review?.status ?? 'pending',
      saved_status: review?.status ?? null, note: review?.note ?? '',
      stale, signature, reviewed_at: review?.updated_at ?? null,
      ready: Boolean(from.frame_url && to.frame_url),
    })
  }
  return { production_range: range, cuts }
}

type ContinuitySeverity = 'error' | 'warning'

interface ContinuityIssue {
  code: string
  severity: ContinuitySeverity
  message: string
  shot_id?: string
  related_shot_id?: string
  field?: string
  category?: string
  previous_value?: string
  current_value?: string
}

function continuityIssue(issue: Omit<ContinuityIssue, 'severity'> & { severity?: ContinuitySeverity }): ContinuityIssue {
  return { severity: issue.severity ?? 'warning', ...issue }
}

function semanticContinuityContext(projectId: string) {
  const range = projectProductionRange(projectId)
  const shots = selectedProductionShots(all<Shot>('SELECT * FROM shots WHERE project_id=? ORDER BY position', projectId), range)
  const script = projectScript(projectId)
  const scenes = new Map(script.scenes.map(scene => [scene.id, scene]))
  const side = (shot: Shot) => ({ id: shot.id, title: shot.title, prompt: shot.prompt,
    start_state: shot.start_state, end_state: shot.end_state, cut_note: shot.cut_note,
    scene: scenes.get(shot.source_scene_id || '') || null })
  const pairs = shots.slice(1).map((current, index) => ({ previous: side(shots[index]!), current: side(current) }))
  const context = { range, pairs, characters: script.characters,
    documents: (script.artifacts || []).filter(item => ['characters', 'relationships', 'locations', 'props'].includes(item.artifact_type))
      .map(item => ({ type: item.artifact_type, content: item.content })) }
  const signature = createHash('sha256').update(JSON.stringify(context)).digest('hex')
  return { context, signature }
}

interface ContinuityShotReport {
  shot_id: string
  title: string
  position: number
  expected_duration_ms: number
  actual_duration_ms: number | null
  selected_asset_id: string | null
  timeline_clip_id: string | null
  review_status: AssetReview['status'] | null
  has_material: boolean
  material_ready: boolean
  issues: ContinuityIssue[]
}

function validateClipRange(clip: TimelineClip, asset: Asset): void {
  if (asset.project_id !== clip.project_id || (asset.kind !== 'video' && asset.kind !== 'image')) invalid('时间线素材无效')
  if (!Number.isSafeInteger(clip.in_ms) || !Number.isSafeInteger(clip.out_ms) ||
    clip.in_ms < 0 || clip.out_ms - clip.in_ms < 200) invalid('片段时长至少为 0.2 秒，且出点必须晚于入点')
  if (asset.kind === 'image' && clip.in_ms !== 0) invalid('图片片段的入点必须为 0')
  if (asset.kind === 'video' && (clip.source_duration_ms === null || clip.out_ms > clip.source_duration_ms)) {
    invalid('片段超出视频素材时长，请重新选择素材')
  }
  if (!Number.isFinite(clip.source_audio_gain) || clip.source_audio_gain < 0 || clip.source_audio_gain > 2 ||
    !Number.isSafeInteger(clip.source_audio_fade_ms) || clip.source_audio_fade_ms < 0 || clip.source_audio_fade_ms > 500) {
    invalid('片段原声设置无效')
  }
}

interface ProjectScriptData {
  outline: string
  characters: string
  generation_options: z.infer<typeof scriptGenerationOptions>
  scenes: ScriptScene[]
  artifacts?: ScriptArtifact[]
}

function projectScript(projectId: string): ProjectScriptData {
  const details = one<{ outline: string; characters: string; generation_options: string }>(
    'SELECT outline, characters, generation_options FROM scripts WHERE project_id=?', projectId,
  )
  let generationOptions: z.infer<typeof scriptGenerationOptions> = {}
  try {
    const parsed = scriptGenerationOptions.safeParse(JSON.parse(details?.generation_options || '{}'))
    if (parsed.success) generationOptions = parsed.data
  } catch { /* Treat malformed or legacy settings as empty. */ }
  const scenes = all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position', projectId)
  const artifacts = all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=? ORDER BY position, updated_at', projectId)
  const base = {
    outline: details?.outline ?? '', characters: details?.characters ?? '',
    generation_options: generationOptions,
    scenes,
  }
  return artifacts.length ? { ...base, artifacts } : base
}

const defaultArtifactTitles: Record<ScriptArtifact['artifact_type'], string> = {
  outline: '故事大纲', synopsis: '故事简述', world: '背景设定', characters: '人物小传',
  relationships: '人物关系', locations: '场景设计', props: '道具设计', structure: '全剧分段',
  hooks: '钩子预设', foreshadowing: '伏笔预设', reversals: '反转预设', constraints: '创作禁区',
  episode_outline: '单集大纲', episode_script: '单集正文',
}

function scenePrompt(scene: ScriptScene): string {
  return [scene.heading, scene.location && `地点：${scene.location}`, scene.time_of_day && `时间：${scene.time_of_day}`,
    scene.characters && `人物：${scene.characters}`, scene.action && `画面与动作：${scene.action}`,
    scene.dialogue && `对白：${scene.dialogue}`, scene.narration && `旁白：${scene.narration}`].filter(Boolean).join('\n')
}

function scriptSettingLines(options: z.infer<typeof scriptGenerationOptions>): string[] {
  const entries: Array<[string, string | number | undefined]> = [
    ['题材', options.genre],
    ['题材融合', options.genre_fusion],
    ['目标受众', options.audience],
    ['时代背景', options.era],
    ['核心钩子', options.core_hook],
    ['视觉风格', options.visual_style],
    ['故事结构', options.story_structure],
    ['人物方向与角色关系', options.character_notes],
    ['剧本集数', options.episode_count],
    ['每集时长（秒）', options.episode_duration],
  ]
  return entries
    .flatMap(([label, value]) => {
      if (typeof value === 'number') return [`${label}：${value} ${label === '剧本集数' ? '集' : '秒'}`]
      if (typeof value === 'string' && value.trim()) return [`${label}：${value.trim()}`]
      return []
    })
}

function appendMissingScriptSettings(prompt: string, options: z.infer<typeof scriptGenerationOptions>): string {
  const missing = scriptSettingLines(options).filter(line => !prompt.includes(line))
  return missing.length ? `${prompt.trim()}\n\n创作设定：\n${missing.join('\n')}` : prompt
}

function buildScriptGenerationPrompt(project: Project, data: z.infer<typeof scriptGenerationPromptInput>): string {
  const settingLines = scriptSettingLines(data.generation_options)
  const settingsPrompt = settingLines.length ? `创作设定：\n${settingLines.join('\n')}\n` : ''
  const durationPrompt = data.target_duration
    ? `创作者给出了约 ${data.target_duration} 秒的时长目标，请在不破坏剧情节奏的前提下尽量接近；`
    : '没有预设总时长，请根据剧情信息量、动作复杂度、对白长度、情绪停顿和短视频观看节奏自主判断整体时长；'
  const existing = projectScript(project.id)
  const existingContext = [
    existing.outline && `现有故事大纲：${existing.outline.slice(0, 4500)}`,
    existing.characters && `现有人物设定：${existing.characters.slice(0, 4500)}`,
    existing.artifacts?.filter(artifact => artifact.content.trim() && !['episode_outline', 'episode_script'].includes(artifact.artifact_type))
      .slice(0, 12)
      .map(artifact => `${artifact.title}：${artifact.content.slice(0, 1200)}`).join('\n'),
    existing.scenes.length ? `现有场次：${JSON.stringify(existing.scenes.slice(-8).map(scene => ({ heading: scene.heading, location: scene.location, action: scene.action.slice(0, 800), dialogue: scene.dialogue.slice(0, 500), duration: scene.duration })))}` : '',
  ].filter(Boolean).join('\n')
  return `你是一位影视编剧。请根据以下创意写一份适合制作 AI 视频的分场剧本。\n` +
    `创意：${data.idea?.trim() || project.brief || project.name}\n` +
    `${durationPrompt}画幅：${project.ratio}。\n` +
    settingsPrompt +
    (existingContext ? `项目中已有资料（请保留已确认内容，只补充或修正当前讨论涉及的部分）：\n${existingContext}\n` : '') +
    `只返回一个合法 JSON 对象，不要 Markdown 或解释。除了基础场次，还要输出可单独确认的项目文档。结构必须为：` +
    `{"outline":"故事大纲","characters":"人物设定","scenes":[` +
    `{"heading":"场次标题","location":"地点","time_of_day":"日/夜等时间",` +
    `"characters":"本场人物","action":"画面与动作","dialogue":"对白，可留空",` +
    `"narration":"旁白，可留空","duration":场次秒数}],` +
    `"artifacts":[{"artifact_type":"synopsis|world|relationships|locations|props|structure|hooks|foreshadowing|reversals|constraints|episode_outline|episode_script","title":"文档标题","content":"可编辑的文档正文"}]}。` +
    `artifacts 至少返回 synopsis、world、relationships、locations、props、structure、hooks、foreshadowing、reversals、constraints；` +
    `如果是系列剧，再返回 episode_outline。outline 和 characters 仍作为顶层字段返回。` +
    `先分析故事节奏、动作复杂度、对白长度和情绪停顿，再给每场分配不同的 1 到 30 秒时长；不要机械均分。总时长以剧情完整和节奏自然为准。` +
    `每场写清楚可拍摄的视觉内容，人物与场景在各场保持一致。`
}

function buildScriptDirectorChatPrompt(project: Project, data: z.infer<typeof scriptDirectorChatInput>, task?: { brief?: string; sourceText?: string }): string {
  const script = projectScript(project.id)
  const episodeWorkflow = data.workflow?.stage === 'episode' ? data.workflow : undefined
  const projectWorkflow = Boolean(data.workflow && !episodeWorkflow)
  const generationOptions = { ...script.generation_options, ...data.generation_options }
  const modeGuidance = data.mode === 'all'
    ? '兼顾故事构思、角色塑造、分场剧本和可制作性；根据创作者当前问题选择最相关的方向。'
    : data.mode === 'director'
      ? '以导演视角讨论戏剧节奏、场面调度、镜头可视化、动作连续性和情绪表达。'
      : '以编剧视角讨论故事结构、人物动机、戏剧冲突、对白和分场节奏。'
  const focusLabels = { all: '全能创作', character: '角色视觉资产', location: '场景视觉资产', prop: '道具视觉资产' } as const
  const focusGuidance = data.focus_artifact === 'character'
    ? '当前聚焦角色视觉资产。优先读取人物小传和人物关系，整理身份、年龄、外貌、服装、动作习惯、情绪状态和画风，后续可用于生成角色图。'
    : data.focus_artifact === 'location'
      ? '当前聚焦场景视觉资产。优先读取场景设计和相关场次，整理空间结构、时间、天气、光线、色彩、机位和可重复的环境特征，后续可用于生成场景图。'
      : data.focus_artifact === 'prop'
        ? '当前聚焦道具视觉资产。优先读取道具设计、剧情线索和相关场次，整理形态、材质、年代、使用痕迹、关键细节和叙事作用，后续可用于生成道具图。'
        : '当前为全能创作，按创作者的问题选择最相关的剧本产物，并在进入生成前确认范围和制作方式。'
  const context = {
    ...(data.workflow ? { task_scope: data.workflow } : {}),
    project: { name: project.name, brief: project.brief.slice(0, 4000), ratio: project.ratio },
    script: {
      outline: script.outline.slice(0, 4000), characters: script.characters.slice(0, 4000),
      artifacts: (script.artifacts || [])
        .filter(artifact => (!projectWorkflow || !artifact.episode_number) && (!episodeWorkflow || !artifact.episode_number || artifact.episode_number === episodeWorkflow.episode_number || artifact.episode_number === episodeWorkflow.episode_number - 1))
        .slice(0, 16).map(artifact => ({ type: artifact.artifact_type, episode_number: artifact.episode_number, title: artifact.title, content: artifact.content.slice(0, data.workflow ? 20000 : 3000), status: artifact.status })),
      generation_options: generationOptions,
      ...(projectWorkflow ? { saved_episodes: (script.artifacts || []).filter(artifact => artifact.artifact_type === 'episode_script' && artifact.episode_number)
        .map(artifact => ({ episode_number: artifact.episode_number, title: artifact.title, summary: artifact.content.slice(0, 800) })) } : {}),
      recent_scenes: script.scenes.filter(scene => !episodeWorkflow || !scene.episode_number || scene.episode_number === episodeWorkflow.episode_number || scene.episode_number === episodeWorkflow.episode_number - 1).slice(-8).map(scene => ({
        episode_number: scene.episode_number,
        heading: scene.heading.slice(0, 200), location: scene.location.slice(0, 200),
        time_of_day: scene.time_of_day.slice(0, 100), characters: scene.characters.slice(0, 500),
        action: scene.action.slice(0, 1600), dialogue: scene.dialogue.slice(0, 800),
        narration: scene.narration.slice(0, 800), duration: scene.duration,
      })),
    },
  }
  const conversation = data.messages.map(message =>
    `${message.role === 'assistant' ? '导演' : '创作者'}：${message.text}`).join('\n')
  if (data.workflow) return `你是项目「${project.name}」的影视编剧。${modeGuidance}\n` +
    `项目中已确认的事实优先保持；根据最新创作者决定补充本轮文档。每条人物、地点和道具资料都应具体并服务于后续拍摄，避免泛泛而谈。\n` +
    `项目与剧本上下文：\n${JSON.stringify(context)}${referenceContext(data.messages)}\n本次创作要求：\n${task?.brief || data.messages.at(-1)!.text}\n${workflowInstructions(data.workflow)}` +
    (task?.sourceText ? `\n这是采用已有正文任务：不要重新创作或更改正文。只将以下原文拆成可制作的场次，保留人物、事件、对白和顺序；正文必须逐字保留。不要因制作片段预算缩短完整剧本。如果原文不是完整或部分剧本正文，不得虚构场次，返回空 scenes 表示无法采用。\n待采用正文：\n${task.sourceText}` : '')
  return `你是项目「${project.name}」的剧本导演，正在和创作者进行多轮剧本讨论。\n` +
    `当前创作模式：${data.mode}；当前任务：${focusLabels[data.focus_artifact]}。${modeGuidance}\n` +
    `${focusGuidance}\n` +
    `请结合项目与现有剧本上下文，接续最后一条创作者消息。先针对当前问题给出具体、有判断的回应；需要补充信息时一次只问一个关键问题。尊重对话中已确定的设定，发现冲突时指出冲突并提出修正建议。不要擅自声称已修改或保存项目数据；除非创作者明确要求，否则不要一次性重写整份剧本。\n` +
    `当你需要创作者从多个方向中明确选择时，必须只返回一个合法 JSON 对象，不加 Markdown 代码围栏或其他文字，格式为：` +
    `{"kind":"choices","question":"本轮唯一待回答的问题","intro":"对当前需求的具体回应与方向说明","options":[{"id":"稳定标识","title":"简短选择标题","text":"完整解释这个方向的故事核心、冲突和情绪效果"},{"id":"另一个标识","title":"另一个简短标题","text":"另一个方向的完整说明"}],"trailing":"推荐理由或选定后如何推进"}。` +
    `options 必须包含 2 到 8 个有意义且互不重复的选择，每项都要有唯一的简短 id、供底部选择按钮使用的 title（建议不超过30字）和供对话正文展示的完整 text。text 必须独立完整且包含方向标题，不能只返回标签；intro、text 和 trailing 应清楚说明创作建议及取舍，不要压缩成泛泛的选项列表。界面始终提供自由填写其他想法的入口，无需另加“我有别的想法”选项。一次只问一个关键问题。不要用字母、数字、项目符号等普通文本列表代替这个结构。普通讨论和解释继续直接用自然语言。\n` +
    `需要创作者填写具体设定而非从完整方案择一时，直接返回 {"kind":"input_request","question":"本轮要确定的事项","intro":"为什么需要确认这项","fields":[{"id":"稳定标识","label":"待填写事项","suggestions":["可选参考"]}],"trailing":"填写后如何推进"}。fields 为1到4个同一决策相关的必要字段。suggestions 可省略；提供参考时明确只是参考且允许自定义，不把人物身份例子编成互斥的完整组合。不要只在普通正文末尾追问而不给填写入口；不要重复询问已确定的信息。开放追问用 input_request，不强迫生成 choices。\n` +
    `已确认的上一轮选择与新问题必须区分。不要将数个开放追问和选择题塞进同一段；先用 choices 问当前最关键的一项。二选一、全部保留还是只保留部分等范围选择也必须使用 choices。如果某个原方案必须补充具体人选或范围，在该选项上增加 requires_details:true；创作者未明确授权时，不要替创作者决定未指定的人选。\n` +
    `创作者明确交给模型决定的事项，要结合已有故事和已确认约束作出具体选择或补齐设定，简短说明理由后继续推进，不保留待定、不再追问同项确认。后续沿用这一授权下作出的具体决定，除非创作者提出修改；未获授权的建议或未提交的输入不能当成已确认设定。授权决定一项设定不等于授权生成或保存整份文档。\n` +
    `项目默认集数、时长是暂定值，不能把创作者尚未确认的默认值称为已确认；需要建议时说明理由并允许修改。\n` +
    (data.question_response ? `本轮创作者点击了“跳过”，对应问题：${JSON.stringify(data.question_response.question)}。这是明确授权你决定该项，不是暂不确定。有备选方案时选定最合适的一项，需要具体信息时自行补齐完整设定；遵守已确认事实和创作约束。先明确说明你的具体决定及简短理由，再推进下一个必要的不同事项。不要把这项保留待定，不要重复询问这个问题或要求创作者再次确认；不要把未提交的选择或填写内容当成创作者的确认。这次操作只继续讨论，不自动生成或保存文档。\n` : '') +
    `项目与剧本上下文：\n${JSON.stringify(context)}\n` +
    `${referenceContext(data.messages)}对话记录：\n${conversation}\n` +
    `请直接给出导演的下一条回复。先确定故事方向，再推进大纲、人物、场景、道具和指定集正文。只追问尚未明确、未授权模型决定且会改变创作结果的信息；创作者已经给出集数、时长或选择，或模型已在授权下作出具体决定时，不要重复询问。`
}

type DirectorInput = z.infer<typeof scriptDirectorChatInput>

async function resolveDirectorIntent(project: Project, data: DirectorInput, model: Model, provider: Provider,
  signal?: AbortSignal): Promise<{ data: DirectorInput; brief?: string; sourceText?: string; reply?: string }> {
  // Delegating a question is an explicit discussion operation.
  if (data.question_response) return { data }
  if (data.adopt_source) {
    if (data.intent_context?.pending_draft) return { data, reply: '当前还有待确认草稿。请先保存或放弃它，再采用这段正文。' }
    return { data: { ...data, workflow: { stage: 'episode', scope: 'episode', episode_number: data.adopt_source.episode_number,
      target_duration: data.generation_options.episode_duration } }, sourceText: data.adopt_source.text,
      brief: '将创作者选中的既有正文整理为本集草稿，逐字保留正文，只整理分场。' }
  }
  // A button selection already supplies a typed operation; never reinterpret it as prose.
  if (data.workflow && data.intent_context?.pending_draft) return { data, reply: '当前还有待确认草稿。请先保存或放弃它，再开始新的文档创作。' }
  if (data.focus_artifact !== 'all') return { data }
  const script = projectScript(project.id)
  const prompt = scriptIntentPrompt({
    project: { name: project.name, brief: project.brief, ratio: project.ratio },
    saved_settings: script.generation_options, current_settings: data.generation_options,
    documents: (script.artifacts || []).map(item => ({ type: item.artifact_type,
      episode_number: item.episode_number, title: item.title, status: item.status, summary: item.content.slice(0, 800) })),
    state: data.workflow?.scope === 'project' ? { pending_draft: data.intent_context?.pending_draft } : data.intent_context || {}, mode: data.mode, explicit_workflow: data.workflow,
    messages: data.messages.map(({ role, text, reference_documents }, index) => ({ index, role, text,
      reference_documents: reference_documents?.map(({ content: _content, ...metadata }) => metadata) })),
  })
  const raw = await streamText(model, provider, { prompt }, item => decryptKey(item.key_ciphertext || null), () => {}, signal)
  const intent = parseScriptIntent(raw)
  const next = { ...data, generation_options: { ...script.generation_options, ...data.generation_options, ...intent.settings_patch } }
  if (intent.action === 'clarify') return { data: next, reply: intent.reply }
  if (intent.action === 'discuss') return { data: next }
  if (data.intent_context?.pending_draft) return { data: next, reply: '当前还有待确认草稿。请先保存或放弃它，再开始新的文档创作。' }
  let sourceText: string | undefined
  if (intent.operation === 'adopt') {
    if ((data.workflow || intent.workflow).stage !== 'episode') invalid('采用正文的目标必须是分集剧本，项目内容未修改')
    const source = data.messages[intent.source_message_index!]
    if (!source || source.role !== 'assistant') invalid('要采用的正文必须来自已有助手消息，项目内容未修改')
    sourceText = source.text
  }
  return { data: { ...next, workflow: { ...(data.workflow || intent.workflow),
    ...((data.workflow || intent.workflow).stage === 'episode' && !(data.workflow || intent.workflow).target_duration && next.generation_options.episode_duration
      ? { target_duration: next.generation_options.episode_duration } : {}) } }, brief: intent.creative_brief, sourceText }
}

function directorResult(raw: string, data: DirectorInput, sourceText?: string) {
  if (data.workflow) {
    const draft = parseWorkflowDraft(raw, data.workflow)
    if (!draft) throw Object.assign(new Error('模型未返回有效的阶段草稿，请重试；已有剧本未修改'), { statusCode: 422 })
    if (sourceText) draft.artifacts[0]!.content = sourceText
    return { reply: workflowReply(draft), draft }
  }
  const reply = normalizeScriptDirectorReply(raw)
  if (!reply) throw Object.assign(new Error('文本模型未返回对话内容'), { statusCode: 502 })
  return { reply }
}

function replyTextHash(text: string, context?: unknown) { return createHash('sha256').update(JSON.stringify([replyClassificationVersion, text.trim(), context ?? null])).digest('hex') }

function cachedReplyClassification(projectId: string, source: ReplySource) {
  for (const hash of [replyTextHash(source.text, source.following_messages || []), replyTextHash(source.text)]) {
    const cached = one<{ classification: string }>('SELECT classification FROM script_reply_classifications WHERE project_id=? AND message_id=? AND text_hash=?', projectId, source.id, hash)
    if (cached) { const parsed = replyClassification.safeParse(JSON.parse(cached.classification)); if (parsed.success) return parsed.data }
  }
  return null
}

function classifiedMessage(projectId: string, message: ScriptMessage, following_messages: ReplySource['following_messages']) {
  const decoded = { ...message, reference_documents: decodeReferenceDocuments(message.reference_documents) }
  if (message.role !== 'assistant') return decoded
  const classification = cachedReplyClassification(projectId, { ...message, following_messages })
  return classification ? { ...decoded, classification, classification_version: replyClassificationVersion,
    ...(['choice_request', 'input_request'].includes(classification.type) ? { classification_context: JSON.stringify(following_messages) } : {}) } : decoded
}

function normalizeScriptDirectorReply(raw: string): string {
  const trimmed = raw.trim()
  let value: unknown
  let start = 0
  let end = trimmed.length
  try { value = JSON.parse(trimmed) } catch { value = null }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const envelope = value as Record<string, unknown>
    if (envelope.kind === 'text' && typeof envelope.text === 'string' && envelope.text.trim()) return envelope.text.trim()
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['choices', 'input_request'].includes(String((value as Record<string, unknown>).kind))) {
    value = null
    for (let candidateStart = 0; candidateStart < trimmed.length; candidateStart++) {
      if (trimmed[candidateStart] !== '{') continue
      let depth = 0
      let inString = false
      let escaped = false
      for (let index = candidateStart; index < trimmed.length; index++) {
        const char = trimmed[index]!
        if (inString) {
          if (escaped) escaped = false
          else if (char === '\\') escaped = true
          else if (char === '"') inString = false
          continue
        }
        if (char === '"') inString = true
        else if (char === '{') depth++
        else if (char === '}' && --depth === 0) {
          try {
            const parsed: unknown = JSON.parse(trimmed.slice(candidateStart, index + 1))
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && ['choices', 'input_request'].includes(String((parsed as Record<string, unknown>).kind))) {
              value = parsed
              start = candidateStart
              end = index + 1
              break
            }
          } catch { /* Continue searching for a complete structured reply. */ }
          break
        }
      }
      if (value) break
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return trimmed
  const payload = value as Record<string, unknown>
  if (payload.kind === 'input_request') {
    const fields = inputFields.safeParse(payload.fields)
    if (!fields.success || typeof payload.question !== 'string' || !payload.question.trim()) return trimmed
    return JSON.stringify({ kind: 'input_request', question: payload.question.trim(), fields: fields.data,
      intro: [trimmed.slice(0, start).trim(), typeof payload.intro === 'string' ? payload.intro.trim() : ''].filter(Boolean).join('\n\n'),
      trailing: [typeof payload.trailing === 'string' ? payload.trailing.trim() : '', trimmed.slice(end).trim()].filter(Boolean).join('\n\n') })
  }
  if (payload.kind !== 'choices') return trimmed
  if (typeof payload.question !== 'string' || !payload.question.trim() || !Array.isArray(payload.options)) return trimmed
  const options = payload.options.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const option = entry as Record<string, unknown>
    if (typeof option.text !== 'string' || !option.text.trim()) return []
    const id = typeof option.id === 'string' && option.id.trim() ? option.id.trim() : String(index + 1)
    const title = typeof option.title === 'string' && option.title.trim() ? option.title.trim().slice(0, 80) : undefined
    return [{ id: id.slice(0, 80), ...(title ? { title } : {}), ...(option.kind === 'custom' ? { kind: 'custom' } : {}),
      ...(option.requires_details === true ? { requires_details: true } : {}), text: option.text.trim().slice(0, 1200) }]
  })
  if (options.length < 2 || options.length > 8 || new Set(options.map(option => option.id)).size !== options.length) return trimmed
  const intro = [trimmed.slice(0, start).trim(), typeof payload.intro === 'string' ? payload.intro.trim() : '']
    .filter(Boolean).join('\n\n')
  const trailing = [typeof payload.trailing === 'string' ? payload.trailing.trim() : '', trimmed.slice(end).trim()]
    .filter(Boolean).join('\n\n')
  const normalized = {
    kind: 'choices',
    question: payload.question.trim().slice(0, 400),
    ...(intro ? { intro: intro.slice(0, 2000) } : {}),
    options,
    ...(trailing ? { trailing: trailing.slice(0, 1200) } : {}),
  }
  return JSON.stringify(normalized)
}

function buildScriptArtifactPrompt(project: Project, data: z.infer<typeof scriptArtifactGenerationInput>): string {
  const script = projectScript(project.id)
  const label = defaultArtifactTitles[data.artifact_type]
  const context = JSON.stringify({
    project: { name: project.name, brief: project.brief, ratio: project.ratio },
    outline: script.outline, characters: script.characters,
    generation_options: script.generation_options,
    artifacts: (script.artifacts || []).map(artifact => ({ type: artifact.artifact_type, title: artifact.title, content: artifact.content.slice(0, 8000) })),
    scenes: script.scenes.slice(0, 40).map(scene => ({ heading: scene.heading, location: scene.location, characters: scene.characters, action: scene.action, dialogue: scene.dialogue, narration: scene.narration, duration: scene.duration })),
  })
  return data.prompt_override || `你是影视剧本导演，请为项目「${project.name}」编写“${label}”。\n` +
    `它必须服务于后续角色图、场景图、图片生成和视频分镜制作，写出明确、可执行、可编辑的内容。\n` +
    `如果已有同类型资料，请在保留已确认事实的基础上补充，不要与人物、时代、场景设定冲突。\n` +
    `项目上下文：${context}\n` +
    `只输出${label}正文，不要 Markdown 代码围栏，不要解释生成过程。内容要具体，避免泛泛而谈。`
}

function buildShotPlanningPrompt(project: Project, scenes: ScriptScene[], shotsPerScene: number): string {
  const script = projectScript(project.id)
  const existingShots = all<Shot>('SELECT * FROM shots WHERE project_id=? ORDER BY position', project.id)
  return `你是一位分镜导演。把所列场次拆成可直接用于 AI 图片和视频生成的连续镜头。\n` +
    `项目：${project.name}；画幅：${project.ratio}；创意：${project.brief}\n` +
    `故事大纲：${script.outline}\n人物设定与视觉连续性：${script.characters}\n` +
    `已确认的剧本产物：${(script.artifacts || []).filter(artifact => artifact.content.trim()).map(artifact => `${artifact.title}：${artifact.content.slice(0, 5000)}`).join('\n')}\n` +
    `每场建议 ${shotsPerScene} 个镜头；场次不足 ${shotsPerScene} 秒时，镜头数不能超过场次秒数。` +
    `同一场所有镜头的 duration 总和必须等于场次 duration。` +
    `先分析对白长度、动作节拍、情绪停顿和转场，再为每个镜头分配不同的入片秒数；快速动作应短，建立空间或情绪停顿可长，不要机械均分。` +
    `若场次已有镜头，请规划新的补充画面，避免重复已有镜头；新镜头会追加，原镜头和素材保留。` +
    `每个 prompt 要独立完整地描述主体、场景、景别、动作、运镜、光线与风格，保持人物、服装、道具和场景连贯。` +
    `每镜补充 start_state（开镜时人物位置、姿势、道具状态）、end_state（收镜时状态）、cut_note（本镜如何从前一镜接入及建议切点，整段第一镜可留空）；相邻镜头的状态应连续，禁止动作无因重置。` +
    `不要在画面中加入文字、字幕或水印。\n` +
    `只输出合法 JSON 对象，不要 Markdown 或说明。格式：` +
    `{"scenes":[{"scene_id":"原始场次 ID","shots":[{"title":"镜头标题","prompt":"完整画面提示词","duration":镜头秒数,"start_state":"开镜状态","end_state":"收镜状态","cut_note":"接镜方式"}]}]}。\n` +
    `待拆场次：${JSON.stringify(scenes.map(scene => ({
      id: scene.id, heading: scene.heading, location: scene.location, time_of_day: scene.time_of_day,
      characters: scene.characters, action: scene.action, dialogue: scene.dialogue,
      narration: scene.narration, duration: scene.duration,
      existing_shots: existingShots.filter(shot => shot.source_scene_id === scene.id)
        .map(shot => ({ title: shot.title, prompt: shot.prompt, duration: shot.duration })),
    })))}`
}

function insertScriptScene(projectId: string, position: number, scene: z.infer<typeof scriptSceneFields>): ScriptScene {
  const id = newId(), timestamp = now()
  run(`INSERT INTO script_scenes
    (id, project_id, position, heading, location, time_of_day, characters, action, dialogue, narration, duration, created_at, updated_at, episode_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, projectId, position, scene.heading, scene.location, scene.time_of_day, scene.characters,
    scene.action, scene.dialogue, scene.narration, scene.duration, timestamp, timestamp, scene.episode_number)
  return required<ScriptScene>('script_scenes', id)
}

function selectedScenes(projectId: string, ids: string[]): ScriptScene[] {
  if (new Set(ids).size !== ids.length) invalid('场次不能重复')
  const scenes = all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position', projectId)
    .filter(scene => ids.includes(scene.id))
  if (scenes.length !== ids.length) invalid('所选场次不属于当前项目')
  return scenes
}

function distributeShotDurations(shots: z.infer<typeof plannedShot>[], duration: number): number[] {
  if (shots.length > duration) invalid('镜头数量不能超过场次秒数')
  if (shots.reduce((sum, shot) => sum + shot.duration, 0) === duration) return shots.map(shot => shot.duration)
  const remaining = duration - shots.length
  const weights = shots.map(shot => Math.max(1, shot.duration))
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const shares = weights.map(weight => remaining * weight / totalWeight)
  const allocations = shares.map(share => Math.floor(share))
  let leftover = remaining - allocations.reduce((sum, value) => sum + value, 0)
  const order = shares.map((share, index) => ({ index, remainder: share - allocations[index]! }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
  for (const item of order) {
    if (!leftover) break
    allocations[item.index]! += 1
    leftover -= 1
  }
  return allocations.map(value => value + 1)
}

async function generateTextOutput(model: Model, provider: Provider, projectId: string, prompt: string): Promise<string> {
  let resultPath: string
  try {
    const result = await generate(model, provider, { prompt }, [], projectId, () => {},
      item => decryptKey(item.key_ciphertext || null))
    resultPath = result.path
  } catch (error) {
    throw Object.assign(new Error(`文本模型生成失败：${error instanceof Error ? error.message : String(error)}`), { statusCode: 502 })
  }
  try {
    return await readFile(resultPath, 'utf8')
  } finally {
    await rm(resultPath, { force: true })
  }
}

function checkBaseUrl(value: string): void {
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return
  } catch { /* Handled below. */ }
  invalid('厂商 Base URL 必须是 HTTP 或 HTTPS 地址')
}

function checkProtocol(mod: Model['modality'], kind: Model['protocol']): void {
  if ((mod === 'text' && ['responses', 'chat_completions'].includes(kind)) ||
    (mod === 'image' && kind === 'image_generations') ||
    (mod === 'video' && kind === 'async_video')) return
  invalid('模型类型与接口协议不匹配')
}

function validateSettings(mod: Model['modality'], settings: Record<string, unknown>): void {
  const keys = mod === 'video' ? ['create_path', 'get_path', 'request_template'] : ['request_path', 'request_template']
  for (const key of keys) if (settings[key] === undefined || settings[key] === null || settings[key] === '') invalid(`模型配置缺少 ${key}`)
  if (mod === 'video' && !String(settings.get_path).includes('{id}')) invalid('get_path 必须包含 {id}')
  if (mod === 'text' && !settings.text_path && !Array.isArray(settings.text_paths)) invalid('文本模型需配置 text_path 或 text_paths')
  if (mod === 'image' && !settings.image_base64_path && !settings.image_url_path) invalid('图片模型需配置 image_base64_path 或 image_url_path')
}

function validateGeneration(data: z.infer<typeof generationInput>, model: Model, projectId: string): Asset[] {
  const settings = JSON.parse(model.settings) as Record<string, unknown>
  const references = data.reference_asset_ids.map(id => required<Asset>('assets', id))
  if (references.some(asset => asset.project_id !== projectId || asset.kind !== 'image')) invalid('参考图片必须来自当前项目')
  if (new Set(data.reference_asset_ids).size !== data.reference_asset_ids.length) invalid('参考图片不能重复')
  if (model.modality === 'text' && data.mode !== 'text') invalid('文本模型只支持文本模式')
  if (model.modality === 'image' && !['text', 'reference'].includes(data.mode)) invalid('图片模型只支持文生图或图生图模式')
  if (model.modality === 'image' && data.mode === 'reference' && !references.length) invalid('图生图模式需要至少一张参考图片')
  if (model.modality === 'video') {
    const supportedModes = Array.isArray(settings.supported_modes) ? settings.supported_modes : ['text']
    if (!supportedModes.includes(data.mode)) invalid('该模型没有配置所选视频模式')
    if (data.mode === 'first_frame' && references.length !== 1) invalid('首帧模式需要一张参考图片')
    if (data.mode === 'first_last_frame' && references.length !== 2) invalid('首尾帧模式需要两张参考图片')
    if (['edit', 'extend'].includes(data.mode) && !data.reference_video_url) invalid('编辑或延长需要参考视频地址')
    if (data.mode === 'reference' && !references.length && !data.reference_video_url) invalid('参考生成需要图片或视频地址')
  }
  if (typeof settings.min_duration === 'number' && data.duration < settings.min_duration) invalid(`时长不能少于 ${settings.min_duration} 秒`)
  if (typeof settings.max_duration === 'number' && data.duration > settings.max_duration) invalid(`时长不能超过 ${settings.max_duration} 秒`)
  if (data.draft && settings.supports_draft !== true) invalid('该模型没有配置样片模式')
  if (Array.isArray(settings.resolutions) && data.resolution && !settings.resolutions.includes(data.resolution)) invalid('该模型不支持所选分辨率')
  if (Array.isArray(settings.ratios) && !settings.ratios.includes(data.ratio) && !['first_frame', 'first_last_frame', 'edit', 'extend'].includes(data.mode)) invalid('该模型不支持所选画幅')
  return references
}

const uploads: Record<string, Asset['kind']> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image',
  '.mp4': 'video', '.mov': 'video', '.mp3': 'audio', '.wav': 'audio', '.m4a': 'audio',
}
const mime: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.txt': 'text/plain',
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
}

function byteRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!match || (!match[1] && !match[2]) || size === 0) return null
  const first = match[1] ? Number(match[1]) : null
  const last = match[2] ? Number(match[2]) : null
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null
  if (first === null) {
    if (last === null || last === 0) return null
    return { start: Math.max(0, size - last), end: size - 1 }
  }
  if (first >= size || (last !== null && last < first)) return null
  return { start: first, end: Math.min(last ?? size - 1, size - 1) }
}

async function processJob(job: Job): Promise<void> {
  const request = JSON.parse(job.request) as Record<string, unknown>
  const assetTaskId = assetTaskIdFromJob(job)
  let path: string
  let kind: Asset['kind']
  let source: Asset['source']
  let remoteUrl: string | null = null
  if (job.job_type === 'export') {
    const project = request.project as Project
    const clips = request.clips as RenderClip[]
    const assets = all<Asset>('SELECT * FROM assets WHERE project_id=?', job.project_id)
    path = await render(project, clips, Object.fromEntries(assets.map(asset => [asset.id, asset])))
    kind = 'video'
    source = 'export'
  } else {
    const recovery = one<{ result_url_ciphertext: string }>('SELECT result_url_ciphertext FROM job_image_recovery WHERE job_id=?', job.id)
    let result
    if (recovery) {
      result = await recoverImage(job.project_id, decryptKey(recovery.result_url_ciphertext))
      kind = 'image'
    } else {
      const model = required<Model>('models', job.model_id!)
      const provider = required<Provider>('providers', model.provider_id)
      if (provider.adapter === 'demo' || provider.archived || model.archived || !provider.enabled || !model.enabled) throw new Error('模型或提供商已停用')
      const references = (request.reference_asset_ids as string[] || []).map(id => required<Asset>('assets', id))
      result = await generate(model, provider, { ...request, prompt: String(request.prompt), _external_id: job.external_id }, references, job.project_id,
        id => run('UPDATE jobs SET external_id=?, updated_at=? WHERE id=?', id, now(), job.id),
        item => decryptKey(item.key_ciphertext || null),
        url => run(`INSERT INTO job_image_recovery (job_id, result_url_ciphertext, created_at) VALUES (?, ?, ?)
          ON CONFLICT(job_id) DO UPDATE SET result_url_ciphertext=excluded.result_url_ciphertext`, job.id, encryptKey(url), now()))
      kind = model.modality
    }
    path = result.path
    remoteUrl = result.remoteUrl
    source = 'generated'
  }
  const assetId = newId()
  db.transaction(() => {
    run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, model_id, prompt, remote_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, assetId, job.project_id, job.shot_id, kind, basename(path), path, source, job.model_id, job.job_type === 'generation' ? String(request.prompt) : null, kind === 'image' ? null : remoteUrl, now())
    if (source === 'export') {
      run('INSERT OR IGNORE INTO saved_assets (asset_id, project_id, created_at) VALUES (?, ?, ?)', assetId, job.project_id, now())
    }
    run("UPDATE jobs SET status='succeeded', result_asset_id=?, error=NULL, updated_at=? WHERE id=?", assetId, now(), job.id)
    if (assetTaskId) {
      run('UPDATE asset_tasks SET status=?, result_asset_id=?, error=NULL, updated_at=? WHERE id=?', 'ready', assetId, now(), assetTaskId)
      addAssetTaskEvent(assetTaskId, 'asset_ready', '生成结果已回写；确认后可手动保存到资产库，再连接到画布')
    }
    run('DELETE FROM job_image_recovery WHERE job_id=?', job.id)
    touchProject(job.project_id)
  })()
}

export function startWorker(): () => void {
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  const next = async () => {
    if (stopped) return
    try {
      const job = one<Job>("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1")
      if (job) {
        run("UPDATE jobs SET status='running', updated_at=? WHERE id=?", now(), job.id)
        try { await processJob(job) }
        catch (error) {
          run("UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?", String(error instanceof Error ? error.message : error).slice(0, 2000), now(), job.id)
          const assetTaskId = assetTaskIdFromJob(job)
          if (assetTaskId) {
            const message = String(error instanceof Error ? error.message : error).slice(0, 2000)
            setAssetTaskStatus(assetTaskId, 'failed', message)
            addAssetTaskEvent(assetTaskId, 'failed', `生成失败：${message}`)
          }
        }
      }
    } catch (error) { console.error('任务处理失败', error) }
    if (!stopped) timer = setTimeout(next, 1000)
  }
  void next()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}

export function buildApp(): FastifyInstance {
  initDb()
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 })
  void app.register(multipart, { limits: { fileSize: 300 * 1024 * 1024, files: 1, fields: 2 } })
  app.setErrorHandler((error, _request, reply) => {
    const issue = error as Error & { statusCode?: number }
    const code = error instanceof ZodError ? 422 : Math.max(400, Math.min(Number(issue.statusCode) || 500, 599))
    reply.code(code).send({ detail: code === 500 ? '服务器处理失败' : issue.message })
    if (code === 500) console.error(error)
  })

  app.get('/api/health', async () => ({ ok: true }))
  app.get('/api/projects', async () => all<Project>('SELECT * FROM projects ORDER BY updated_at DESC'))
  app.post('/api/projects', async request => {
    const data = parse(projectInput, request.body)
    const id = newId(), timestamp = now()
    run('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?)', id, data.name, data.brief, data.ratio, null, timestamp, timestamp)
    return required<Project>('projects', id)
  })
  app.get('/api/projects/:id', async request => {
    const { id } = parse(idParams, request.params)
    const project = required<Project>('projects', id)
    return {
      ...project, production_range: projectProductionRange(id),
      script: projectScript(id), shots: all<Shot>('SELECT * FROM shots WHERE project_id=? ORDER BY position', id),
      timeline_clips: projectClips(id),
      asset_reviews: all<AssetReview>(`SELECT asset_reviews.* FROM asset_reviews
        JOIN shots ON shots.id=asset_reviews.shot_id WHERE shots.project_id=?`, id),
      assets: all<Asset>('SELECT * FROM assets WHERE project_id=? ORDER BY created_at DESC', id).map(assetPublic),
      jobs: all<Job>('SELECT * FROM jobs WHERE project_id=? ORDER BY created_at DESC', id).map(jobPublic),
      asset_tasks: all<AssetTask>('SELECT * FROM asset_tasks WHERE project_id=? ORDER BY updated_at DESC, rowid DESC', id).map(assetTaskPublic),
    }
  })
  app.get('/api/projects/:id/canvas', async request => {
    const { id } = parse(idParams, request.params)
    return db.transaction(() => {
      required<Project>('projects', id)
      return projectCanvas(id)
    })()
  })
  app.put('/api/projects/:id/canvas', async request => {
    const { id } = parse(idParams, request.params)
    const data = parse(canvasInput, request.body)
    return db.transaction(() => {
      required<Project>('projects', id)
      const current = projectCanvas(id)
      if (JSON.stringify({ nodes: current.nodes, edges: current.edges }) ===
          JSON.stringify({ nodes: data.nodes, edges: data.edges })) return current
      if (current.revision !== data.revision) {
        throw Object.assign(new Error('画布已在其他位置修改，请刷新后重试'), { statusCode: 409 })
      }
      const nodeIds = new Set<string>()
      for (const node of data.nodes) {
        if (nodeIds.has(node.id)) invalid('画布节点 ID 不能重复')
        nodeIds.add(node.id)
        if (node.asset_id) {
          const asset = one<Asset>('SELECT * FROM assets WHERE id=?', node.asset_id)
          if (!asset || asset.project_id !== id) invalid('画布素材不属于当前项目')
          if (node.type !== 'generation' && asset.kind !== node.type) invalid('画布节点类型与素材类型不匹配')
          if (node.type === 'generation' && asset.kind === 'audio') invalid('生成节点不能关联音频素材')
        }
        if (node.shot_id && one<Shot>('SELECT * FROM shots WHERE id=? AND project_id=?', node.shot_id, id) === undefined) {
          invalid('画布镜头不属于当前项目')
        }
        if (node.model_id && one<Model>('SELECT * FROM models WHERE id=?', node.model_id) === undefined) {
          invalid('画布模型不存在')
        }
        if (node.job_id) {
          const job = one<Job>('SELECT * FROM jobs WHERE id=?', node.job_id)
          if (!job || job.project_id !== id || job.job_type !== 'generation') invalid('画布任务必须是当前项目的生成任务')
          if (node.shot_id && job.shot_id !== node.shot_id) invalid('画布任务与镜头不匹配')
        }
      }
      const edgeIds = new Set<string>()
      const pairs = new Set<string>()
      for (const edge of data.edges) {
        if (edgeIds.has(edge.id)) invalid('画布连接 ID 不能重复')
        edgeIds.add(edge.id)
        if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) invalid('画布连接必须指向当前画布的节点')
        if (edge.source === edge.target) invalid('画布节点不能连接自身')
        const pair = JSON.stringify([edge.source, edge.target])
        if (pairs.has(pair)) invalid('画布节点之间不能重复连接')
        pairs.add(pair)
      }
      run('DELETE FROM canvas_edges WHERE project_id=?', id)
      run('DELETE FROM canvas_nodes WHERE project_id=?', id)
      data.nodes.forEach((node, position) => run(`INSERT INTO canvas_nodes
        (id, project_id, position, type, x, y, width, height, title, text, asset_id, shot_id, model_id, job_id, prompt, settings)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        node.id, id, position, node.type, node.x, node.y, node.width, node.height,
        node.title, node.text, node.asset_id, node.shot_id, node.model_id, node.job_id,
        node.prompt, JSON.stringify(node.settings)))
      data.edges.forEach((edge, position) => run(`INSERT INTO canvas_edges
        (id, project_id, position, source, target) VALUES (?, ?, ?, ?, ?)`,
        edge.id, id, position, edge.source, edge.target))
      touchProject(id)
      return projectCanvas(id)
    }).immediate()
  })
  app.get('/api/projects/:id/continuity', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    const range = projectProductionRange(id)
    const allShots = all<Shot>('SELECT * FROM shots WHERE project_id=? ORDER BY position', id)
    const shots = selectedProductionShots(allShots, range)
    const clips = all<TimelineClip>('SELECT * FROM timeline_clips WHERE project_id=?', id)
    const assets = all<Asset>('SELECT * FROM assets WHERE project_id=?', id)
    const reviews = all<AssetReview>(`SELECT asset_reviews.* FROM asset_reviews
      JOIN shots ON shots.id=asset_reviews.shot_id WHERE shots.project_id=?`, id)
    const clipsByShot = new Map(clips.map(clip => [clip.shot_id, clip]))
    const assetsById = new Map(assets.map(asset => [asset.id, asset]))
    const reviewsByAsset = new Map(reviews.map(review => [`${review.shot_id}:${review.asset_id}`, review]))
    const issues: ContinuityIssue[] = []
    const reports: ContinuityShotReport[] = []
    let expectedDurationMs = 0
    let actualDurationMs = 0

    for (const shot of shots) {
      const shotIssues: ContinuityIssue[] = []
      const clip = clipsByShot.get(shot.id)
      const selectedAssetId = shot.selected_asset_id
      const asset = selectedAssetId ? assetsById.get(selectedAssetId) : undefined
      const review = selectedAssetId ? reviewsByAsset.get(`${shot.id}:${selectedAssetId}`) : undefined
      const expectedShotDurationMs = shot.duration * 1000
      expectedDurationMs += expectedShotDurationMs
      let actualShotDurationMs: number | null = null
      let materialReady = true

      if (!selectedAssetId) {
        shotIssues.push(continuityIssue({ code: 'missing_material', severity: 'error', shot_id: shot.id, message: `分镜「${shot.title}」还没有选定入片素材` }))
        materialReady = false
      }
      if (!clip) {
        shotIssues.push(continuityIssue({ code: 'missing_material', severity: 'error', shot_id: shot.id, field: 'timeline_clip', message: `分镜「${shot.title}」没有对应的时间线片段` }))
        materialReady = false
      }
      if (clip && clip.asset_id !== selectedAssetId) {
        shotIssues.push(continuityIssue({ code: 'timeline_mismatch', severity: 'error', shot_id: shot.id, field: 'asset_id', message: `分镜「${shot.title}」的选定素材与时间线片段不一致` }))
        materialReady = false
      }
      if (selectedAssetId && !asset) {
        shotIssues.push(continuityIssue({ code: 'missing_material', severity: 'error', shot_id: shot.id, field: 'asset', message: `分镜「${shot.title}」引用的素材记录不存在` }))
        materialReady = false
      }
      if (asset) {
        if (asset.kind !== 'image' && asset.kind !== 'video') {
          shotIssues.push(continuityIssue({ code: 'invalid_material', severity: 'error', shot_id: shot.id, field: 'asset', message: `分镜「${shot.title}」只能使用图片或视频素材` }))
          materialReady = false
        }
        if (!existsSync(asset.path)) {
          shotIssues.push(continuityIssue({ code: 'missing_material_file', severity: 'error', shot_id: shot.id, field: 'asset', message: `分镜「${shot.title}」的素材文件不存在或已被移除` }))
          materialReady = false
        }
        if (review?.status === 'rejected') {
          shotIssues.push(continuityIssue({ code: 'rejected_material', severity: 'error', shot_id: shot.id, field: 'review', message: `分镜「${shot.title}」选用了已拒绝的候选素材${review.note ? `：${review.note}` : ''}` }))
          materialReady = false
        } else if (review?.status === 'pending' || !review) {
          shotIssues.push(continuityIssue({ code: 'pending_review', severity: 'warning', shot_id: shot.id, field: 'review', message: `分镜「${shot.title}」的入片素材${review ? '尚未通过审核' : '还没有审核记录'}` }))
        }
      }
      if (!shot.start_state.trim()) shotIssues.push(continuityIssue({ code: 'missing_state', severity: 'warning', shot_id: shot.id, field: 'start_state', message: `分镜「${shot.title}」没有记录开始状态` }))
      if (!shot.end_state.trim()) shotIssues.push(continuityIssue({ code: 'missing_state', severity: 'warning', shot_id: shot.id, field: 'end_state', message: `分镜「${shot.title}」没有记录结束状态` }))

      if (clip && asset) {
        actualShotDurationMs = clip.out_ms - clip.in_ms
        actualDurationMs += Math.max(0, actualShotDurationMs)
        try { validateClipRange(clip, asset) }
        catch (error) {
          shotIssues.push(continuityIssue({ code: 'invalid_clip', severity: 'error', shot_id: shot.id, field: 'timeline_clip', message: `分镜「${shot.title}」的时间线片段无效：${error instanceof Error ? error.message : String(error)}` }))
          materialReady = false
        }
        if (actualShotDurationMs < 200) {
          shotIssues.push(continuityIssue({ code: 'invalid_clip', severity: 'error', shot_id: shot.id, field: 'duration', message: `分镜「${shot.title}」实际入片时长不足 0.2 秒` }))
          materialReady = false
        } else if (Math.abs(actualShotDurationMs - expectedShotDurationMs) > 100) {
          shotIssues.push(continuityIssue({ code: 'duration_mismatch', severity: 'warning', shot_id: shot.id, field: 'duration', message: `分镜「${shot.title}」计划 ${shot.duration} 秒，当前入片为 ${(actualShotDurationMs / 1000).toFixed(2)} 秒` }))
        }
      }
      const report: ContinuityShotReport = {
        shot_id: shot.id, title: shot.title, position: shot.position,
        expected_duration_ms: expectedShotDurationMs, actual_duration_ms: actualShotDurationMs,
        selected_asset_id: selectedAssetId, timeline_clip_id: clip?.id ?? null,
        review_status: review?.status ?? null, has_material: Boolean(selectedAssetId && clip && asset),
        material_ready: materialReady && Boolean(selectedAssetId && clip && asset), issues: shotIssues,
      }
      reports.push(report)
      issues.push(...shotIssues)
    }

    const snapshot = semanticContinuityContext(id)
    const stored = one<{ signature: string; issues: string; model_id: string; updated_at: string }>(
      'SELECT * FROM continuity_analyses WHERE project_id=?', id)
    const semanticStatus = !stored ? 'not_checked' : stored.signature === snapshot.signature ? 'checked' : 'stale'
    if (semanticStatus === 'checked') {
      const semanticIssues = JSON.parse(stored!.issues) as ContinuityIssue[]
      issues.push(...semanticIssues)
      for (const report of reports) report.issues.push(...semanticIssues.filter(issue => issue.shot_id === report.shot_id))
    }
    const errorCount = issues.filter(issue => issue.severity === 'error').length
    const warningCount = issues.filter(issue => issue.severity === 'warning').length
    return {
      production_range: range,
      semantic_review: { status: semanticStatus, model_id: stored?.model_id || null, checked_at: stored?.updated_at || null },
      shots: reports,
      issues,
      summary: {
        total_shots: shots.length, checked_shots: reports.length,
        pass_count: reports.filter(report => report.issues.length === 0).length,
        warning_count: warningCount, error_count: errorCount,
        expected_duration_ms: expectedDurationMs, actual_duration_ms: actualDurationMs,
        status: errorCount > 0 ? 'blocked' : warningCount > 0 ? 'warning' : 'ready',
      },
    }
  })
  app.post('/api/projects/:id/continuity/analyze', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    const data = parse(z.object({ model_id: z.string().min(1) }).strict(), request.body)
    const model = required<Model>('models', data.model_id)
    if (model.modality !== 'text' || !model.enabled || model.archived) invalid('请选择已启用的文本模型')
    checkProtocol(model.modality, model.protocol)
    validateSettings(model.modality, JSON.parse(model.settings) as Record<string, unknown>)
    const provider = required<Provider>('providers', model.provider_id)
    if (provider.adapter === 'demo' || provider.archived || !provider.enabled) invalid('提供商不可用')
    const snapshot = semanticContinuityContext(id)
    if (Buffer.byteLength(JSON.stringify(snapshot.context), 'utf8') > 200_000) invalid('制作范围过大，请缩小范围后进行语义检查')
    const issues = snapshot.context.pairs.length ? parseSemanticContinuity(
      await generateTextOutput(model, provider, id, semanticContinuityPrompt(snapshot.context)), snapshot.context.pairs) : []
    if (semanticContinuityContext(id).signature !== snapshot.signature) {
      throw Object.assign(new Error('检查期间镜头或剧本资料已变化，请重新检查'), { statusCode: 409 })
    }
    run(`INSERT INTO continuity_analyses (project_id, model_id, signature, issues, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET model_id=excluded.model_id, signature=excluded.signature,
      issues=excluded.issues, updated_at=excluded.updated_at`, id, model.id, snapshot.signature, JSON.stringify(issues), now())
    return { status: 'checked', issue_count: issues.length }
  })
  app.patch('/api/projects/:id', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    const data = parse(projectPatch, request.body)
    if (data.music_asset_id) {
      const asset = required<Asset>('assets', data.music_asset_id)
      if (asset.project_id !== id || asset.kind !== 'audio') invalid('配乐必须是当前项目的音频素材')
    }
    for (const [key, value] of Object.entries(data)) run(`UPDATE projects SET ${key}=? WHERE id=?`, value, id)
    touchProject(id)
    return required<Project>('projects', id)
  })
  app.put('/api/projects/:id/production-range', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    const range = parse(productionRangeInput, request.body)
    selectedProductionShots(all<Shot>('SELECT * FROM shots WHERE project_id=? ORDER BY position', id), range)
    db.transaction(() => {
      if (range.start_shot_id === null && range.end_shot_id === null) {
        run('DELETE FROM production_ranges WHERE project_id=?', id)
      } else {
        run(`INSERT INTO production_ranges (project_id, start_shot_id, end_shot_id) VALUES (?, ?, ?)
          ON CONFLICT(project_id) DO UPDATE SET start_shot_id=excluded.start_shot_id,
            end_shot_id=excluded.end_shot_id`, id, range.start_shot_id, range.end_shot_id)
      }
      touchProject(id)
    })()
    return projectProductionRange(id)
  })
  app.get('/api/projects/:id/cut-reviews', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    return projectCutReviews(id)
  })
  app.put('/api/projects/:id/cut-points', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    const data = parse(cutPointsInput, request.body)
    return db.transaction(() => {
      const cut = projectCutReviews(id).cuts.find(item =>
        item.from_shot_id === data.from_shot_id && item.to_shot_id === data.to_shot_id)
      if (!cut) invalid('这两个分镜不是当前制作范围内的相邻镜头')
      if (cut.signature !== data.signature) {
        throw Object.assign(new Error('素材或切点已变化，请刷新接镜画面后重试'), { statusCode: 409 })
      }
      if (!cut.ready || !cut.from.clip_id || !cut.to.clip_id) invalid('请先选定两侧有效的入片素材')
      const fromClip = one<TimelineClip>('SELECT * FROM timeline_clips WHERE id=? AND project_id=? AND shot_id=?',
        cut.from.clip_id, id, data.from_shot_id)
      const toClip = one<TimelineClip>('SELECT * FROM timeline_clips WHERE id=? AND project_id=? AND shot_id=?',
        cut.to.clip_id, id, data.to_shot_id)
      if (!fromClip || !toClip || fromClip.asset_id !== cut.from.asset_id || toClip.asset_id !== cut.to.asset_id) {
        invalid('时间线素材与选定素材不一致')
      }
      const fromAsset = required<Asset>('assets', fromClip.asset_id)
      const toAsset = required<Asset>('assets', toClip.asset_id)
      if (fromAsset.kind === 'image' && data.from_out_ms !== fromClip.out_ms) invalid('图片片段不能调整出点')
      if (toAsset.kind === 'image' && data.to_in_ms !== toClip.in_ms) invalid('图片片段不能调整入点')
      validateClipRange({ ...fromClip, out_ms: data.from_out_ms }, fromAsset)
      validateClipRange({ ...toClip, in_ms: data.to_in_ms }, toAsset)
      run('UPDATE timeline_clips SET out_ms=? WHERE id=?', data.from_out_ms, fromClip.id)
      run('UPDATE timeline_clips SET in_ms=? WHERE id=?', data.to_in_ms, toClip.id)
      touchProject(id)
      return projectCutReviews(id).cuts.find(item =>
        item.from_shot_id === data.from_shot_id && item.to_shot_id === data.to_shot_id)!
    })()
  })
  app.put('/api/projects/:id/cut-reviews', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    const data = parse(cutReviewInput, request.body)
    return db.transaction(() => {
      const cut = projectCutReviews(id).cuts.find(item =>
        item.from_shot_id === data.from_shot_id && item.to_shot_id === data.to_shot_id)
      if (!cut) invalid('这两个分镜不是当前制作范围内的相邻镜头')
      if (cut.signature !== data.signature) {
        throw Object.assign(new Error('素材或切点已变化，请刷新接镜画面后重新审核'), { statusCode: 409 })
      }
      if (data.status === 'approved' && !cut.ready) invalid('请先选定两侧入片素材并设置有效片段，再通过接镜审核')
      const snapshot: CutSnapshot = {
        from_selected_asset_id: cut.from.asset_id, to_selected_asset_id: cut.to.asset_id,
        from_clip_id: cut.from.clip_id, to_clip_id: cut.to.clip_id,
        from_clip_asset_id: cut.from.clip_asset_id, to_clip_asset_id: cut.to.clip_asset_id,
        from_in_ms: cut.from.in_ms, from_out_ms: cut.from.out_ms,
        to_in_ms: cut.to.in_ms, to_out_ms: cut.to.out_ms,
      }
      run(`INSERT INTO cut_reviews (project_id, from_shot_id, to_shot_id, status, note, signature,
          from_selected_asset_id, to_selected_asset_id, from_clip_id, to_clip_id,
          from_clip_asset_id, to_clip_asset_id, from_in_ms, from_out_ms, to_in_ms, to_out_ms, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, from_shot_id, to_shot_id) DO UPDATE SET
          status=excluded.status, note=excluded.note, signature=excluded.signature,
          from_selected_asset_id=excluded.from_selected_asset_id,
          to_selected_asset_id=excluded.to_selected_asset_id,
          from_clip_id=excluded.from_clip_id, to_clip_id=excluded.to_clip_id,
          from_clip_asset_id=excluded.from_clip_asset_id, to_clip_asset_id=excluded.to_clip_asset_id,
          from_in_ms=excluded.from_in_ms, from_out_ms=excluded.from_out_ms,
          to_in_ms=excluded.to_in_ms, to_out_ms=excluded.to_out_ms,
          updated_at=excluded.updated_at`,
        id, cut.from_shot_id, cut.to_shot_id, data.status, data.note, cut.signature,
        snapshot.from_selected_asset_id, snapshot.to_selected_asset_id,
        snapshot.from_clip_id, snapshot.to_clip_id,
        snapshot.from_clip_asset_id, snapshot.to_clip_asset_id,
        snapshot.from_in_ms, snapshot.from_out_ms, snapshot.to_in_ms, snapshot.to_out_ms, now())
      touchProject(id)
      return projectCutReviews(id).cuts.find(item =>
        item.from_shot_id === data.from_shot_id && item.to_shot_id === data.to_shot_id)!
    })()
  })
  app.delete('/api/projects/:id', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    if (one<Job>("SELECT * FROM jobs WHERE project_id=? AND status IN ('queued','running') LIMIT 1", id)) invalid('项目还有进行中的任务')
    run('DELETE FROM projects WHERE id=?', id)
    await rm(join(mediaDir, id), { recursive: true, force: true })
    return { ok: true }
  })
  app.put('/api/projects/:id/script', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    const data = parse(scriptInput, request.body)
    db.transaction(() => {
      const timestamp = now()
      if (data.brief !== undefined) run('UPDATE projects SET brief=?, updated_at=? WHERE id=?', data.brief, timestamp, id)
      const current = one<{ generation_options: string }>(
        'SELECT generation_options FROM scripts WHERE project_id=?', id,
      )
      const generationOptions = data.generation_options === undefined
        ? current?.generation_options || '{}'
        : JSON.stringify(data.generation_options)
      run(`INSERT INTO scripts (project_id, outline, characters, generation_options, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET outline=excluded.outline, characters=excluded.characters,
          generation_options=excluded.generation_options, updated_at=excluded.updated_at`,
        id, data.outline, data.characters, generationOptions, timestamp)
      if (data.scenes) {
        const retained = new Set<string>()
        data.scenes.forEach((scene, position) => {
          if (scene.id) {
            if (retained.has(scene.id)) invalid('场次不能重复')
            const existing = required<ScriptScene>('script_scenes', scene.id)
            if (existing.project_id !== id) invalid('场次不属于当前项目')
            retained.add(scene.id)
            run(`UPDATE script_scenes SET position=?, heading=?, location=?, time_of_day=?, characters=?,
              action=?, dialogue=?, narration=?, duration=?, episode_number=?, updated_at=? WHERE id=?`,
              position, scene.heading, scene.location, scene.time_of_day, scene.characters,
              scene.action, scene.dialogue, scene.narration, scene.duration, scene.episode_number, timestamp, scene.id)
          } else {
            retained.add(insertScriptScene(id, position, scene).id)
          }
        })
        for (const scene of all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=?', id)) {
          if (!retained.has(scene.id)) run('DELETE FROM script_scenes WHERE id=?', scene.id)
        }
      }
      touchProject(id)
    })()
    return projectScript(id)
  })
  // A generated script is a small project document, not just two text fields.
  // Commit the script, scenes and all confirmed artifacts together so a
  // refresh can never expose a half-written project.
  app.put('/api/projects/:id/script/commit', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    const data = parse(scriptCommitInput, request.body)
    db.transaction(() => {
      const timestamp = now()
      if (data.brief !== undefined) run('UPDATE projects SET brief=?, updated_at=? WHERE id=?', data.brief, timestamp, id)
      const current = one<{ generation_options: string }>('SELECT generation_options FROM scripts WHERE project_id=?', id)
      const generationOptions = data.generation_options === undefined
        ? current?.generation_options || '{}'
        : JSON.stringify(data.generation_options)
      run(`INSERT INTO scripts (project_id, outline, characters, generation_options, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET outline=excluded.outline, characters=excluded.characters,
          generation_options=excluded.generation_options, updated_at=excluded.updated_at`,
        id, data.outline, data.characters, generationOptions, timestamp)

      if (data.scenes) {
        const retained = new Set<string>()
        data.scenes.forEach((scene, position) => {
          if (scene.id) {
            if (retained.has(scene.id)) invalid('场次不能重复')
            const existing = required<ScriptScene>('script_scenes', scene.id)
            if (existing.project_id !== id) invalid('场次不属于当前项目')
            retained.add(scene.id)
            run(`UPDATE script_scenes SET position=?, heading=?, location=?, time_of_day=?, characters=?,
              action=?, dialogue=?, narration=?, duration=?, episode_number=?, updated_at=? WHERE id=?`,
              position, scene.heading, scene.location, scene.time_of_day, scene.characters,
              scene.action, scene.dialogue, scene.narration, scene.duration, scene.episode_number, timestamp, scene.id)
          } else {
            retained.add(insertScriptScene(id, position, scene).id)
          }
        })
        for (const scene of all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=?', id)) {
          if (!retained.has(scene.id)) run('DELETE FROM script_scenes WHERE id=?', scene.id)
        }
      }

      // The commit represents the user's confirmed document. Upsert by type and episode
      // to keep asset-task bindings stable, then remove obsolete document
      // types. Tasks that referenced a removed type must be confirmed again.
      const previousArtifacts = all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=?', id)
      const artifactKey = (artifact: { artifact_type: string; episode_number: number }) => `${artifact.artifact_type}:${artifact.episode_number}`
      const incomingKeys = new Set(data.artifacts.map(artifactKey))
      if (incomingKeys.size !== data.artifacts.length) invalid('剧本文档不能重复')
      data.artifacts.forEach((artifact, index) => {
        const existing = previousArtifacts.find((item) => artifactKey(item) === artifactKey(artifact))
        const artifactId = existing?.id || newId()
        if (existing) {
          run('UPDATE script_artifacts SET title=?, content=?, position=?, status=?, updated_at=? WHERE id=? AND project_id=?',
            artifact.title, artifact.content, artifact.position ?? index, artifact.status, timestamp, artifactId, id)
        } else {
          run(`INSERT INTO script_artifacts (id, project_id, artifact_type, title, content, position, status, created_at, updated_at, episode_number)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            artifactId, id, artifact.artifact_type, artifact.title, artifact.content, artifact.position ?? index,
            artifact.status, timestamp, timestamp, artifact.episode_number)
        }
      })
      const removed = previousArtifacts.filter((artifact) => !incomingKeys.has(artifactKey(artifact)))
      removed.forEach((artifact) => run('DELETE FROM script_artifacts WHERE id=? AND project_id=?', artifact.id, id))
      if (removed.length) {
        run(`UPDATE asset_tasks SET source_artifact_ids='[]', status='awaiting_confirmation', prompt='', error=?, updated_at=?
          WHERE project_id=? AND status <> 'generating'`, '剧本文档已更新，请重新确认资料', timestamp, id)
      }
      touchProject(id)
    })()
    return projectScript(id)
  })
  app.put('/api/projects/:id/script/director/draft', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    const data = parse(workflowCommitInput, request.body)
    db.transaction(() => {
      const current = projectScript(id)
      const timestamp = now()
      const episode = data.stage === 'episode' ? data.episode_number : 0
      const outline = data.artifacts.find(item => item.artifact_type === 'outline')?.content ?? current.outline
      const characters = data.artifacts.find(item => item.artifact_type === 'characters')?.content ?? current.characters
      run(`INSERT INTO scripts (project_id, outline, characters, generation_options, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET outline=excluded.outline, characters=excluded.characters,
          generation_options=excluded.generation_options, updated_at=excluded.updated_at`,
        id, outline, characters, JSON.stringify(data.generation_options ?? current.generation_options), timestamp)
      if (data.brief) run('UPDATE projects SET brief=? WHERE id=?', data.brief, id)
      data.artifacts.forEach((artifact, index) => {
        const existing = current.artifacts?.find(item => item.artifact_type === artifact.artifact_type && item.episode_number === episode)
        if (existing) {
          run("UPDATE script_artifacts SET title=?, content=?, status='ready', updated_at=? WHERE id=?",
            artifact.title, artifact.content, timestamp, existing.id)
        } else {
          run(`INSERT INTO script_artifacts (id, project_id, artifact_type, title, content, position, status, created_at, updated_at, episode_number)
            VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`, newId(), id, artifact.artifact_type,
            artifact.title, artifact.content, (current.artifacts?.length || 0) + index, timestamp, timestamp, episode)
        }
      })
      if (data.stage === 'episode') {
        const previous = current.scenes.filter(scene => scene.episode_number === episode)
        const replacementIds: string[] = []
        data.scenes.forEach((scene, index) => {
          const previousScene = previous[index]
          if (previousScene) {
            // Keep scene IDs and existing shot/material bindings stable on revision.
            run(`UPDATE script_scenes SET heading=?, location=?, time_of_day=?, characters=?, action=?,
              dialogue=?, narration=?, duration=?, updated_at=? WHERE id=?`, scene.heading, scene.location,
              scene.time_of_day, scene.characters, scene.action, scene.dialogue, scene.narration,
              scene.duration, timestamp, previousScene.id)
            replacementIds.push(previousScene.id)
          } else replacementIds.push(insertScriptScene(id, current.scenes.length + index, { ...scene, episode_number: episode }).id)
        })
        for (const scene of previous.slice(data.scenes.length)) run('DELETE FROM script_scenes WHERE id=?', scene.id)
        const firstPosition = current.scenes.findIndex(scene => scene.episode_number === episode)
        const ordered = current.scenes.filter(scene => scene.episode_number !== episode).map(scene => scene.id)
        const laterEpisode = current.scenes.filter(scene => scene.episode_number !== episode).findIndex(scene => scene.episode_number > episode)
        ordered.splice(firstPosition >= 0 ? firstPosition : laterEpisode >= 0 ? laterEpisode : ordered.length, 0, ...replacementIds)
        ordered.forEach((sceneId, position) => run('UPDATE script_scenes SET position=? WHERE id=?', position, sceneId))
      }
      touchProject(id)
    })()
    return projectScript(id)
  })
  app.put('/api/projects/:id/script/artifacts', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    const data = parse(scriptArtifactsInput, request.body)
    db.transaction(() => {
      const timestamp = now()
      data.artifacts.forEach((artifact, index) => {
        const existing = one<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=? AND artifact_type=? AND episode_number=?', id, artifact.artifact_type, artifact.episode_number)
        const artifactId = existing?.id || artifact.id || newId()
        if (existing) {
          run('UPDATE script_artifacts SET title=?, content=?, position=?, status=?, updated_at=? WHERE id=? AND project_id=?',
            artifact.title, artifact.content, artifact.position ?? index, artifact.status, timestamp, artifactId, id)
        } else {
          run('INSERT INTO script_artifacts (id, project_id, artifact_type, title, content, position, status, created_at, updated_at, episode_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            artifactId, id, artifact.artifact_type, artifact.title, artifact.content, artifact.position ?? index, artifact.status, timestamp, timestamp, artifact.episode_number)
        }
      })
      touchProject(id)
    })()
    return projectScript(id)
  })
  app.patch('/api/script-artifacts/:id', async request => {
    const { id } = parse(idParams, request.params)
    const artifact = required<ScriptArtifact>('script_artifacts', id)
    const data = parse(scriptArtifactPatch, request.body)
    const timestamp = now()
    for (const [key, value] of Object.entries(data)) run(`UPDATE script_artifacts SET ${key}=? WHERE id=?`, value, id)
    run('UPDATE script_artifacts SET updated_at=? WHERE id=?', timestamp, id)
    touchProject(artifact.project_id)
    return required<ScriptArtifact>('script_artifacts', id)
  })
  app.get('/api/projects/:id/asset-tasks', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    return { tasks: all<AssetTask>('SELECT * FROM asset_tasks WHERE project_id=? ORDER BY updated_at DESC, rowid DESC', id).map(assetTaskPublic) }
  })
  app.post('/api/projects/:id/asset-tasks', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    const data = parse(assetTaskCreateInput, request.body)
    const defaultArtifactTypes: Record<AssetTask['focus_artifact'], ScriptArtifact['artifact_type'][]> = {
      character: ['characters', 'relationships'], location: ['locations', 'structure'], prop: ['props'],
    }
    const existingArtifacts = all<ScriptArtifact>('SELECT * FROM script_artifacts WHERE project_id=? ORDER BY position', id)
    const requestedArtifactIds = data.source_artifact_ids.length
      ? data.source_artifact_ids
      : existingArtifacts.filter((artifact) => defaultArtifactTypes[data.focus_artifact].includes(artifact.artifact_type)).map((artifact) => artifact.id)
    if (new Set(requestedArtifactIds).size !== requestedArtifactIds.length) invalid('来源剧本产物不能重复')
    for (const artifactId of requestedArtifactIds) {
      const artifact = required<ScriptArtifact>('script_artifacts', artifactId)
      if (artifact.project_id !== id) invalid('来源剧本产物不属于当前项目')
    }
    const existingScenes = all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=? ORDER BY position', id)
    const requestedSceneIds = data.source_scene_ids.length
      ? data.source_scene_ids
      : data.focus_artifact === 'location' ? existingScenes.map((scene) => scene.id) : []
    if (new Set(requestedSceneIds).size !== requestedSceneIds.length) invalid('来源场次不能重复')
    for (const sceneId of requestedSceneIds) {
      const scene = required<ScriptScene>('script_scenes', sceneId)
      if (scene.project_id !== id) invalid('来源场次不属于当前项目')
    }
    const taskId = newId(), timestamp = now()
    db.transaction(() => {
      run(`INSERT INTO asset_tasks
        (id, project_id, focus_artifact, status, source_artifact_ids, source_scene_ids, prompt, generation_job_id, result_asset_id, error, created_at, updated_at)
        VALUES (?, ?, ?, 'awaiting_confirmation', ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
        taskId, id, data.focus_artifact, JSON.stringify(requestedArtifactIds), JSON.stringify(requestedSceneIds), data.prompt, timestamp, timestamp)
      addAssetTaskEvent(taskId, 'text_read', '已读取创作文本，并绑定当前任务的剧本产物与场次')
      const focusLabel = data.focus_artifact === 'character' ? '人物' : data.focus_artifact === 'location' ? '场景' : '道具'
      addAssetTaskEvent(taskId, 'analysis', `正在分析${focusLabel}资料，整理生成所需的视觉信息`)
      addAssetTaskEvent(taskId, 'awaiting_confirmation', '等待确认资料；确认后才会提交图片生成任务')
      touchProject(id)
    })()
    return assetTaskPublic(required<AssetTask>('asset_tasks', taskId))
  })
  app.get('/api/asset-tasks/:id', async request => {
    const { id } = parse(idParams, request.params)
    return assetTaskPublic(required<AssetTask>('asset_tasks', id))
  })
  app.patch('/api/asset-tasks/:id', async request => {
    const { id } = parse(idParams, request.params)
    const task = required<AssetTask>('asset_tasks', id)
    const data = parse(assetTaskPatchInput, request.body)
    if (task.status === 'generating') invalid('图片任务进行中，暂不能修改资料')
    if (data.source_artifact_ids) {
      if (new Set(data.source_artifact_ids).size !== data.source_artifact_ids.length) invalid('来源剧本产物不能重复')
      for (const artifactId of data.source_artifact_ids) {
        const artifact = required<ScriptArtifact>('script_artifacts', artifactId)
        if (artifact.project_id !== task.project_id) invalid('来源剧本产物不属于当前项目')
      }
    }
    if (data.source_scene_ids) {
      if (new Set(data.source_scene_ids).size !== data.source_scene_ids.length) invalid('来源场次不能重复')
      for (const sceneId of data.source_scene_ids) {
        const scene = required<ScriptScene>('script_scenes', sceneId)
        if (scene.project_id !== task.project_id) invalid('来源场次不属于当前项目')
      }
    }
    const timestamp = now()
    if (data.prompt !== undefined) run('UPDATE asset_tasks SET prompt=?, updated_at=? WHERE id=?', data.prompt, timestamp, id)
    if (data.source_artifact_ids !== undefined) run('UPDATE asset_tasks SET source_artifact_ids=?, updated_at=? WHERE id=?', JSON.stringify(data.source_artifact_ids), timestamp, id)
    if (data.source_scene_ids !== undefined) run('UPDATE asset_tasks SET source_scene_ids=?, updated_at=? WHERE id=?', JSON.stringify(data.source_scene_ids), timestamp, id)
    touchProject(task.project_id)
    return assetTaskPublic(required<AssetTask>('asset_tasks', id))
  })
  app.post('/api/asset-tasks/:id/generate', async request => {
    const { id } = parse(idParams, request.params)
    const task = required<AssetTask>('asset_tasks', id)
    if (!['awaiting_confirmation', 'ready', 'failed'].includes(task.status)) invalid('当前任务尚未准备好重新生成')
    const data = parse(assetTaskGenerateInput, request.body)
    const model = required<Model>('models', data.model_id)
    if (model.modality !== 'image' || !model.enabled || model.archived) invalid('请选择已启用的图片模型')
    checkProtocol(model.modality, model.protocol)
    validateSettings(model.modality, JSON.parse(model.settings) as Record<string, unknown>)
    const provider = required<Provider>('providers', model.provider_id)
    if (provider.adapter === 'demo' || provider.archived || !provider.enabled) invalid('提供商不可用，请在模型设置中启用')
    const references = data.reference_asset_ids.map((assetId) => required<Asset>('assets', assetId))
    if (new Set(data.reference_asset_ids).size !== data.reference_asset_ids.length) invalid('参考图片不能重复')
    if (references.some((asset) => asset.project_id !== task.project_id || asset.kind !== 'image')) invalid('参考图片必须来自当前项目')
    if (data.mode === 'reference' && !references.length) invalid('参考模式至少需要一张参考图片')
    const prompt = data.prompt || task.prompt
    if (!prompt.trim()) invalid('请先填写图片生成提示词')
    const jobId = newId(), timestamp = now()
    const requestPayload = {
      asset_task_id: task.id, prompt, mode: data.mode, reference_asset_ids: data.reference_asset_ids,
      reference_video_url: null, resolution: data.resolution ?? null, quality: data.quality ?? null,
      clarity: data.clarity ?? null, background: data.background ?? null, duration: 5, ratio: data.ratio,
      generate_audio: false, draft: false,
    }
    db.transaction(() => {
      run("INSERT INTO jobs VALUES (?, ?, NULL, ?, 'generation', ?, 'queued', NULL, NULL, NULL, ?, ?)",
        jobId, task.project_id, model.id, JSON.stringify(requestPayload), timestamp, timestamp)
      run('UPDATE asset_tasks SET status=?, prompt=?, generation_job_id=?, result_asset_id=NULL, error=NULL, updated_at=? WHERE id=?',
        'generating', prompt, jobId, timestamp, task.id)
      addAssetTaskEvent(task.id, 'generating', '正在生成图片资产，结果完成后会自动回写到本任务')
      touchProject(task.project_id)
    })()
    return { task: assetTaskPublic(required<AssetTask>('asset_tasks', task.id)), job: jobPublic(required<Job>('jobs', jobId)) }
  })
  app.get('/api/projects/:id/script/conversations', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    const conversations = all<ScriptConversation>('SELECT * FROM script_conversations WHERE project_id=? ORDER BY updated_at DESC LIMIT 30', id)
      .map(conversation => {
        const messages = all<ScriptMessage>('SELECT id, conversation_id, position, role, text, reference_documents, processing_duration_ms, created_at FROM script_messages WHERE conversation_id=? ORDER BY position', conversation.id)
        return { ...conversation, messages: messages.map((message, index) => classifiedMessage(id, message, replyFollowingMessages(messages, index))) }
      })
    return { conversations }
  })
  app.post('/api/projects/:id/script/themes/visuals', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    const data = parse(themeVisualInput, request.body)
    // An exact catalog identity is metadata, not a semantic inference.
    if ((!data.genre || isScriptThemeCategory(data.genre)) && (!data.genre_fusion || isScriptThemeCategory(data.genre_fusion))) {
      return { primary: data.genre || null, fusion: data.genre_fusion || null }
    }
    const model = required<Model>('models', data.model_id)
    if (model.modality !== 'text' || !model.enabled || model.archived) invalid('请选择已启用的文本模型')
    checkProtocol(model.modality, model.protocol)
    validateSettings(model.modality, JSON.parse(model.settings) as Record<string, unknown>)
    const provider = required<Provider>('providers', model.provider_id)
    if (provider.adapter === 'demo' || provider.archived || !provider.enabled) invalid('提供商不可用')
    // A read-only, isolated classification; it never patches generation options
    // or advances the director's conversation/workflow.
    return parseThemeVisuals(await generateTextOutput(model, provider, id, themeVisualPrompt(data)), data)
  })
  app.post('/api/projects/:id/script/replies/classify', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    const data = parse(z.object({
      model_id: z.string().min(1),
      force: z.boolean().optional(),
      messages: z.array(z.object({
        id: z.string().trim().min(1).max(120), text: z.string().trim().min(1).max(8000),
        following_messages: z.array(z.object({ role: z.enum(['assistant', 'user']), text: z.string().max(300) }).strict()).max(8).optional(),
      }).strict()).min(1).max(10),
    }).strict(), request.body)
    if (new Set(data.messages.map(item => item.id)).size !== data.messages.length) invalid('消息 ID 不可重复')
    if (data.force && data.messages.length !== 1) invalid('重新识别仅支持当前单条回复')
    if (Buffer.byteLength(JSON.stringify(data.messages), 'utf8') > 40_000) invalid('识别内容不能超过 40 KB')
    const model = required<Model>('models', data.model_id)
    if (model.modality !== 'text' || !model.enabled || model.archived) invalid('请选择已启用的文本模型')
    checkProtocol(model.modality, model.protocol)
    validateSettings(model.modality, JSON.parse(model.settings) as Record<string, unknown>)
    const provider = required<Provider>('providers', model.provider_id)
    if (provider.adapter === 'demo' || provider.archived || !provider.enabled) invalid('提供商不可用')
    const results: Array<{ id: string; classification: z.infer<typeof replyClassification> }> = []
    const missing = data.messages.filter(message => {
      const cached = data.force ? null : cachedReplyClassification(id, message)
      if (!cached) return true
      results.push({ id: message.id, classification: cached })
      return false
    })
    if (missing.length) {
      const analyzed = parseReplyClassifications(await generateTextOutput(model, provider, id, replyClassificationPrompt(missing)), missing.map(item => item.id))
      db.transaction(() => {
        for (const result of analyzed) {
          const source = missing.find(item => item.id === result.id)!
          if (data.force) run('DELETE FROM script_reply_classifications WHERE project_id=? AND message_id=? AND text_hash IN (?, ?)',
            id, source.id, replyTextHash(source.text), replyTextHash(source.text, source.following_messages || []))
          run(`INSERT OR REPLACE INTO script_reply_classifications (project_id, message_id, text_hash, classification, model_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`, id, result.id, replyTextHash(source.text, ['choice_request', 'input_request'].includes(result.classification.type) ? source.following_messages || [] : undefined), JSON.stringify(result.classification), model.id, now())
        }
      })()
      results.push(...analyzed)
    }
    return { classification_version: replyClassificationVersion, messages: results }
  })
  app.put('/api/projects/:id/script/conversations', { bodyLimit: 26 * 1024 * 1024 }, async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    const data = parse(scriptConversationInput, request.body)
    const conversationId = data.id || newId()
    const existing = one<ScriptConversation>('SELECT * FROM script_conversations WHERE id=?', conversationId)
    if (existing && existing.project_id !== id) invalid('对话不属于当前项目')
    const firstUserMessage = data.messages.find(message => message.role === 'user')?.text.trim() || ''
    const label = (data.label?.trim() || firstUserMessage || '未命名对话').slice(0, 120)
    const previousTimestamp = one<{ updated_at: string }>(
      'SELECT updated_at FROM script_conversations WHERE project_id=? ORDER BY updated_at DESC LIMIT 1', id,
    )?.updated_at
    const previousTime = previousTimestamp ? Date.parse(previousTimestamp) : 0
    const timestamp = new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString()
    db.transaction(() => {
      if (existing) {
        run('UPDATE script_conversations SET label=?, updated_at=? WHERE id=?', label, timestamp, conversationId)
        run('DELETE FROM script_messages WHERE conversation_id=?', conversationId)
      } else {
        run('INSERT INTO script_conversations (id, project_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', conversationId, id, label, timestamp, timestamp)
      }
      data.messages.forEach((message, position) => run(
        'INSERT INTO script_messages (id, conversation_id, position, role, text, reference_documents, processing_duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        message.id || newId(), conversationId, position, message.role, message.text, JSON.stringify(message.reference_documents || []), message.processing_duration_ms ?? null, timestamp,
      ))
      run(`DELETE FROM script_conversations WHERE project_id=? AND id NOT IN (
        SELECT id FROM script_conversations WHERE project_id=? ORDER BY updated_at DESC LIMIT 30
      )`, id, id)
    })()
    return {
      ...required<ScriptConversation>('script_conversations', conversationId),
      messages: all<ScriptMessage>('SELECT id, conversation_id, position, role, text, reference_documents, processing_duration_ms, created_at FROM script_messages WHERE conversation_id=? ORDER BY position', conversationId).map(message => ({ ...message, reference_documents: decodeReferenceDocuments(message.reference_documents) })),
    }
  })
  app.post('/api/projects/:id/script/scenes', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    const data = parse(scriptSceneFields, request.body)
    const position = one<{ next: number }>('SELECT COALESCE(MAX(position), -1)+1 AS next FROM script_scenes WHERE project_id=?', id)!.next
    const scene = insertScriptScene(id, position, data)
    touchProject(id)
    return scene
  })
  app.patch('/api/script-scenes/:id', async request => {
    const { id } = parse(idParams, request.params)
    const scene = required<ScriptScene>('script_scenes', id)
    const data = parse(scriptScenePatch, request.body)
    db.transaction(() => {
      if (data.position !== undefined) {
        const ids = all<{ id: string }>('SELECT id FROM script_scenes WHERE project_id=? ORDER BY position', scene.project_id)
          .map(item => item.id).filter(item => item !== id)
        ids.splice(Math.min(data.position, ids.length), 0, id)
        ids.forEach((item, index) => run('UPDATE script_scenes SET position=? WHERE id=?', index, item))
        delete data.position
      }
      for (const [key, value] of Object.entries(data)) run(`UPDATE script_scenes SET ${key}=? WHERE id=?`, value, id)
      run('UPDATE script_scenes SET updated_at=? WHERE id=?', now(), id)
      touchProject(scene.project_id)
    })()
    return required<ScriptScene>('script_scenes', id)
  })
  app.delete('/api/script-scenes/:id', async request => {
    const { id } = parse(idParams, request.params)
    const scene = required<ScriptScene>('script_scenes', id)
    db.transaction(() => {
      run('DELETE FROM script_scenes WHERE id=?', id)
      all<{ id: string }>('SELECT id FROM script_scenes WHERE project_id=? ORDER BY position', scene.project_id)
        .forEach((item, index) => run('UPDATE script_scenes SET position=? WHERE id=?', index, item.id))
      touchProject(scene.project_id)
    })()
    return { ok: true }
  })
  app.post('/api/projects/:id/script/convert-to-shots', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    const { scene_ids } = parse(sceneConversionInput, request.body)
    const scenes = selectedScenes(id, scene_ids)
    const existing = new Set(all<{ source_scene_id: string }>(
      'SELECT source_scene_id FROM shots WHERE project_id=? AND source_scene_id IS NOT NULL', id,
    ).map(item => item.source_scene_id))
    const shots: Shot[] = [], skipped_scene_ids: string[] = []
    db.transaction(() => {
      let position = one<{ next: number }>('SELECT COALESCE(MAX(position), -1)+1 AS next FROM shots WHERE project_id=?', id)!.next
      for (const scene of scenes) {
        if (existing.has(scene.id)) { skipped_scene_ids.push(scene.id); continue }
        const shotId = newId()
        run(`INSERT INTO shots (id, project_id, position, title, prompt, duration, selected_asset_id, created_at, source_scene_id)
          VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          shotId, id, position++, scene.heading, scenePrompt(scene), scene.duration, now(), scene.id)
        shots.push(required<Shot>('shots', shotId))
      }
      if (shots.length) touchProject(id)
    })()
    return { shots, skipped_scene_ids }
  })
  app.post('/api/projects/:id/script/plan-shots/prompt', async request => {
    const { id } = parse(idParams, request.params)
    const project = required<Project>('projects', id)
    const data = parse(shotPlanningPromptInput, request.body)
    return { prompt: buildShotPlanningPrompt(project, selectedScenes(id, data.scene_ids), data.shots_per_scene) }
  })
  app.post('/api/projects/:id/script/plan-shots', async (request, reply) => {
    const { id } = parse(idParams, request.params)
    const project = required<Project>('projects', id)
    const data = parse(shotPlanningInput, request.body)
    const scenes = selectedScenes(id, data.scene_ids)
    const model = required<Model>('models', data.model_id)
    if (model.modality !== 'text' || !model.enabled || model.archived) invalid('请选择已启用的文本模型')
    checkProtocol(model.modality, model.protocol)
    validateSettings(model.modality, JSON.parse(model.settings) as Record<string, unknown>)
    const provider = required<Provider>('providers', model.provider_id)
    if (provider.adapter === 'demo' || provider.archived || !provider.enabled) invalid('提供商不可用，请在模型设置中启用')
    const prompt = data.prompt_override || buildShotPlanningPrompt(project, scenes, data.shots_per_scene)
    const raw = await generateTextOutput(model, provider, id, prompt)
    const draft = parseStructuredOutput(raw, shotPlanDraft)
    if (!draft) return reply.code(422).send({
      detail: '文本模型未返回符合格式的分镜方案，请检查模型输出或重新生成', raw_output: raw.slice(0, 5000),
    })
    const byId = new Map(draft.scenes.map(scene => [scene.scene_id, scene]))
    if (byId.size !== scenes.length || draft.scenes.length !== scenes.length || scenes.some(scene => !byId.has(scene.id))) {
      return reply.code(422).send({ detail: '文本模型返回的场次与所选场次不一致', raw_output: raw.slice(0, 5000) })
    }
    if (scenes.some(scene => byId.get(scene.id)!.shots.length > scene.duration)) {
      return reply.code(422).send({ detail: '文本模型生成的镜头数超过场次时长', raw_output: raw.slice(0, 5000) })
    }
    return { scenes: scenes.map(scene => {
      const shots = byId.get(scene.id)!.shots
      const durations = distributeShotDurations(shots, scene.duration)
      return {
        scene_id: scene.id, scene_heading: scene.heading, scene_duration: scene.duration,
        shots: shots.map((shot, index) => ({ ...shot, duration: durations[index] })),
      }
    }) }
  })
  app.post('/api/projects/:id/script/create-planned-shots', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    const data = parse(createPlannedShotsInput, request.body)
    const payloadHash = createHash('sha256').update(JSON.stringify(data.scenes)).digest('hex')
    const previous = one<{ project_id: string; payload_hash: string; shot_ids: string }>(
      'SELECT project_id, payload_hash, shot_ids FROM shot_plan_requests WHERE request_id=?', data.request_id)
    if (previous) {
      if (previous.project_id !== id) invalid('该请求编号已用于其他项目')
      const ids = JSON.parse(previous.shot_ids) as string[]
      return {
        shots: ids.map(shotId => one<Shot>('SELECT * FROM shots WHERE id=?', shotId)).filter((shot): shot is Shot => !!shot),
        replayed: true, payload_changed: previous.payload_hash !== payloadHash,
      }
    }
    const scenes = selectedScenes(id, data.scenes.map(scene => scene.scene_id))
    const plans = new Map(data.scenes.map(scene => [scene.scene_id, scene.shots]))
    for (const scene of scenes) {
      const shots = plans.get(scene.id)!
      if (shots.length > scene.duration || shots.reduce((sum, shot) => sum + shot.duration, 0) !== scene.duration) {
        invalid(`「${scene.heading}」的镜头时长总和必须为 ${scene.duration} 秒`)
      }
    }
    const scenePositions = new Map(all<ScriptScene>('SELECT * FROM script_scenes WHERE project_id=?', id)
      .map(scene => [scene.id, scene.position]))
    const existing = all<Shot>('SELECT * FROM shots WHERE project_id=? ORDER BY position', id)
    const ordered = existing.map(shot => ({ id: shot.id, source_scene_id: shot.source_scene_id }))
    const createdIds: string[] = []
    db.transaction(() => {
      let provisionalPosition = Math.max(-1, ...existing.map(shot => shot.position)) + 1
      for (const scene of scenes) {
        let insertAt = -1
        for (let index = 0; index < ordered.length; index++) {
          if (ordered[index]!.source_scene_id === scene.id) insertAt = index + 1
        }
        if (insertAt < 0) {
          insertAt = ordered.findIndex(shot => shot.source_scene_id &&
            (scenePositions.get(shot.source_scene_id) ?? -1) > scene.position)
          if (insertAt < 0) insertAt = ordered.length
        }
        const additions: typeof ordered = []
        for (const shot of plans.get(scene.id)!) {
          const shotId = newId()
          run(`INSERT INTO shots (id, project_id, position, title, prompt, duration, selected_asset_id, created_at, source_scene_id,
            start_state, end_state, cut_note)
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
            shotId, id, provisionalPosition++, shot.title, shot.prompt, shot.duration, now(), scene.id,
            shot.start_state, shot.end_state, shot.cut_note)
          createdIds.push(shotId)
          additions.push({ id: shotId, source_scene_id: scene.id })
        }
        ordered.splice(insertAt, 0, ...additions)
      }
      ordered.forEach((shot, position) => run('UPDATE shots SET position=? WHERE id=?', position, shot.id))
      run('INSERT INTO shot_plan_requests VALUES (?, ?, ?, ?, ?)',
        data.request_id, id, payloadHash, JSON.stringify(createdIds), now())
      touchProject(id)
    })()
    return { shots: createdIds.map(shotId => required<Shot>('shots', shotId)), replayed: false, payload_changed: false }
  })
  app.post('/api/projects/:id/script/generate/prompt', async request => {
    const { id } = parse(idParams, request.params)
    const project = required<Project>('projects', id)
    const data = parse(scriptGenerationPromptInput, request.body)
    return { prompt: buildScriptGenerationPrompt(project, data) }
  })
  app.post('/api/projects/:id/script/director/chat', { bodyLimit: 3 * 1024 * 1024 }, async request => {
    const { id } = parse(idParams, request.params)
    const project = required<Project>('projects', id)
    const data = parse(scriptDirectorChatInput, request.body)
    const model = required<Model>('models', data.model_id)
    if (model.modality !== 'text' || !model.enabled || model.archived) invalid('请选择已启用的文本模型')
    checkProtocol(model.modality, model.protocol)
    validateSettings(model.modality, JSON.parse(model.settings) as Record<string, unknown>)
    const provider = required<Provider>('providers', model.provider_id)
    if (provider.adapter === 'demo' || provider.archived || !provider.enabled) invalid('提供商不可用，请在模型设置中启用')
    const resolved = await resolveDirectorIntent(project, data, model, provider)
    const result = resolved.reply ? { reply: resolved.reply } : directorResult(
      await generateTextOutput(model, provider, id, buildScriptDirectorChatPrompt(project, resolved.data, resolved)), resolved.data, resolved.sourceText)
    return { ...result, generation_options: resolved.data.generation_options }
  })
  app.post('/api/projects/:id/script/director/chat/stream', { bodyLimit: 3 * 1024 * 1024 }, async (request, reply) => {
    const { id } = parse(idParams, request.params)
    const project = required<Project>('projects', id)
    const data = parse(scriptDirectorChatInput, request.body)
    const model = required<Model>('models', data.model_id)
    if (model.modality !== 'text' || !model.enabled || model.archived) invalid('请选择已启用的文本模型')
    checkProtocol(model.modality, model.protocol)
    validateSettings(model.modality, JSON.parse(model.settings) as Record<string, unknown>)
    const provider = required<Provider>('providers', model.provider_id)
    if (provider.adapter === 'demo' || provider.archived || !provider.enabled) invalid('提供商不可用，请在模型设置中启用')

    // This endpoint deliberately emits safe progress and provider supplied
    // summaries. It never forwards hidden reasoning_content or <think> blocks.
    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const controller = new AbortController()
    const abort = () => controller.abort()
    reply.raw.once('close', abort)
    const send = (event: Record<string, unknown>) => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return
      try { reply.raw.write(`data: ${JSON.stringify(event)}\n\n`) } catch { /* Client disconnected. */ }
    }
    send({ type: 'progress', stage: 'preparing', text: '正在整理项目设定和对话内容…' })
    try {
      send({ type: 'progress', stage: 'intent', text: '正在理解本次创作意图…' })
      const resolved = await resolveDirectorIntent(project, data, model, provider, controller.signal)
      if (controller.signal.aborted) return
      send({ type: 'intent', workflow: resolved.data.workflow, generation_options: resolved.data.generation_options })
      if (resolved.reply) { send({ type: 'done', reply: resolved.reply }); return }
      const prompt = buildScriptDirectorChatPrompt(project, resolved.data, resolved)
      send({ type: 'progress', stage: 'analysis', text: resolved.data.workflow ? '正在编写当前阶段的可编辑文档…' : '正在分析故事结构、人物动机和当前问题…' })
      const fullText = await streamText(
        model, provider, { prompt },
        item => decryptKey(item.key_ciphertext || null),
        event => send(event),
        controller.signal,
      )
      const result = directorResult(fullText, resolved.data, resolved.sourceText)
      send({ type: 'done', ...result })
    } catch (error) {
      send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      send({ type: 'close' })
      reply.raw.removeListener('close', abort)
      reply.raw.end()
    }
  })
  app.post('/api/projects/:id/script/artifacts/generate', async (request, reply) => {
    const { id } = parse(idParams, request.params)
    const project = required<Project>('projects', id)
    const data = parse(scriptArtifactGenerationInput, request.body)
    const model = required<Model>('models', data.model_id)
    if (model.modality !== 'text' || !model.enabled || model.archived) invalid('请选择已启用的文本模型')
    checkProtocol(model.modality, model.protocol)
    validateSettings(model.modality, JSON.parse(model.settings) as Record<string, unknown>)
    const provider = required<Provider>('providers', model.provider_id)
    if (provider.adapter === 'demo' || provider.archived || !provider.enabled) invalid('提供商不可用，请在模型设置中启用')
    const raw = await generateTextOutput(model, provider, id, buildScriptArtifactPrompt(project, data))
    const content = raw.trim()
    if (!content) return reply.code(502).send({ detail: '文本模型未返回产物内容' })
    return { artifact_type: data.artifact_type, title: defaultArtifactTitles[data.artifact_type], content }
  })
  app.post('/api/projects/:id/script/generate', async (request, reply) => {
    const { id } = parse(idParams, request.params)
    const project = required<Project>('projects', id)
    const data = parse(scriptGenerationInput, request.body)
    const model = required<Model>('models', data.model_id)
    if (model.modality !== 'text' || !model.enabled || model.archived) invalid('请选择已启用的文本模型')
    checkProtocol(model.modality, model.protocol)
    validateSettings(model.modality, JSON.parse(model.settings) as Record<string, unknown>)
    const provider = required<Provider>('providers', model.provider_id)
    if (provider.adapter === 'demo' || provider.archived || !provider.enabled) invalid('提供商不可用，请在模型设置中启用')
    const prompt = (data.prompt_override
      ? appendMissingScriptSettings(data.prompt_override, data.generation_options)
      : buildScriptGenerationPrompt(project, data)) + referenceContext([{ role: 'user', text: data.idea || '生成完整剧本草稿', reference_documents: data.reference_documents }])
    const raw = await generateTextOutput(model, provider, id, prompt)
    const draft = parseStructuredOutput(raw, scriptDraft)
    if (!draft) return reply.code(422).send({
      detail: '文本模型未返回符合格式的剧本 JSON，请检查模型输出或重新生成', raw_output: raw.slice(0, 5000),
    })
    return draft
  })
  app.post('/api/projects/:id/shots', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    const data = parse(shotInput, request.body)
    if (data.source_scene_id && required<ScriptScene>('script_scenes', data.source_scene_id).project_id !== id) {
      invalid('来源场次不属于当前项目')
    }
    const position = one<{ next: number }>('SELECT COALESCE(MAX(position), -1)+1 AS next FROM shots WHERE project_id=?', id)!.next
    const shotId = newId()
    run(`INSERT INTO shots (id, project_id, position, title, prompt, duration, selected_asset_id, created_at, source_scene_id,
      start_state, end_state, cut_note)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`, shotId, id, position, data.title, data.prompt,
      data.duration, now(), data.source_scene_id ?? null, data.start_state, data.end_state, data.cut_note)
    touchProject(id)
    return required<Shot>('shots', shotId)
  })
  app.patch('/api/shots/:id', async request => {
    const { id } = parse(idParams, request.params)
    const shot = required<Shot>('shots', id)
    const data = parse(shotPatch, request.body)
    if (data.position !== undefined) {
      const ids = all<{ id: string }>('SELECT id FROM shots WHERE project_id=? ORDER BY position', shot.project_id).map(item => item.id).filter(item => item !== id)
      ids.splice(Math.min(data.position, ids.length), 0, id)
      db.transaction(() => {
        ids.forEach((item, index) => run('UPDATE shots SET position=? WHERE id=?', index, item))
        selectedProductionShots(all<Shot>('SELECT * FROM shots WHERE project_id=? ORDER BY position', shot.project_id),
          projectProductionRange(shot.project_id))
      })()
      delete data.position
    }
    for (const [key, value] of Object.entries(data)) run(`UPDATE shots SET ${key}=? WHERE id=?`, value, id)
    touchProject(shot.project_id)
    return required<Shot>('shots', id)
  })
  app.delete('/api/shots/:id', async request => {
    const { id } = parse(idParams, request.params)
    const shot = required<Shot>('shots', id)
    const range = projectProductionRange(shot.project_id)
    if (range.start_shot_id === id || range.end_shot_id === id) invalid('该镜头是制作范围边界，请先调整制作范围')
    run('DELETE FROM shots WHERE id=?', id)
    all<{ id: string }>('SELECT id FROM shots WHERE project_id=? ORDER BY position', shot.project_id).forEach((item, index) => run('UPDATE shots SET position=? WHERE id=?', index, item.id))
    touchProject(shot.project_id)
    return { ok: true }
  })
  app.put('/api/shots/:id/assets/:assetId/review', async request => {
    const { id, assetId } = parse(assetReviewParams, request.params)
    const shot = required<Shot>('shots', id)
    const asset = required<Asset>('assets', assetId)
    if (asset.project_id !== shot.project_id || !['image', 'video'].includes(asset.kind)) {
      invalid('只能审核当前项目的图片或视频素材')
    }
    const data = parse(assetReviewInput, request.body)
    if (data.status === 'rejected' && !data.note) invalid('请填写拒绝原因，便于下次修改镜头')
    db.transaction(() => {
      run(`INSERT INTO asset_reviews (shot_id, asset_id, status, note, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(shot_id, asset_id) DO UPDATE SET status=excluded.status,
          note=excluded.note, updated_at=excluded.updated_at`, id, assetId, data.status, data.note, now())
      if (data.status === 'rejected' && shot.selected_asset_id === assetId) {
        run('UPDATE shots SET selected_asset_id=NULL WHERE id=?', id)
        run('DELETE FROM timeline_clips WHERE shot_id=?', id)
      }
      touchProject(shot.project_id)
    })()
    return one<AssetReview>('SELECT * FROM asset_reviews WHERE shot_id=? AND asset_id=?', id, assetId)
  })
  app.put('/api/shots/:id/selection', async request => {
    const { id } = parse(idParams, request.params)
    const shot = required<Shot>('shots', id)
    const { asset_id } = parse(z.object({ asset_id: z.string().nullable() }), request.body)
    let asset: Asset | undefined
    let sourceDuration: number | null = null
    if (asset_id) {
      asset = required<Asset>('assets', asset_id)
      if (asset.project_id !== shot.project_id || !['image', 'video'].includes(asset.kind)) invalid('只能选择当前项目的图片或视频')
      if (one<AssetReview>("SELECT * FROM asset_reviews WHERE shot_id=? AND asset_id=? AND status='rejected'", id, asset_id)) {
        invalid('该候选已被拒绝，请先修改审核状态')
      }
      if (!existsSync(asset.path)) invalid('素材文件不存在')
      if (asset.kind === 'video') {
        try { sourceDuration = probeVideoDurationMs(asset.path) }
        catch { invalid('无法读取视频素材时长') }
        if (sourceDuration < 200) invalid('视频素材不足 0.2 秒')
      }
    }
    db.transaction(() => {
      run('UPDATE shots SET selected_asset_id=? WHERE id=?', asset_id, id)
      if (!asset_id) run('DELETE FROM timeline_clips WHERE shot_id=?', id)
      else {
        const old = one<TimelineClip>('SELECT * FROM timeline_clips WHERE shot_id=?', id)
        const out = sourceDuration === null ? shot.duration * 1000 : Math.min(sourceDuration, shot.duration * 1000)
        if (out < 200) invalid('素材不足 0.2 秒')
        if (old) {
          run('UPDATE timeline_clips SET asset_id=?, in_ms=0, out_ms=?, source_duration_ms=? WHERE id=?',
            asset_id, out, sourceDuration, old.id)
        } else {
          run(`INSERT INTO timeline_clips (id, project_id, shot_id, asset_id, in_ms, out_ms, source_duration_ms)
            VALUES (?, ?, ?, ?, 0, ?, ?)`, newId(), shot.project_id, id, asset_id, out, sourceDuration)
        }
      }
      touchProject(shot.project_id)
    })()
    return required<Shot>('shots', id)
  })
  app.patch('/api/timeline-clips/:id', async request => {
    const { id } = parse(idParams, request.params)
    const clip = required<TimelineClip>('timeline_clips', id)
    const data = parse(timelineClipPatch, request.body)
    const asset = required<Asset>('assets', clip.asset_id)
    const updated = { ...clip, ...data }
    validateClipRange(updated, asset)
    run('UPDATE timeline_clips SET in_ms=?, out_ms=?, source_audio_gain=?, source_audio_fade_ms=? WHERE id=?',
      updated.in_ms, updated.out_ms, updated.source_audio_gain, updated.source_audio_fade_ms, id)
    touchProject(clip.project_id)
    return required<TimelineClip>('timeline_clips', id)
  })
  app.post('/api/timeline-clips/:id/tail-frame', async request => {
    const { id } = parse(idParams, request.params)
    const clip = required<TimelineClip>('timeline_clips', id)
    const asset = required<Asset>('assets', clip.asset_id)
    if (asset.kind !== 'video') invalid('仅视频片段可以提取尾帧')
    validateClipRange(clip, asset)
    if (!existsSync(asset.path)) invalid('视频素材文件不存在')
    const actualDuration = probeVideoDurationMs(asset.path)
    if (clip.out_ms > actualDuration) invalid('片段超出视频素材时长')
    const frame = await extractVideoFrame(asset.path, Math.max(clip.in_ms, clip.out_ms - 50))
    const outputDir = join(mediaDir, clip.project_id)
    await mkdir(outputDir, { recursive: true })
    const frameId = newId()
    const filename = `tail-frame-${frameId}.jpg`
    const path = join(outputDir, filename)
    await writeFile(path, frame, { flag: 'wx', mode: 0o600 })
    try {
      run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, model_id, prompt, remote_url, created_at)
        VALUES (?, ?, ?, 'image', ?, ?, 'generated', NULL, NULL, NULL, ?)`,
        frameId, clip.project_id, clip.shot_id, filename, path, now())
    } catch (error) { await rm(path, { force: true }); throw error }
    touchProject(clip.project_id)
    return assetPublic(required<Asset>('assets', frameId))
  })
  app.post('/api/projects/:id/assets', async (request) => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    const file = await request.file()
    if (!file) invalid('请选择素材文件')
    const name = basename(file.filename || 'upload')
    const extension = extname(name).toLowerCase()
    const kind = uploads[extension]
    if (!kind) invalid('仅支持 PNG/JPG/WebP、MP4/MOV、MP3/WAV/M4A')
    const outputDir = join(mediaDir, id)
    await mkdir(outputDir, { recursive: true })
    const output = join(outputDir, `${newId()}${extension}`)
    try {
      await pipeline(file.file, createWriteStream(output, { flags: 'wx', mode: 0o600 }))
      if (file.file.truncated) invalid('素材不能超过 300 MB')
    } catch (error) { await rm(output, { force: true }); throw error }
    const field = file.fields.shot_id
    const shotId = field && !Array.isArray(field) && field.type === 'field' && typeof field.value === 'string' ? field.value : null
    if (shotId && required<Shot>('shots', shotId).project_id !== id) {
      await rm(output, { force: true })
      invalid('分镜不属于当前项目')
    }
    const assetId = newId()
    run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, model_id, prompt, remote_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'upload', NULL, NULL, NULL, ?)`, assetId, id, shotId, kind, name, output, now())
    run('INSERT INTO saved_assets (asset_id, project_id, created_at) VALUES (?, ?, ?)', assetId, id, now())
    touchProject(id)
    return assetPublic(required<Asset>('assets', assetId))
  })
  app.post('/api/assets/:id/save', async request => {
    const { id } = parse(idParams, request.params)
    const asset = required<Asset>('assets', id)
    run('INSERT OR IGNORE INTO saved_assets (asset_id, project_id, created_at) VALUES (?, ?, ?)', asset.id, asset.project_id, now())
    touchProject(asset.project_id)
    return assetPublic(asset)
  })
  app.get('/api/assets/:id/file', async (request, reply) => {
    const { id } = parse(idParams, request.params)
    const asset = required<Asset>('assets', id)
    if (!existsSync(asset.path)) throw Object.assign(new Error('素材文件不存在'), { statusCode: 404 })
    const size = statSync(asset.path).size
    reply.type(mime[extname(asset.path).toLowerCase()] || 'application/octet-stream')
    reply.header('Accept-Ranges', 'bytes')
    if (request.headers.range !== undefined) {
      const range = byteRange(request.headers.range, size)
      if (!range) return reply.code(416).header('Content-Range', `bytes */${size}`).send()
      reply.code(206)
        .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
        .header('Content-Length', range.end - range.start + 1)
      return reply.send(createReadStream(asset.path, range))
    }
    reply.header('Content-Length', size)
    if (asset.source === 'export') reply.header('Content-Disposition', `attachment; filename="${asset.filename}"`)
    return reply.send(createReadStream(asset.path))
  })
  app.get('/api/assets/:id/frame', async (request, reply) => {
    const { id } = parse(idParams, request.params)
    const { time_ms } = parse(frameQuery, request.query)
    const asset = required<Asset>('assets', id)
    if (asset.kind !== 'video') invalid('仅视频素材可以提取画面')
    if (!existsSync(asset.path)) throw Object.assign(new Error('素材文件不存在'), { statusCode: 404 })
    const duration = probeVideoDurationMs(asset.path)
    if (time_ms >= duration) invalid('取帧时间超出视频素材时长')
    return reply.type('image/jpeg').send(await extractVideoFrame(asset.path, time_ms))
  })
  app.post('/api/assets/:id/frames', async request => {
    const { id } = parse(idParams, request.params)
    const { frames } = parse(frameExtractionInput, request.body)
    const source = required<Asset>('assets', id)
    if (source.kind !== 'video') invalid('仅视频素材可以提取首尾帧')
    if (!existsSync(source.path)) throw Object.assign(new Error('视频素材文件不存在'), { statusCode: 404 })

    let duration: number
    try { duration = probeVideoDurationMs(source.path) }
    catch { invalid('无法读取视频素材时长') }

    const outputDir = join(mediaDir, source.project_id)
    await mkdir(outputDir, { recursive: true })
    const createdFiles: string[] = []
    const generated: Asset[] = []
    try {
      for (const frame of frames) {
        // FFmpeg may not emit a frame when seeking within the final millisecond
        // of a clip. A short tail offset reliably selects the final decoded frame.
        const timeMs = frame === 'first' ? 0 : Math.max(0, duration - 50)
        const image = await extractVideoFrame(source.path, timeMs)
        const frameId = newId()
        const filename = `${frame}-frame-${frameId}.jpg`
        const path = join(outputDir, filename)
        await writeFile(path, image, { flag: 'wx', mode: 0o600 })
        createdFiles.push(path)
        generated.push({
          id: frameId, project_id: source.project_id, shot_id: source.shot_id,
          kind: 'image', filename, path, source: 'generated', model_id: null,
          prompt: null, remote_url: null, created_at: now(),
        })
      }

      db.transaction(() => {
        for (const asset of generated) {
          run(`INSERT INTO assets (id, project_id, shot_id, kind, filename, path, source, model_id, prompt, remote_url, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          asset.id, asset.project_id, asset.shot_id, asset.kind, asset.filename, asset.path,
          asset.source, asset.model_id, asset.prompt, asset.remote_url, asset.created_at)
        }
        touchProject(source.project_id)
      })()
    } catch (error) {
      await Promise.allSettled(createdFiles.map(path => rm(path, { force: true })))
      throw error
    }

    return { assets: generated.map(assetPublic) }
  })
  app.get('/api/assets/:id/metadata', async request => {
    const { id } = parse(idParams, request.params)
    const asset = required<Asset>('assets', id)
    if (asset.kind !== 'video') invalid('仅视频素材具有视频时长')
    if (!existsSync(asset.path)) throw Object.assign(new Error('素材文件不存在'), { statusCode: 404 })
    try { return { duration_ms: probeVideoDurationMs(asset.path) } }
    catch { invalid('无法读取视频素材时长') }
  })
  app.get('/api/providers', async () => all<Provider>("SELECT * FROM providers WHERE adapter <> 'demo' AND archived=0 ORDER BY name").map(providerPublic))
  app.post('/api/providers', async request => {
    const data = parse(providerInput, request.body)
    checkBaseUrl(data.base_url)
    const id = newId()
    run('INSERT INTO providers (id, name, adapter, base_url, auth_header, auth_prefix, key_ciphertext, model_catalog, created_at, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, data.name, data.adapter, data.base_url, data.auth_header, data.auth_prefix, encryptKey(data.api_key), JSON.stringify(data.model_catalog), now(), Number(data.enabled))
    return providerPublic(required<Provider>('providers', id))
  })
  app.patch('/api/providers/:id', async request => {
    const { id } = parse(idParams, request.params)
    const existing = required<Provider>('providers', id)
    if (existing.adapter === 'demo' || existing.archived) invalid('此提供商已归档')
    if (one<Job>("SELECT jobs.* FROM jobs JOIN models ON jobs.model_id=models.id WHERE models.provider_id=? AND jobs.status IN ('queued','running') LIMIT 1", id)) invalid('此厂商还有进行中的任务，完成后才能修改连接')
    const data = parse(providerPatch, request.body)
    checkBaseUrl(data.base_url || existing.base_url)
    if ('api_key' in data) {
      run('UPDATE providers SET key_ciphertext=? WHERE id=?', encryptKey(data.api_key), id)
      delete data.api_key
    }
    for (const [key, value] of Object.entries(data)) {
      run(`UPDATE providers SET ${key}=? WHERE id=?`, key === 'enabled' ? Number(value) : key === 'model_catalog' ? JSON.stringify(value) : value, id)
    }
    return providerPublic(required<Provider>('providers', id))
  })
  app.get('/api/providers/:id/model-catalog', async request => {
    const { id } = parse(idParams, request.params)
    const provider = required<Provider>('providers', id)
    if (provider.adapter === 'demo' || provider.archived) invalid('此提供商已归档')
    if (!provider.enabled) invalid('请先启用提供商再同步模型')
    const config = modelCatalogInput.parse(JSON.parse(provider.model_catalog)) as ModelCatalogConfig
    const catalog = await fetchModelCatalog(provider, config)
    const existing = new Set(all<{ remote_id: string }>('SELECT remote_id FROM models WHERE provider_id=? AND archived=0', id).map(model => model.remote_id))
    return { models: catalog.map(model => ({ ...model, existing: existing.has(model.remote_id) })), total: catalog.length }
  })
  app.post('/api/providers/:id/model-catalog/import', async request => {
    const { id } = parse(idParams, request.params)
    const provider = required<Provider>('providers', id)
    if (provider.adapter === 'demo' || provider.archived) invalid('此提供商已归档')
    const data = parse(modelCatalogImport, request.body)
    for (const model of data.models) {
      checkProtocol(model.modality, model.protocol)
      if (model.enabled) validateSettings(model.modality, model.settings)
    }
    const imported: Model[] = []
    const skipped: Array<{ remote_id: string; reason: 'existing' | 'duplicate' }> = []
    db.transaction(() => {
      const seen = new Set<string>()
      for (const model of data.models) {
        if (seen.has(model.remote_id)) {
          skipped.push({ remote_id: model.remote_id, reason: 'duplicate' })
          continue
        }
        seen.add(model.remote_id)
        if (one<Model>('SELECT * FROM models WHERE provider_id=? AND remote_id=? AND archived=0 LIMIT 1', id, model.remote_id)) {
          skipped.push({ remote_id: model.remote_id, reason: 'existing' })
          continue
        }
        const modelId = newId()
        run('INSERT INTO models (id, provider_id, name, remote_id, modality, protocol, settings, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          modelId, id, model.name || model.remote_id.slice(0, 120), model.remote_id, model.modality, model.protocol, JSON.stringify(model.settings), Number(model.enabled))
        imported.push(required<Model>('models', modelId))
      }
    })()
    return { imported: imported.map(modelPublic), skipped }
  })
  app.delete('/api/providers/:id', async request => {
    const { id } = parse(idParams, request.params)
    const provider = required<Provider>('providers', id)
    if (provider.adapter === 'demo' || provider.archived) invalid('此提供商已归档')
    if (one<Job>("SELECT jobs.* FROM jobs JOIN models ON jobs.model_id=models.id WHERE models.provider_id=? AND jobs.status IN ('queued','running') LIMIT 1", id)) invalid('此厂商还有进行中的任务')
    run('DELETE FROM providers WHERE id=?', id)
    return { ok: true }
  })
  app.get('/api/models', async () => all<Model>("SELECT models.* FROM models JOIN providers ON providers.id=models.provider_id WHERE providers.adapter <> 'demo' AND providers.archived=0 AND models.archived=0 ORDER BY models.modality, models.name").map(modelPublic))
  app.post('/api/models', async request => {
    const data = parse(modelInput, request.body)
    const provider = required<Provider>('providers', data.provider_id)
    if (provider.adapter === 'demo' || provider.archived) invalid('此提供商已归档')
    checkProtocol(data.modality, data.protocol)
    validateSettings(data.modality, data.settings)
    const id = newId()
    run('INSERT INTO models (id, provider_id, name, remote_id, modality, protocol, settings, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, data.provider_id, data.name, data.remote_id, data.modality, data.protocol, JSON.stringify(data.settings), Number(data.enabled))
    return modelPublic(required<Model>('models', id))
  })
  app.patch('/api/models/:id', async request => {
    const { id } = parse(idParams, request.params)
    const existing = required<Model>('models', id)
    const currentProvider = required<Provider>('providers', existing.provider_id)
    if (currentProvider.adapter === 'demo' || currentProvider.archived || existing.archived) invalid('此模型已归档')
    if (one<Job>("SELECT * FROM jobs WHERE model_id=? AND status IN ('queued','running') LIMIT 1", id)) invalid('此模型还有进行中的任务，完成后才能修改配置')
    const data = parse(modelPatch, request.body)
    const targetProvider = required<Provider>('providers', data.provider_id || existing.provider_id)
    if (targetProvider.adapter === 'demo' || targetProvider.archived) invalid('此提供商已归档')
    checkProtocol(data.modality || existing.modality, data.protocol || existing.protocol)
    const settings = data.settings || JSON.parse(existing.settings) as Record<string, unknown>
    if (data.enabled ?? Boolean(existing.enabled)) validateSettings(data.modality || existing.modality, settings)
    if (data.settings) {
      run('UPDATE models SET settings=? WHERE id=?', JSON.stringify(data.settings), id)
      delete data.settings
    }
    for (const [key, value] of Object.entries(data)) run(`UPDATE models SET ${key}=? WHERE id=?`, key === 'enabled' ? Number(value) : value, id)
    return modelPublic(required<Model>('models', id))
  })
  app.delete('/api/models/:id', async request => {
    const { id } = parse(idParams, request.params)
    const model = required<Model>('models', id)
    const provider = required<Provider>('providers', model.provider_id)
    if (provider.adapter === 'demo' || provider.archived || model.archived) invalid('此模型已归档')
    if (one<Job>("SELECT * FROM jobs WHERE model_id=? AND status IN ('queued','running') LIMIT 1", id)) invalid('此模型还有进行中的任务')
    run('DELETE FROM models WHERE id=?', id)
    return { ok: true }
  })
  app.post('/api/projects/:id/generate', async request => {
    const { id } = parse(idParams, request.params)
    required<Project>('projects', id)
    const data = parse(generationInput, request.body)
    const shot = data.shot_id ? required<Shot>('shots', data.shot_id) : null
    const model = required<Model>('models', data.model_id)
    if ((shot && shot.project_id !== id) || !model.enabled || model.archived) invalid('分镜或模型不可用')
    // Project-level asset cards use this route only for image generation. A
    // video task without a shot would have nowhere to enter the edit timeline.
    if (!shot && (model.modality !== 'image' || !data.source_artifact_type)) invalid('视频生成需要先关联分镜')
    const provider = required<Provider>('providers', model.provider_id)
    if (provider.adapter === 'demo' || provider.archived || !provider.enabled) invalid('提供商不可用，请在模型设置中启用')
    validateGeneration(data, model, id)
    const jobId = newId(), timestamp = now()
    run("INSERT INTO jobs VALUES (?, ?, ?, ?, 'generation', ?, 'queued', NULL, NULL, NULL, ?, ?)", jobId, id, shot?.id || null, model.id, JSON.stringify(data), timestamp, timestamp)
    return jobPublic(required<Job>('jobs', jobId))
  })
  app.post('/api/projects/:id/export', async request => {
    const { id } = parse(idParams, request.params)
    const project = required<Project>('projects', id)
    const range = projectProductionRange(id)
    const shots = selectedProductionShots(all<Shot>('SELECT * FROM shots WHERE project_id=? ORDER BY position', id), range)
    if (!shots.length) invalid('请先添加分镜')
    const clips = projectClips(id)
    const byShot = new Map(clips.map(clip => [clip.shot_id, clip]))
    if (shots.some(shot => !byShot.has(shot.id))) invalid('存在未选定素材的分镜，请先补齐时间线')
    const renderClips: RenderClip[] = shots.map(shot => {
      const clip = byShot.get(shot.id)!
      const asset = required<Asset>('assets', clip.asset_id)
      if (shot.selected_asset_id !== clip.asset_id) invalid(`分镜「${shot.title}」选片与时间线不一致`)
      if (one<AssetReview>("SELECT * FROM asset_reviews WHERE shot_id=? AND asset_id=? AND status='rejected'", shot.id, asset.id)) {
        invalid(`分镜「${shot.title}」选用了已拒绝的候选`)
      }
      validateClipRange(clip, asset)
      if (!existsSync(asset.path)) invalid(`分镜「${shot.title}」素材文件不存在`)
      if (asset.kind === 'video') {
        let actualDuration: number
        try { actualDuration = probeVideoDurationMs(asset.path) } catch { invalid(`分镜「${shot.title}」无法读取视频时长`) }
        if (clip.out_ms > actualDuration) invalid(`分镜「${shot.title}」片段超出视频素材时长`)
      }
      return { title: shot.title, asset_id: clip.asset_id, in_ms: clip.in_ms,
        out_ms: clip.out_ms, source_duration_ms: clip.source_duration_ms,
        source_audio_gain: clip.source_audio_gain, source_audio_fade_ms: clip.source_audio_fade_ms }
    })
    const jobId = newId(), timestamp = now()
    run("INSERT INTO jobs VALUES (?, ?, NULL, NULL, 'export', ?, 'queued', NULL, NULL, NULL, ?, ?)", jobId, id,
      JSON.stringify({ project, production_range: range, clips: renderClips }), timestamp, timestamp)
    return required<Job>('jobs', jobId)
  })
  app.post('/api/jobs/:id/retry', async request => {
    const { id } = parse(idParams, request.params)
    const job = required<Job>('jobs', id)
    if (job.status !== 'failed') invalid('只能重试失败任务')
    if (job.job_type === 'generation') {
      const model = job.model_id ? one<Model>('SELECT * FROM models WHERE id=?', job.model_id) : undefined
      const recovery = one('SELECT 1 FROM job_image_recovery WHERE job_id=?', id)
      if (model?.modality === 'image' && !recovery) invalid('图片生成结果未保存；厂商可能已计费。请先核对厂商记录，再手动创建新的生成任务。')
      const provider = model ? one<Provider>('SELECT * FROM providers WHERE id=?', model.provider_id) : undefined
      if (!recovery && (!model?.enabled || model.archived || !provider?.enabled || provider.archived || provider.adapter === 'demo')) invalid('模型或提供商已停用，无法重试')
    }
    const data = parse(retryJobInput, request.body || {})
    let jobRequest = job.request
    if (data.prompt && job.job_type === 'generation') {
      try {
        const parsed = JSON.parse(job.request) as Record<string, unknown>
        parsed.prompt = data.prompt
        jobRequest = JSON.stringify(parsed)
      } catch { invalid('任务请求记录损坏，无法修改提示词') }
    }
    run("UPDATE jobs SET request=?, status='queued', error=NULL, updated_at=? WHERE id=?", jobRequest, now(), id)
    return jobPublic(required<Job>('jobs', id))
  })

  const webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url))
  app.get('/', async (_request, reply) => {
    const index = join(webDist, 'index.html')
    return existsSync(index) ? reply.type('text/html').send(createReadStream(index)) : { message: '请运行前端开发服务器 npm run dev' }
  })
  app.get('/*', async (request, reply) => {
    const path = (request.params as { '*': string })['*']
    if (path.startsWith('api/')) return reply.code(404).send({ detail: '接口不存在' })
    const target = resolve(webDist, path)
    if (target.startsWith(resolve(webDist) + sep) && existsSync(target) && statSync(target).isFile()) {
      return reply.type(mime[extname(target).toLowerCase()] || 'application/octet-stream').send(createReadStream(target))
    }
    const index = join(webDist, 'index.html')
    return existsSync(index) ? reply.type('text/html').send(createReadStream(index)) : reply.code(404).send({ detail: '页面不存在' })
  })
  return app
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = buildApp()
  const stopWorker = startWorker()
  const port = Number(process.env.PORT || 8000)
  app.listen({ host: '127.0.0.1', port }).then(address => console.log(`视频创作服务: ${address}`)).catch(error => { stopWorker(); console.error(error); process.exitCode = 1 })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopWorker(); void app.close().finally(() => process.exit()) })
}
