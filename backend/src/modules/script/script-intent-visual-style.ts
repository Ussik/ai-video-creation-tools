import type { z } from 'zod'
import type { Project } from '../../infrastructure/database/db.js'
import { assertStyleVersion, projectVisualStyle } from '../visuals/project-visual-style.js'
import { activityPreview, type activityRecorder } from './script-activity.js'
import { documentTools, storyDecisions, type ScriptSnapshot } from './script-document-tools.js'
import { scriptSettingsSchema, type ScriptIntent } from './script-intent.js'
import { directorStageContext } from './script-workflow.js'

type ScriptSettings = z.infer<typeof scriptSettingsSchema>
type Options = {
  project: Project
  script: () => ScriptSnapshot
  messages: Array<{ role: 'user' | 'assistant'; text: string }>
  intent: ScriptIntent
  expectedVersion: string
  activity: ReturnType<typeof activityRecorder>
  onEvent: (event: Record<string, unknown>) => void
  signal?: AbortSignal
  beforeSave?: () => void
  onSaved?: () => void
}

/** Persist an intent's current creator-sourced style before continuing its task.
 * Missing provenance keeps the existing tool conversation in charge of saving. */
export async function syncIntentVisualStyle(options: Options): Promise<{ generation_options: ScriptSettings; changed: boolean } | undefined> {
  const { intent, messages, script, signal, activity } = options
  const name = intent.settings_patch.visual_style?.trim()
  const source = intent.visual_style_source
  if (!name || !source || !Number.isInteger(source.message_index) || source.message_index < 0 || source.message_index > 31 || !source.quote.trim()) return
  let latestUserIndex = messages.length - 1
  while (latestUserIndex >= 0 && messages[latestUserIndex]!.role !== 'user') latestUserIndex--
  const message = messages[source.message_index]
  if (source.message_index !== latestUserIndex || message?.role !== 'user' || !message.text.includes(source.quote)) return

  signal?.throwIfAborted()
  const args = {
    expected_version: options.expectedVersion,
    name,
    details: intent.settings_patch.visual_style_details || {},
    source_message_index: source.message_index,
    basis: 'creator_confirmed' as const,
  }
  const tools = documentTools({ project: options.project, script, stage: directorStageContext(script()), messages,
    checkApproval: async () => false, onEvent: options.onEvent, onVisualStyleSaved: options.onSaved, signal })
  const entry = activity.start({ kind: 'tool', scope: 'step', step_id: 'confirmed_visual_style_sync', name: 'set_project_visual_style', label: '保存已确认画风',
    summary: '将本轮明确的画风与来源同步到项目设置', ...activityPreview(args, 'input') })
  try {
    signal?.throwIfAborted()
    const current = projectVisualStyle(options.project.id)
    assertStyleVersion(current, options.expectedVersion)
    options.beforeSave?.()
    const sameDetails = (['medium', 'rendering', 'linework', 'palette'] as const).every(key => (current.details[key] || '') === (args.details[key] || '')) &&
      JSON.stringify(current.details.exclusions || []) === JSON.stringify(args.details.exclusions || [])
    const confirmed = storyDecisions(options.project.id).some(decision => decision.topic === '视觉风格' && decision.basis === 'creator_confirmed' && decision.source_text === message.text)
    if (current.source === 'settings' && current.label === name && sameDetails && confirmed) {
      options.onSaved?.()
      const generation_options = scriptSettingsSchema.parse(script().generation_options)
      activity.finish(entry, 'succeeded', { reused: true, summary: `沿用本轮已保存的项目画风：${name}`,
        ...activityPreview({ saved: true, reused: true, project_visual_style: current, document_saved: false }, 'output') })
      return { generation_options, changed: false }
    }
    // The existing tool checks cancellation and the pre-intent style version
    // immediately before its synchronous, transactional settings write.
    const output = await tools.execute('set_project_visual_style', args)
    const generation_options = scriptSettingsSchema.parse(script().generation_options)
    activity.finish(entry, 'succeeded', { summary: `项目画风已保存：${name}`, ...activityPreview(output, 'output') })
    return { generation_options, changed: true }
  } catch (error) {
    activity.finish(entry, signal?.aborted ? 'cancelled' : 'failed', {
      summary: error instanceof Error ? error.message : String(error),
      ...activityPreview({ error: error instanceof Error ? error.message : String(error) }, 'output'),
    })
    throw error
  }
}
