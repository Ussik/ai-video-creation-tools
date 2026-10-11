import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Select } from '@mantine/core'
import {
  ArrowDown,
  ArrowUp,
  PanelRight,
  PanelBottomClose,
  PanelBottomOpen,
  Maximize2,
  Plus,
  Square,
  Clapperboard,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileText,
  History,
  LoaderCircle,
  MessageCirclePlus,
  Minus,
  PenLine,
  Settings2,
  UserRound,
  MapPin,
  Package,
  WandSparkles,
  Copy,
  RotateCcw,
  CheckCircle2,
  X,
  Target,
  Users,
  Clock3,
  Lightbulb,
  Palette,
} from 'lucide-react'
import { api, json } from './api'
import type { Asset, Job, Model, ProjectDetail, Provider, ScriptArtifact, ScriptArtifactType, ScriptGenerationOptions } from './api'
import type { ScriptAction } from './ProjectCanvas'
import CreativeSkillSelector from './CreativeSkillSelector'
import { useCreativeSkills } from './useCreativeSkills'
import StoryboardPlanner from './StoryboardPlanner'
import './script-director.css'
import './script-director-chat.css'
import './director-documents.css'
import DirectorQuestionPanel from './DirectorQuestionPanel'
import DirectorMessageTiming, { finishMessageTiming, type MessageTiming } from './DirectorMessageTiming'
import DirectorActivity from './DirectorActivity'
import { activityDraftId, canRetryExecution, conversationMessage, readActivity, updateActivity, settleActivity, type ScriptActivity, type ScriptExecution } from './director-activity'
import type { ScriptActivityTarget } from '../../backend/src/script-activity-types'
import { createStreamScope, directorStreamIdleTimeoutMs } from '../../backend/src/script-stream-policy'
import { directorModes, directorModeProfiles, directorModeInstructions, type DirectorMode } from '../../backend/src/script-creation-mode'
import type { CreationNextStep, ScriptCreationState } from '../../backend/src/script-creation-state-types'
import type { ResourceChange } from '../../backend/src/script-resource-types'
import type { DocumentReview } from '../../backend/src/script-review-types'
import DirectorReviewReport from './DirectorReviewReport'
import DirectorReferences from './DirectorReferences'
import { addReference, readReferences, referenceMessages, type DirectorReference } from './director-references'
import DirectorDraftReview, { DirectorDocumentBody, DirectorSceneList, RevisionProgress } from './DirectorDocuments'
import { restoreChoiceAnswer, choiceAnswerText, type ChoiceAnswer } from './DirectorQuestionPanel'
import { parseMessageChoices } from './director-choices'
import ScriptMessageContent from './ScriptMessageContent'
import { clampDirectorWindow, defaultDirectorWindow, shouldSendDirectorMessage, type DirectorWindowRect } from './director-window'
import { ScriptThemeWaterCanvas as WebGLScriptThemeWaterCanvas } from './ScriptThemeWaterCanvas'
import { artifactKey, workflowLabels, workflowStages, workflowProgress, directorStageContext, type DirectorStageContext } from './script-workflow'
import { workflowInstruction, workflowRequestForStage, type WorkflowDraft, type WorkflowRequest, type WorkflowStage } from './script-workflow'
import { canAdoptReply, classificationBatch, classificationKey, followingMessages, replyRecognitionState, activeReplyChoice, replyChoices, replyDisplayText, replyClassificationVersion, contextualReplyTypes, type ReplyClassification } from './script-reply'
import { regenerationSource } from './director-regeneration'
import { directorChatContext } from './director-chat-context'
import { documentTaskPrompt, toolDraftArtifacts, toolDraftScenes, toolDraftStage, toolDraftOutcome, editedToolDraft, type DocumentAction, type ScriptToolDraft, type StoryDecision } from './script-tools'
import type { RevisionTask } from '../../backend/src/script-revision-types'
import { useThemeVisuals } from './useThemeVisuals'
import { isScriptThemeCategory, neutralThemeArtwork, scriptThemeArtwork, scriptThemeCategories } from '../../backend/src/script-theme-catalog'
import './script-theme-visuals.css'
import './script-director-settings.css'

type GeneratedScene = {
  episode_number?: number
  heading: string
  location: string
  time_of_day: string
  characters: string
  action: string
  dialogue: string
  narration: string
  duration: number
}

type GeneratedArtifact = {
  episode_number?: number
  artifact_type: ScriptArtifactType
  title: string
  content: string
}

type GeneratedScript = {
  source_message_id?: string
  workflow?: WorkflowRequest
  tool_draft?: ScriptToolDraft
  resource_changes?: ResourceChange[]
  generation_options?: ScriptGenerationOptions
  outline: string
  characters: string
  scenes: GeneratedScene[]
  artifacts: GeneratedArtifact[]
}

type Message = MessageTiming & {
  id: string
  role: 'assistant' | 'user'
  text: string
  pending?: boolean
  failed?: boolean
  activity?: ScriptActivity[]
  execution?: ScriptExecution
  has_reply_text?: boolean
  reference_documents?: DirectorReference[]
  question_response?: { status: 'skipped' | 'answered'; question: string }
  stage_context?: DirectorStageContext
  classification?: ReplyClassification
  classification_version?: number
  classification_context?: string
  classification_source?: 'function_call' | 'model_extraction' | 'application'
  review?: DocumentReview
}

function isStructuredChoiceStream(text: string): boolean {
  const prefix = text.trimStart()
  return prefix.startsWith('{') || prefix.startsWith('```') || /"kind"\s*:\s*"(?:choices|input_request|confirmation|question_set)"/.test(prefix)
}

type StreamEvent = {
  execution_outcome?: ScriptExecution['outcome']
  task?: RevisionTask
  draft_id?: string
  completion_kind?: 'creator_interaction' | 'draft_review' | 'next_step' | 'explanation'
  creation?: ScriptCreationState
  activity?: ScriptActivity | ScriptActivity[]
  stage_context?: DirectorStageContext
  workflow?: WorkflowRequest
  generation_options?: ScriptGenerationOptions
  draft?: WorkflowDraft
  tool_draft?: ScriptToolDraft | null
  classification?: ReplyClassification
  classification_version?: number
  classification_source?: 'function_call' | 'model_extraction' | 'application'
  review?: DocumentReview
  project_changed?: boolean
  type?: string
  text?: string
  delta?: string
  reply?: string
  label?: string
  stage?: string
  summary?: string
  message?: string
}

class StreamUnavailableError extends Error {}

type ConversationSnapshot = {
  id: string
  label: string
  messages: Message[]
}

type PersistedConversation = {
  id: string
  label: string
  messages: Array<Pick<Message, 'id' | 'role' | 'text' | 'reference_documents' | 'processing_duration_ms' | 'stage_context' | 'classification' | 'classification_version' | 'classification_context' | 'classification_source' | 'review' | 'activity' | 'execution'>>
  updated_at?: string
}


const welcomeMessage: Message = {
  id: 'welcome', role: 'assistant',
  text: '我会和你一起完成剧本。先聊故事方向、人物和希望呈现的情绪，准备好后再整理成分场剧本。',
}

function directorStorageKey(projectId: string) {
  return `script-director-conversations:${projectId}`
}

function loadDirectorState(projectId: string): { messages: Message[]; history: ConversationSnapshot[] } {
  try {
    const value = window.localStorage.getItem(directorStorageKey(projectId))
    if (!value) return { messages: [welcomeMessage], history: [] }
    const parsed = JSON.parse(value) as { messages?: Message[]; history?: ConversationSnapshot[] }
    const messages = Array.isArray(parsed.messages) ? parsed.messages.filter((item) =>
      item && typeof item.id === 'string' && (item.role === 'assistant' || item.role === 'user') && typeof item.text === 'string' && !item.pending,
    ).slice(-80) : []
    const history = Array.isArray(parsed.history) ? parsed.history.filter((item) =>
      item && typeof item.id === 'string' && typeof item.label === 'string' && Array.isArray(item.messages),
    ).slice(0, 20) : []
    return { messages: messages.length ? messages : [welcomeMessage], history }
  } catch {
    return { messages: [welcomeMessage], history: [] }
  }
}

function scriptExists(detail: ProjectDetail): boolean {
  return Boolean(detail.brief?.trim() || detail.script?.outline?.trim() || detail.script?.characters?.trim() || detail.script?.scenes?.length)
}

export interface ScriptDirectorPanelProps {
  detail: ProjectDetail
  models: Model[]
  providers: Provider[]
  focusArtifact?: ScriptAction
  initialContext?: string
  openRequestId?: number
  hidden?: boolean
  onRefresh: () => Promise<unknown>
  onClose: () => void
  onOpenModels: () => void
  onOpenDocument?: (artifact: ScriptArtifact) => void
  onNotice: (message: string) => void
}

const emptyOptions: ScriptGenerationOptions = {
  genre: '',
  genre_fusion: '',
  audience: '',
  era: '',
  character_notes: '',
  core_hook: '',
  visual_style: '',
  story_structure: '',
  episode_count: 20,
}

function normaliseScene(scene: Partial<GeneratedScene>): GeneratedScene {
  return {
    ...(scene.episode_number !== undefined ? { episode_number: scene.episode_number } : {}),
    heading: typeof scene.heading === 'string' ? scene.heading : '',
    location: typeof scene.location === 'string' ? scene.location : '',
    time_of_day: typeof scene.time_of_day === 'string' ? scene.time_of_day : '',
    characters: typeof scene.characters === 'string' ? scene.characters : '',
    action: typeof scene.action === 'string' ? scene.action : '',
    dialogue: typeof scene.dialogue === 'string' ? scene.dialogue : '',
    narration: typeof scene.narration === 'string' ? scene.narration : '',
    duration: typeof scene.duration === 'number' && Number.isFinite(scene.duration)
      ? Math.max(1, Math.min(30, Math.round(scene.duration))) : 5,
  }
}

const generatedArtifactTitles: Record<ScriptArtifactType, string> = {
  outline: '故事大纲', synopsis: '故事简述', world: '背景设定', characters: '人物小传',
  relationships: '人物关系', locations: '场景设计', props: '道具设计', structure: '全剧分段',
  hooks: '钩子预设', foreshadowing: '伏笔预设', reversals: '反转预设', constraints: '创作禁区',
  episode_outline: '全剧分集大纲', episode_script: '单集正文',
}

function normaliseArtifact(artifact: Partial<GeneratedArtifact>): GeneratedArtifact | null {
  const type = artifact.artifact_type
  if (!type || !(type in generatedArtifactTitles) || typeof artifact.content !== 'string' || !artifact.content.trim()) return null
  return {
    artifact_type: type,
    ...(artifact.episode_number !== undefined ? { episode_number: artifact.episode_number } : {}),
    title: typeof artifact.title === 'string' && artifact.title.trim() ? artifact.title.trim() : generatedArtifactTitles[type],
    content: artifact.content.trim(),
  }
}

function restoreWorkflowDraft(projectId: string): GeneratedScript | null {
  try {
    const source = window.localStorage.getItem(`script-director-draft:${projectId}`)
    if (!source || source.length > 500000) return null
    const value = JSON.parse(source) as GeneratedScript
    if (((!value.workflow || !workflowStages.includes(value.workflow.stage)) && !value.tool_draft?.id) || !Array.isArray(value.artifacts) || !Array.isArray(value.scenes)) return null
    if (value.workflow?.stage === 'episode' && (!Number.isInteger(value.workflow.episode_number) || value.workflow.episode_number < 1 || value.workflow.episode_number > 200)) return null
    return {
      ...(value.workflow ? { workflow: workflowRequestForStage(value.workflow.stage, value.workflow.episode_number, value.workflow.target_duration) } : {}),
      ...(value.tool_draft ? { tool_draft: value.tool_draft } : {}),
      ...(Array.isArray(value.resource_changes) ? { resource_changes: value.resource_changes } : {}),
      ...(typeof value.source_message_id === 'string' ? { source_message_id: value.source_message_id } : {}),
      ...(value.generation_options && typeof value.generation_options === 'object' ? { generation_options: value.generation_options } : {}),
      outline: typeof value.outline === 'string' ? value.outline : '',
      characters: typeof value.characters === 'string' ? value.characters : '',
      artifacts: value.artifacts.filter(item => item && typeof item === 'object').map(normaliseArtifact).filter((item): item is GeneratedArtifact => item !== null),
      scenes: value.scenes.filter(item => item && typeof item === 'object').map(normaliseScene),
    }
  } catch { return null }
}

function optionsFromDetail(detail: ProjectDetail): ScriptGenerationOptions {
  return { ...emptyOptions, ...(detail.script?.generation_options || {}) }
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError')
}

function parseStreamEvent(raw: string): StreamEvent | null {
  const value = raw.trim()
  if (!value || value === '[DONE]') return null
  const data = value.startsWith('data:') ? value.slice(5).trim() : value
  if (!data || data === '[DONE]') return null
  try {
    const parsed = JSON.parse(data) as StreamEvent
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    // A provider may emit plain text chunks. Treat them as response deltas.
    return { type: 'delta', text: data }
  }
}

function promptForMode(prompt: string, mode: DirectorMode): string {
  return `${prompt.trim()}\n\n${directorModeInstructions(mode)}`
}

const directorStoryStructures = [
  '三幕式',
  '五幕式',
  '英雄旅程',
  '平行结构',
  '交叉结构',
  '非线性结构',
  '环形结构',
  '单元结构',
]

function DirectorStructurePicker({
  value,
  episodeCount,
  open,
  onToggle,
  onChange,
  onEpisodeCountChange,
}: {
  value: string
  episodeCount?: number
  open: boolean
  onToggle: () => void
  onChange: (value: string) => void
  onEpisodeCountChange: (value: number) => void
}) {
  const count = Number.isFinite(episodeCount) ? Math.max(1, Math.min(200, Math.round(episodeCount as number))) : 20
  return <div className={`script-director-structure-picker${open ? ' is-open' : ''}`}>
    <button type="button" className="script-director-structure-card" onClick={onToggle} aria-expanded={open} aria-haspopup="dialog">
      <span className="script-director-setting-heading">
        <Clapperboard size={14} aria-hidden="true" />
        <span className="script-director-structure-label">剧本结构</span>
        <ChevronDown size={13} className="script-director-structure-chevron" aria-hidden="true" />
      </span>
      <span className="script-director-structure-summary">
        <span className={`script-director-structure-value${value ? '' : ' is-auto'}`}>{value || '自动判断'}</span>
        <span className="script-director-structure-meta">{episodeCount ? `${count} 集` : '集数自动判断'}</span>
      </span>
    </button>
    {open && <div className="script-director-structure-popover" role="dialog" aria-label="剧本结构与集数">
      <div className="script-director-structure-popover-head"><strong>剧本结构</strong><span>选择叙事节奏</span></div>
      <div className="script-director-structure-options" role="group" aria-label="结构选项">
        {directorStoryStructures.map((structure) => <button
          type="button"
          key={structure}
          className={value === structure ? 'is-selected' : ''}
          aria-pressed={value === structure}
          onClick={() => onChange(structure)}
        >{structure}</button>)}
      </div>
      <div className="script-director-episode-control">
        <div className="script-director-episode-head"><span>预计集数</span><strong>{count} 集</strong></div>
        <input
          type="range"
          min="1"
          max="200"
          step="1"
          value={count}
          aria-label="预计集数"
          onChange={(event) => onEpisodeCountChange(Number(event.currentTarget.value))}
        />
        <div className="script-director-episode-scale"><span>1</span><span>200</span></div>
      </div>
    </div>}
  </div>
}

type DirectorAutoFieldProps = {
  label: string
  value?: string
  placeholder: string
  options: string[]
  icon: typeof Target
  open: boolean
  onToggle: () => void
  onChange: (value: string) => void
}

function DirectorAutoField({ label, value, placeholder, options, icon: Icon, open, onToggle, onChange }: DirectorAutoFieldProps) {
  return <div className={`script-director-auto-field${open ? ' is-open' : ''}`}>
    <button type="button" className="script-director-auto-card" onClick={onToggle} aria-expanded={open} aria-haspopup="dialog">
      <span className="script-director-setting-heading">
        <Icon size={14} aria-hidden="true" />
        <small>{label}</small>
        <ChevronDown size={13} className="script-director-auto-chevron" aria-hidden="true" />
      </span>
      <strong className={`script-director-setting-value${value ? '' : ' is-auto'}`}>{value || '自动'}</strong>
    </button>
    {open && <div className="script-director-auto-popover" role="dialog" aria-label={`${label}选项`}>
      <div className="script-director-auto-popover-head"><strong>{label}</strong><span>可选，也可以交给模型判断</span></div>
      <div className="script-director-auto-options">
        <button type="button" className={!value ? 'is-selected' : ''} onClick={() => onChange('')}>自动</button>
        {options.map((option) => <button type="button" key={option} className={value === option ? 'is-selected' : ''} onClick={() => onChange(option)}>{option}</button>)}
      </div>
      <input value={value || ''} placeholder={placeholder} onChange={(event) => onChange(event.currentTarget.value)} aria-label={`自定义${label}`} />
    </div>}
  </div>
}

type InfiniteThemeRailProps = {
  items: string[]
  selected: string
  side: 'primary' | 'fusion'
  onSelect: (theme: string) => void
  activeArtwork?: string
}

/**
 * A compact, looping topic picker. Five entries stay mounted so adjacent
 * topics can glide into the center while wheel, keyboard, buttons, and a
 * short vertical drag move through the same circular list.
 */
function InfiniteThemeRail({ items, selected, side, onSelect, activeArtwork }: InfiniteThemeRailProps) {
  const railStep = 52
  const dragStart = useRef<number | null>(null)
  const dragMoved = useRef(false)
  const dragOffsetRef = useRef(0)
  const cursorRef = useRef(0)
  const wheelOffsetRef = useRef(0)
  const wheelResetTimer = useRef<number | null>(null)
  const [railOffset, setRailOffset] = useState(0)
  const values = items.filter(Boolean)
  const valuesKey = values.join('\u0001')
  useEffect(() => {
    if (!values.length) {
      cursorRef.current = 0
      return
    }
    const next = selected && values.includes(selected)
      ? Math.max(0, values.indexOf(selected))
      : Math.min(cursorRef.current, values.length - 1)
    cursorRef.current = next
  }, [selected, valuesKey])
  if (!values.length) return null
  const selectedIndex = selected && values.includes(selected)
    ? Math.max(0, values.indexOf(selected))
    : Math.min(cursorRef.current, values.length - 1)
  const activeSelection = values[selectedIndex]!
  const move = (delta: number) => {
    const nextIndex = (cursorRef.current + delta + values.length) % values.length
    cursorRef.current = nextIndex
    const nextTheme = values[nextIndex]!
    onSelect(nextTheme === '其他' ? '' : nextTheme)
  }
  const choose = (theme: string) => {
    const nextIndex = values.indexOf(theme)
    if (nextIndex >= 0) cursorRef.current = nextIndex
    onSelect(theme === '其他' ? '' : theme)
  }
  // Keep adjacent entries mounted while the center changes so the CSS
  // position transition can carry the rail from one topic to the next.
  const visible = Array.from({ length: 5 }, (_, slot) => {
    const offset = slot - 2
    const index = (selectedIndex + offset + values.length) % values.length
    return { theme: values[index]!, offset }
  })
  return <nav
    className={`script-director-theme-rail is-infinite is-${side}`}
    data-dragging={railOffset !== 0 ? 'true' : undefined}
    aria-label={side === 'primary' ? '主题材选择' : '融合题材选择'}
    onWheel={(event) => {
      event.preventDefault()
      if (Math.abs(event.deltaY) < 0.5) return
      let nextOffset = wheelOffsetRef.current - event.deltaY
      let steps = 0
      while (nextOffset <= -railStep) {
        nextOffset += railStep
        steps += 1
      }
      while (nextOffset >= railStep) {
        nextOffset -= railStep
        steps -= 1
      }
      wheelOffsetRef.current = nextOffset
      if (steps) move(steps)
      setRailOffset(nextOffset)
      if (wheelResetTimer.current !== null) window.clearTimeout(wheelResetTimer.current)
      wheelResetTimer.current = window.setTimeout(() => {
        wheelOffsetRef.current = 0
        setRailOffset(0)
        wheelResetTimer.current = null
      }, 150)
    }}
    onKeyDown={(event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        event.preventDefault()
        move(1)
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        event.preventDefault()
        move(-1)
      }
    }}
    onPointerDown={(event) => {
      dragStart.current = event.clientY
      dragMoved.current = false
      dragOffsetRef.current = 0
      setRailOffset(0)
      if (wheelResetTimer.current !== null) {
        window.clearTimeout(wheelResetTimer.current)
        wheelResetTimer.current = null
      }
      wheelOffsetRef.current = 0
      // Let native button clicks reach the item. Pointer capture on the nav
      // itself would swallow the click before the fusion choice can commit.
      if (!(event.target as HTMLElement).closest('button')) event.currentTarget.setPointerCapture(event.pointerId)
    }}
    onPointerMove={(event) => {
      if (dragStart.current === null) return
      const delta = event.clientY - dragStart.current
      if (Math.abs(delta) < 3) return
      dragMoved.current = true
      const nextOffset = Math.max(-railStep * 2, Math.min(railStep * 2, delta))
      dragOffsetRef.current = nextOffset
      setRailOffset(nextOffset)
    }}
    onPointerUp={() => {
      const steps = Math.round(-dragOffsetRef.current / railStep)
      if (steps) move(steps)
      dragStart.current = null
      dragOffsetRef.current = 0
      setRailOffset(0)
      window.setTimeout(() => { dragMoved.current = false }, 0)
    }}
    onPointerCancel={() => {
      dragStart.current = null
      dragOffsetRef.current = 0
      setRailOffset(0)
      dragMoved.current = false
    }}
    tabIndex={0}
  >
    <button type="button" className="script-director-theme-rail-nudge is-prev" onClick={() => move(-1)} aria-label="上一个题材"><ChevronUp size={13} /></button>
    <div className="script-director-theme-rail-viewport">
      {visible.map(({ theme, offset }) => {
        const active = offset === 0 && theme === activeSelection && Boolean(selected)
        const committed = active
        return <button
          type="button"
          key={theme}
          className={`script-director-theme-rail-item${active ? ` is-${side}` : ''}`}
          data-offset={offset}
          style={{ '--rail-y': `${offset * railStep}px`, '--rail-drag-y': `${railOffset}px` } as CSSProperties}
          onClick={() => {
            if (dragMoved.current) return
            choose(theme)
          }}
          aria-current={active ? 'true' : undefined}
        >
          {side === 'primary' && active && <span className="script-director-theme-rail-caret" aria-hidden="true">◀</span>}
          {side === 'fusion' && active && <span className="script-director-theme-rail-caret" aria-hidden="true">▶</span>}
          {theme === '其他' ? <span className="script-director-theme-other-icon" aria-hidden="true"><PenLine size={15} /></span> : (() => {
            const artwork = active && activeArtwork ? activeArtwork : directorArtworkForTheme(theme)
            return <span className={`script-director-theme-dot tone-${directorThemeTone(theme)}`} style={artwork ? { backgroundImage: `url("${artwork}")` } : undefined} />
          })()}
          <span>{theme}</span>
          {committed && <small>{side === 'primary' ? '主' : '融'}</small>}
        </button>
      })}
    </div>
    <button type="button" className="script-director-theme-rail-nudge is-next" onClick={() => move(1)} aria-label="下一个题材"><ChevronDown size={13} /></button>
    {side === 'primary' && <button type="button" className="script-director-theme-other" onClick={() => onSelect('')}><PenLine size={12} />其他</button>}
  </nav>
}

// Top 8 has its own ranked cover. The selected rail and waterball continue
// to use the shared 玄幻修仙 topic artwork.
const directorTop8Artwork = '/topic-art/covers/top/top-8.jpg'

const directorSettingPresets: Array<{ label: string; values: Partial<ScriptGenerationOptions>; artwork?: string }> = [
  { label: '玄幻修仙逆袭', artwork: '/topic-art/covers/top/top-1.jpg', values: { genre: '玄幻修仙', core_hook: '身份反转、成长与热血对决', visual_style: '东方幻想、电影感光影', story_structure: '成长线与主线谜团交织' } },
  { label: '现实职场成长', artwork: '/topic-art/covers/top/top-2.jpg', values: { genre: '都市现实', audience: '成年观众', core_hook: '现实困境与人物成长', visual_style: '写实、克制、自然光' } },
  { label: '末世生存基建', artwork: '/topic-art/covers/top/top-3.jpg', values: { genre: '末世科幻', core_hook: '资源争夺与团队协作', visual_style: '冷峻工业感、低饱和色彩', era: '灾变后的近未来' } },
  { label: '非遗国潮视觉', artwork: '/topic-art/covers/top/top-4.jpg', values: { genre: '文旅非遗', visual_style: '国风、手工质感、鲜明色彩', core_hook: '传统技艺与当代生活相遇' } },
  { label: '古代女频甜宠', artwork: '/topic-art/covers/top/top-5.jpg', values: { genre: '古装言情', audience: '女性观众', visual_style: '古典质感、柔和光影', core_hook: '双向奔赴与身份秘密' } },
  { label: '规则怪谈悬疑', artwork: '/topic-art/covers/top/top-6.jpg', values: { genre: '悬疑推理', core_hook: '规则陷阱、线索递进与反转', story_structure: '逐层升级，结尾回收线索' } },
  { label: '重生复仇爽剧', artwork: '/topic-art/covers/top/top-7.jpg', values: { genre: '重生复仇', audience: '成年观众', core_hook: '信息差、反击与连续爽点', story_structure: '阶段性反转与目标升级' } },
  { label: '仙门团宠日常', artwork: directorTop8Artwork, values: { genre: '玄幻修仙', audience: '泛人群', core_hook: '轻喜剧群像与日常冒险', visual_style: '明快国风动画' } },
]

const directorThemeChoices = [...scriptThemeCategories, '其他']

// Keep the first open of the settings dialog useful even when a project has
// no saved generation options yet. The fusion default is selected when the
// user explicitly adds the second topic, so opening the dialog still shows a
// single stable anchor orb.
const defaultPrimaryTheme = '玄幻修仙'
const defaultFusionTheme = '都市现实'

function directorArtworkForTheme(theme: string): string {
  return isScriptThemeCategory(theme) ? scriptThemeArtwork[theme] : neutralThemeArtwork
}

function ScriptThemeWaterCanvas({ primary, fusion, primaryArtwork, fusionArtwork, active, onFusionSettled }: { primary: string; fusion: string; primaryArtwork?: string; fusionArtwork?: string; active: boolean; onFusionSettled?: (hasFusion: boolean) => void }) {
  return <WebGLScriptThemeWaterCanvas
    primary={primary}
    fusion={fusion}
    primaryArtwork={primaryArtwork || directorArtworkForTheme(primary)}
    fusionArtwork={fusionArtwork || directorArtworkForTheme(fusion)}
    active={active}
    onFusionSettled={onFusionSettled}
  />
}

function directorThemeTone(value: string): string {
  const tones: Record<string, string> = {
    '玄幻修仙': 'fantasy', '都市现实': 'city', '古装言情': 'heritage', '历史传奇': 'heritage',
    '文旅非遗': 'culture', '悬疑推理': 'thriller', '惊悚怪谈': 'thriller', '犯罪谍战': 'crime', '重生复仇': 'crime',
    '家庭伦理': 'family', '末世科幻': 'future', '喜剧': 'comedy', '体育竞技': 'sports', '主旋律': 'hero',
  }
  return tones[value] || 'neutral'
}

const directorAutoFieldOptions: Record<'audience' | 'character_notes' | 'era' | 'core_hook' | 'visual_style', string[]> = {
  audience: ['男频', '女频', '泛人群', '出海', '银发'],
  character_notes: ['单主角', '双主角', '群像', '成长型主角'],
  era: ['当代', '近未来', '古代', '架空世界', '灾变之后'],
  core_hook: ['成长', '反转', '动作', '情感', '悬念'],
  visual_style: ['电影感', '二维动画', '国风幻想', '写实', '低饱和'],
}

const directorAutoFieldMeta: Array<{
  key: 'audience' | 'character_notes' | 'era' | 'core_hook' | 'visual_style'
  label: string
  placeholder: string
  icon: typeof Target
}> = [
  { key: 'audience', label: '目标受众', placeholder: '例如：全年龄、成年观众', icon: Target },
  { key: 'character_notes', label: '角色设定', placeholder: '例如：双主角、群像', icon: Users },
  { key: 'era', label: '时代背景', placeholder: '例如：当代沿海小城', icon: Clock3 },
  { key: 'core_hook', label: '核心看点', placeholder: '例如：反转、成长、动作', icon: Lightbulb },
  { key: 'visual_style', label: '画风', placeholder: '例如：电影感、二维动画', icon: Palette },
]

const focusArtifactLabels: Record<ScriptAction, string> = {
  all: '全能创作',
  character: '角色视觉资产',
  location: '场景视觉资产',
  prop: '道具视觉资产',
}

const focusArtifactPrompts: Record<ScriptAction, string> = {
  all: '',
  character: '请读取剧本中的人物资料，整理主要角色的视觉设定，并告诉我生成角色图前还需要确认什么。',
  location: '请读取剧本中的场景资料，整理关键场景的空间、光线和氛围设定，并告诉我生成场景图前还需要确认什么。',
  prop: '请读取剧本中的道具资料，整理关键道具的外观、材质和剧情作用，并告诉我生成道具图前还需要确认什么。',
}

type AssetTaskStatus = 'idle' | 'analyzing' | 'awaiting-confirmation' | 'generating' | 'ready' | 'succeeded' | 'failed'

type AssetTaskMeta = {
  label: string
  noun: string
  description: string
  icon: typeof UserRound
  fields: string[]
}

const assetTaskMeta: Record<Exclude<ScriptAction, 'all'>, AssetTaskMeta> = {
  character: {
    label: '角色视觉资产', noun: '角色图', icon: UserRound,
    description: '从人物小传中提取外观、身份与情绪锚点，先确认角色资料，再生成统一的视觉提示词。',
    fields: ['角色身份', '外观特征', '服装与材质', '情绪与动作'],
  },
  location: {
    label: '场景视觉资产', noun: '场景图', icon: MapPin,
    description: '从分场中提取空间、时间和光线线索，先确认场景基调，再生成可复用的场景提示词。',
    fields: ['空间结构', '时间与天气', '光线氛围', '镜头视角'],
  },
  prop: {
    label: '道具视觉资产', noun: '道具图', icon: Package,
    description: '从剧情线索中提取道具的形制、材质与叙事作用，先确认关键细节，再生成道具提示词。',
    fields: ['道具名称', '形制材质', '关键细节', '剧情作用'],
  },
}

function sourceTextForAssetTask(detail: ProjectDetail, generated: GeneratedScript | null, focus: Exclude<ScriptAction, 'all'>): string {
  if (focus === 'character') return generated?.characters || generated?.artifacts.find((artifact) => artifact.artifact_type === 'characters')?.content || detail.script?.characters || '尚未整理人物小传。可以先在对话中补充人物身份、外观和关系。'
  if (focus === 'location') {
    const scenes = generated?.scenes || detail.script?.scenes || []
    const locations = scenes.map((scene) => [scene.heading, scene.location, scene.time_of_day, scene.action].filter(Boolean).join('｜')).filter(Boolean)
    return locations.length ? locations.slice(0, 4).join('\n') : '尚未整理场景资料。可以先在对话中补充地点、时间和氛围。'
  }
  const propsArtifact = generated?.artifacts.find((artifact) => artifact.artifact_type === 'props') || detail.script?.artifacts?.find((artifact) => artifact.artifact_type === 'props')
  return propsArtifact?.content || '尚未整理道具资料。可以先在对话中补充道具外观、材质和剧情作用。'
}

function AssetTaskCard({
  detail, generated, focus, status, prompt, imageModels, imageModelId, resultAsset, onImageModelChange, onPromptChange, onConfirm, onRetry, onGenerate, onSave, onCopy, onOpenModels,
}: {
  detail: ProjectDetail
  generated: GeneratedScript | null
  focus: Exclude<ScriptAction, 'all'>
  status: AssetTaskStatus
  prompt: string
  imageModels: Model[]
  imageModelId: string
  resultAsset?: Asset
  onImageModelChange: (value: string) => void
  onPromptChange: (value: string) => void
  onConfirm: () => void
  onRetry: () => void
  onGenerate: () => void
  onSave: () => void
  onCopy: () => void
  onOpenModels: () => void
}) {
  const meta = assetTaskMeta[focus]
  const Icon = meta.icon
  const source = sourceTextForAssetTask(detail, generated, focus)
  const statusLabel: Record<AssetTaskStatus, string> = {
    idle: '等待读取', analyzing: '正在读取剧本', 'awaiting-confirmation': '等待确认资料', generating: '正在生成任务', ready: '提示词已准备', succeeded: '已生成', failed: '生成失败',
  }
  const statusClass = status === 'analyzing' || status === 'generating' ? 'is-working' : status === 'ready' || status === 'succeeded' ? 'is-ready' : status === 'failed' ? 'is-failed' : ''
  return <section className={`script-director-asset-task ${statusClass}`} aria-label={meta.label}>
    <header className="script-director-asset-task-head">
      <div className="script-director-asset-task-title"><span className="script-director-asset-task-icon"><Icon size={15} /></span><div><strong>{meta.label}</strong><small>{meta.description}</small></div></div>
      <span className="script-director-asset-task-status"><i />{statusLabel[status]}</span>
    </header>
    <div className="script-director-asset-task-fields">{meta.fields.map((field) => <span key={field}>{field}</span>)}</div>
    <div className="script-director-asset-task-source"><div><FileText size={12} /><span>剧本资料</span></div><p>{source}</p></div>
    {(status === 'awaiting-confirmation' || status === 'idle') && <div className="script-director-asset-task-actions"><button type="button" className="script-director-task-secondary" onClick={onRetry}><WandSparkles size={13} />重新分析</button><button type="button" className="script-director-task-primary" onClick={onConfirm}><CheckCircle2 size={14} />确认资料并生成提示词</button></div>}
    {status === 'analyzing' && <div className="script-director-asset-task-progress"><LoaderCircle size={13} className="script-director-spinner" />正在从剧本中提取{meta.noun}所需信息…</div>}
    {status === 'generating' && <div className="script-director-asset-task-progress"><LoaderCircle size={13} className="script-director-spinner" />正在生成可直接使用的{meta.noun}提示词…</div>}
    {(status === 'ready' || status === 'succeeded' || status === 'failed') && <div className="script-director-asset-task-prompt"><div className="script-director-asset-task-prompt-head"><span>生成提示词（可编辑）</span><button type="button" onClick={onCopy}><Copy size={12} />复制</button></div><textarea value={prompt} onChange={(event) => onPromptChange(event.currentTarget.value)} placeholder={`等待模型生成${meta.noun}提示词…`} />
      {(status === 'ready' || status === 'failed' || status === 'succeeded') && (imageModels.length ? <div className="script-director-asset-task-generate-row"><Select size="xs" allowDeselect={false} value={imageModelId || null} placeholder="选择图片模型" data={imageModels.map((model) => ({ value: model.id, label: model.name }))} onChange={(value) => onImageModelChange(value || '')} /><button type="button" className="script-director-task-primary" onClick={onGenerate} disabled={!imageModelId || !prompt.trim()}><WandSparkles size={13} />重新生成{meta.noun}</button></div> : <button type="button" className="script-director-model-link" onClick={onOpenModels}>还没有可用的图片模型，前往模型设置添加</button>)}
      {status === 'succeeded' && resultAsset && <div className="script-director-asset-result"><img src={resultAsset.url} alt={`${meta.label}结果`} /><div><strong>{resultAsset.filename}</strong><span>{resultAsset.saved ? '已保存到资产' : '生成结果未保存'}</span></div><button type="button" className="script-director-task-secondary" onClick={onSave} disabled={resultAsset.saved}>{resultAsset.saved ? '已保存' : '保存资产'}</button></div>}
      {status === 'succeeded' && !resultAsset && <div className="script-director-asset-task-ready"><CheckCircle2 size={13} />任务已完成，正在刷新生成结果…</div>}
      {status === 'failed' && <div className="script-director-asset-task-ready is-error">生成失败，可修改提示词后重新提交</div>}
    </div>}
  </section>
}

function DirectorMessageText({ text }: { text: string }) {
  return <ScriptMessageContent text={text} />
}

function readWindowLayout() {
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  try {
    const value = JSON.parse(window.localStorage.getItem('script-director-window') || '') as { rect?: DirectorWindowRect; docked?: boolean }
    if (value.rect && [value.rect.x, value.rect.y, value.rect.width, value.rect.height].every(Number.isFinite)) {
      return { rect: clampDirectorWindow(value.rect, viewport), docked: value.docked === true }
    }
  } catch { /* Use the default window when preferences are unavailable. */ }
  return { rect: defaultDirectorWindow(viewport), docked: false }
}

function readQuestionState(projectId: string): { answers: Record<string, ChoiceAnswer>; dismissed: Record<string, boolean>; retryId: string | null } {
  const fallback = { answers: {}, dismissed: {}, retryId: null }
  try {
    const saved = JSON.parse(window.localStorage.getItem(`script-director-questions:${projectId}`) || '{}')
    const answers: Record<string, ChoiceAnswer> = {}
    for (const [id, value] of Object.entries(saved.answers || {}).slice(-160)) {
      const answer = restoreChoiceAnswer(value)
      if (answer) answers[id] = answer
    }
    const dismissed = Object.fromEntries(Object.entries(saved.dismissed || {}).filter(([, value]) => value === true).slice(-160)) as Record<string, boolean>
    return { answers, dismissed, retryId: typeof saved.retryId === 'string' ? saved.retryId : null }
  } catch { return fallback }
}

function readComposerDraft(projectId: string) {
  try { return (window.localStorage.getItem(`script-director-input:${projectId}`) || '').slice(0, 8000) }
  catch { return '' }
}

function ScriptDirectorPanel({ detail, models, providers, focusArtifact = 'all', initialContext, openRequestId, hidden = false, onRefresh, onClose, onOpenModels, onOpenDocument, onNotice }: ScriptDirectorPanelProps) {
  const [windowLayout, setWindowLayout] = useState(readWindowLayout)
  const [minimized, setMinimized] = useState(false)
  const [workflowOpen, setWorkflowOpen] = useState(false)
  const [composerMenuOpen, setComposerMenuOpen] = useState(false)
  const [composerCollapsed, setComposerCollapsed] = useState(false)
  const composerBodyId = useId()
  const [readerReference, setReaderReference] = useState<DirectorReference | null>(null)
  const [references, setReferences] = useState<DirectorReference[]>(() => {
    try { return readReferences(JSON.parse(window.localStorage.getItem(`script-director-references:${detail.id}`) || '[]')) } catch { return [] }
  })
  const [readerKey, setReaderKey] = useState<string | null>(null)
  const [readerView, setReaderView] = useState<'body' | 'scenes'>('body')
  const [documentTask, setDocumentTask] = useState<DocumentAction & { title: string } | null>(null)
  const [recoveringMessageId, setRecoveringMessageId] = useState<string | null>(null)
  const executionDraftIds = useRef(new Map<string, string>())
  const [decisions, setDecisions] = useState<StoryDecision[]>([])
  const [showLatest, setShowLatest] = useState(false)
  const [closing, setClosing] = useState(false)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const gestureRef = useRef<{ pointer: number; x: number; y: number; rect: DirectorWindowRect; resize: boolean } | null>(null)
  const availableModels = useMemo(() => models.filter((model) => {
    const provider = providers.find((item) => item.id === model.provider_id)
    return model.modality === 'text' && model.enabled && !!provider?.enabled && provider.adapter !== 'demo'
  }), [models, providers])
  const imageModels = useMemo(() => models.filter((model) => {
    const provider = providers.find((item) => item.id === model.provider_id)
    return model.modality === 'image' && model.enabled && !!provider?.enabled && provider.adapter !== 'demo'
  }), [models, providers])
  const [options, setOptions] = useState<ScriptGenerationOptions>(() => restoreWorkflowDraft(detail.id)?.generation_options || optionsFromDetail(detail))
  const [idea, setIdea] = useState(detail.brief || '')
  const [modelId, setModelId] = useState(() => { try { return window.localStorage.getItem(`script-director-model:${detail.id}`) || '' } catch { return '' } })
  const [activeFocus, setActiveFocus] = useState<ScriptAction>(focusArtifact)
  const [creation, setCreation] = useState<ScriptCreationState | null>(null)
  const creationRefreshId = useRef(0)
  const [mode, setMode] = useState<DirectorMode>('script')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showSettingPresets, setShowSettingPresets] = useState(true)
  const [structurePickerOpen, setStructurePickerOpen] = useState(false)
  const [autoFieldOpen, setAutoFieldOpen] = useState<DirectorAutoFieldProps['label'] | null>(null)
  const [fusionRailOpen, setFusionRailOpen] = useState(false)
  const [fusionExitActive, setFusionExitActive] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<ScriptGenerationOptions>(() => optionsFromDetail(detail))
  const [settingsPresetArtwork, setSettingsPresetArtwork] = useState<string | undefined>(undefined)
  const themeVisuals = useThemeVisuals(detail.id, modelId, settingsDraft.genre || '', settingsDraft.genre_fusion || '', settingsOpen)
  const primaryThemeArtwork = (settingsPresetArtwork === directorTop8Artwork ? undefined : settingsPresetArtwork)
    || directorArtworkForTheme(themeVisuals.primary || '')
  const fusionThemeArtwork = directorArtworkForTheme(themeVisuals.fusion || '')
  const [promptOpen, setPromptOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [basePrompt, setBasePrompt] = useState('')
  const [promptCustomized, setPromptCustomized] = useState(false)
  const [promptLoading, setPromptLoading] = useState(false)
  const [promptError, setPromptError] = useState<string | null>(null)
  const [input, setInput] = useState(initialContext || readComposerDraft(detail.id))
  const [adoptingMessageId, setAdoptingMessageId] = useState<string | null>(null)
  const [handoffEpisode, setHandoffEpisode] = useState(() => Math.max(0, ...(detail.script.artifacts || []).filter(item => item.artifact_type === 'episode_script').map(item => item.episode_number || 0)))
  const [working, setWorking] = useState<'chat' | 'prompt' | 'generate' | 'save' | 'shots' | null>(null)
  const skillControl = useCreativeSkills(detail.id)
  const currentSkillStage = activeFocus === 'all' ? 'script' : 'visual_assets'
  const skillSelector = <CreativeSkillSelector stage={currentSkillStage} policies={skillControl.policies} ids={skillControl.ids(currentSkillStage)} onChange={values => skillControl.change(currentSkillStage, values)}
    projectId={detail.id} appearance="chat" disabled={!!working || closing} loading={skillControl.loading} error={skillControl.error} onDefaultsChanged={() => skillControl.reload(currentSkillStage)} />
  const [storyboardOpen, setStoryboardOpen] = useState(false)
  const [planningSceneIds, setPlanningSceneIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [generated, setGenerated] = useState<GeneratedScript | null>(() => restoreWorkflowDraft(detail.id))
  const [liveRevision, setLiveRevision] = useState<RevisionTask | null>(null)
  const [previewOpen, setPreviewOpen] = useState(() => Boolean(restoreWorkflowDraft(detail.id)))
  const [artifactsOpen, setArtifactsOpen] = useState(false)
  const [scriptSaved, setScriptSaved] = useState(false)
  const [workflowStage, setWorkflowStage] = useState<WorkflowStage>(() => generated?.workflow?.stage || workflowProgress(detail.script).next_stage || 'episode')
  const [episodeNumber, setEpisodeNumber] = useState(() => (generated?.workflow?.stage === 'episode' ? generated.workflow.episode_number : undefined) || workflowProgress(detail.script).next_episode || 1)
  const [episodeDuration, setEpisodeDuration] = useState<number | undefined>(() => (generated?.workflow?.stage === 'episode' ? generated.workflow.target_duration : undefined) || options.episode_duration)
  const [assetTaskStatus, setAssetTaskStatus] = useState<AssetTaskStatus>(focusArtifact === 'all' ? 'idle' : 'analyzing')
  const [assetPrompt, setAssetPrompt] = useState('')
  const [assetImageModelId, setAssetImageModelId] = useState('')
  const [assetJobId, setAssetJobId] = useState<string | null>(null)
  const [assetTaskId, setAssetTaskId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>(() => loadDirectorState(detail.id).messages)
  const [history, setHistory] = useState<ConversationSnapshot[]>(() => loadDirectorState(detail.id).history)
  const [choiceAnswers, setChoiceAnswers] = useState<Record<string, ChoiceAnswer>>(() => readQuestionState(detail.id).answers)
  const [choiceDismissed, setChoiceDismissed] = useState<Record<string, boolean>>(() => readQuestionState(detail.id).dismissed)
  const [answeringChoiceId, setAnsweringChoiceId] = useState<string | null>(() => readQuestionState(detail.id).retryId)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [conversationLoaded, setConversationLoaded] = useState(false)
  const [classificationPending, setClassificationPending] = useState<Record<string, string>>({})
  const [classificationErrors, setClassificationErrors] = useState<Record<string, string>>({})
  const [forceClassificationId, setForceClassificationId] = useState<string | null>(null)
  const classificationAttempts = useRef(new Set<string>())
  const classificationRequest = useRef<{ controller: AbortController; scope: string; batch: ReturnType<typeof classificationBatch> } | null>(null)
  const conversationSyncReady = useRef(false)
  const conversationSaveSerial = useRef(0)
  const localConversationSaveTimer = useRef<number | null>(null)
  const remoteConversationSaveTimer = useRef<number | null>(null)
  const streamAbortController = useRef<AbortController | null>(null)
  const chatSubmitLock = useRef(false)
  const focusTaskStarted = useRef<string | null>(null)
  const directorPanelRef = useRef<HTMLElement>(null)
  const messagesViewportRef = useRef<HTMLDivElement>(null)
  const followMessagesRef = useRef(true)
  const messageScrollFrameRef = useRef<number | null>(null)
  const streamMessageFrameRef = useRef<number | null>(null)
  const streamMessageUpdateRef = useRef<{ pendingId: string; text: string } | null>(null)
  const hasSavedScript = scriptExists(detail)
  const handoffScenes = (detail.script?.scenes || []).filter(scene => !handoffEpisode || scene.episode_number === handoffEpisode)
  const savedEpisodes = (detail.script.artifacts || []).filter(artifact => artifact.artifact_type === 'episode_script' && (artifact.episode_number || 0) > 0).sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0))
  const promptRequestId = useRef(0)
  const selectedModel = availableModels.find((model) => model.id === modelId)
  const modelSelector = <Select
          className="script-director-model-select"
          aria-label="文本模型"
          title={selectedModel?.name}
          placeholder="选择文本模型"
          value={modelId || null}
          data={availableModels.map((model) => ({
            value: model.id,
            label: model.name,
          }))}
          allowDeselect={false}
          size="xs"
          comboboxProps={{ withinPortal: true, zIndex: 400, position: 'top-start', width: 320 }}
          styles={{ dropdown: { maxWidth: 'calc(100vw - 24px)' }, option: { whiteSpace: 'normal', overflowWrap: 'anywhere' } }}
          onChange={(value) => { setModelId(value || ''); try { window.localStorage.setItem(`script-director-model:${detail.id}`, value || '') } catch { /* Keep the selection in memory. */ } }}
        />

  const assetJob = assetJobId ? detail.jobs.find((job) => job.id === assetJobId) : undefined
  const assetResult = assetJob?.result_asset_id ? detail.assets.find((asset) => asset.id === assetJob.result_asset_id) : undefined
  // Project detail is refreshed periodically by the shell. Compare the
  // serialized values instead of the nested object reference so that a
  // background refresh cannot replace an in-progress local edit.
  const persistedOptionsKey = JSON.stringify(optionsFromDetail(detail))
  const optionsSyncKey = `${detail.id}:${detail.brief}:${persistedOptionsKey}`
  const syncedOptionsKey = useRef(optionsSyncKey)
  const busy = working !== null
  const generatedStructure = generated?.scenes.map((scene, index) => `第${index + 1}场｜${scene.heading || scene.location || '未命名场景'}\n${scene.action || scene.dialogue || scene.narration || ''}`).join('\n\n') || ''
  const artifactCards = useMemo(() => {
    const cards = new Map<string, GeneratedArtifact & { status: ScriptArtifact['status']; isUnsaved: boolean }>()
    detail.script.artifacts?.forEach(artifact => cards.set(artifactKey(artifact), { ...artifact, isUnsaved: false }))
    for (const type of ['outline', 'characters'] as const) if (detail.script[type].trim() && !cards.has(`${type}:0`)) cards.set(`${type}:0`, {
      artifact_type: type, title: type === 'outline' ? '故事大纲' : '人物设定', content: detail.script[type], status: 'ready', isUnsaved: false,
    })
    if (generated && !scriptSaved) {
      const draftArtifacts = [...generated.artifacts]
      if (!generated.workflow && !generated.tool_draft) {
        if (!draftArtifacts.some(item => item.artifact_type === 'outline')) draftArtifacts.push({ artifact_type: 'outline', title: '故事大纲', content: generated.outline })
        if (!draftArtifacts.some(item => item.artifact_type === 'characters')) draftArtifacts.push({ artifact_type: 'characters', title: '人物小传', content: generated.characters })
        if (!draftArtifacts.some(item => item.artifact_type === 'structure')) draftArtifacts.push({ artifact_type: 'structure', title: '全剧分段', content: generatedStructure })
      }
      draftArtifacts.filter(artifact => artifact.content.trim()).forEach(artifact => cards.set(artifactKey(artifact), { ...artifact, status: scriptSaved ? 'ready' : 'draft', isUnsaved: !scriptSaved }))
    }
    return [...cards.values()]
  }, [detail.script.artifacts, detail.script.outline, detail.script.characters, generated, generatedStructure, scriptSaved])
  const progress = workflowProgress(detail.script)
  const stageContext = directorStageContext(detail.script, { pending: generated && !scriptSaved ? toolDraftStage(generated.tool_draft) || generated.workflow : undefined,
    previous: [...messages].reverse().find(message => message.role === 'assistant')?.stage_context })
  const activeChoice = activeReplyChoice(messages, choiceDismissed, answeringChoiceId, activeFocus === 'all' ? stageContext : undefined)
  useEffect(() => { if (activeChoice) setComposerCollapsed(false) }, [activeChoice?.messageId])
  const nextStep = creation?.next_step
  const directionStart = !messages.some(message => message.role === 'user') && creation?.status === 'direction'
  const primaryArtifact = artifactCards.find(artifact => artifact.artifact_type === 'episode_script' && artifact.episode_number === handoffEpisode)
    || [...artifactCards].reverse().find(artifact => artifact.artifact_type === 'episode_script') || artifactCards.at(-1)
  const primaryArtifactScenes = detail.script.scenes.filter(scene => scene.episode_number === primaryArtifact?.episode_number)

  const readerArtifact = readerReference ? { ...readerReference, status: 'ready', isUnsaved: false } : artifactCards.find(artifact => artifactKey(artifact) === readerKey)
  const readerScenes = !readerReference && readerArtifact?.artifact_type === 'episode_script'
    ? (readerArtifact.isUnsaved ? generated?.scenes || [] : detail.script.scenes).filter(scene => scene.episode_number === readerArtifact.episode_number) : []
  useEffect(() => { setReaderView('body') }, [readerKey, readerReference])
  useEffect(() => {
    try { window.localStorage.setItem(`script-director-references:${detail.id}`, JSON.stringify(references)) } catch { /* Keep references in memory when storage is full. */ }
  }, [detail.id, references])

  useEffect(() => {
    try { window.localStorage.setItem('script-director-window', JSON.stringify(windowLayout)) } catch { /* Keep the current geometry in memory. */ }
  }, [windowLayout])
  useEffect(() => {
    const resize = () => setWindowLayout(current => ({ ...current, rect: clampDirectorWindow(current.rect, { width: window.innerWidth, height: window.innerHeight }) }))
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => {
    try { window.localStorage.setItem(`script-director-input:${detail.id}`, input) } catch { /* Keep the unsent input in memory. */ }
    const textarea = composerRef.current
    if (textarea && !composerCollapsed) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(160, Math.max(72, textarea.scrollHeight))}px` }
  }, [input, minimized, readerKey, readerReference, hidden, composerCollapsed, previewOpen, artifactsOpen, workflowOpen, activeChoice?.messageId, references.length])
  useEffect(() => {
    const composer = directorPanelRef.current?.querySelector('.sd-composer-area')
    if (!composer) return
    const observer = new ResizeObserver(() => directorPanelRef.current?.style.setProperty('--composer-height', `${composer.getBoundingClientRect().height}px`))
    observer.observe(composer)
    return () => observer.disconnect()
  }, [minimized, readerKey, readerReference, previewOpen, activeChoice?.messageId, references.length, artifactsOpen, workflowOpen, activeFocus])
  useEffect(() => {
    if (!composerMenuOpen && !historyOpen) return
    const closeMenus = (event: PointerEvent) => {
      const target = event.target as HTMLElement
      if (!target.closest('.sd-composer-menu, .sd-composer-add')) setComposerMenuOpen(false)
      if (!target.closest('.script-director-history, [aria-label="历史对话"]')) setHistoryOpen(false)
    }
    document.addEventListener('pointerdown', closeMenus)
    return () => document.removeEventListener('pointerdown', closeMenus)
  }, [composerMenuOpen, historyOpen])

  useEffect(() => {
    try {
      window.localStorage.setItem(`script-director-questions:${detail.id}`, JSON.stringify({
        answers: Object.fromEntries(Object.entries(choiceAnswers).slice(-160)),
        dismissed: Object.fromEntries(Object.entries(choiceDismissed).slice(-160)), retryId: answeringChoiceId,
      }))
    } catch { /* Answers remain available in the current panel. */ }
  }, [detail.id, choiceAnswers, choiceDismissed, answeringChoiceId])

  useEffect(() => {
    if (initialContext) { setInput(initialContext); setComposerCollapsed(false) }
  }, [initialContext])

  useEffect(() => {
    if (openRequestId === undefined) return
    // Reopening the existing conversation should reveal its messages without
    // remounting it, replacing the draft or interrupting a running request.
    setMinimized(false)
    setReaderKey(null)
    setArtifactsOpen(false)
    setWorkflowOpen(false)
  }, [openRequestId])

  useEffect(() => {
    if (syncedOptionsKey.current === optionsSyncKey) return
    syncedOptionsKey.current = optionsSyncKey
    setOptions(optionsFromDetail(detail))
    setIdea(detail.brief || '')
  }, [detail.id, detail.brief, optionsSyncKey])

  useEffect(() => {
    try {
      const key = `script-director-draft:${detail.id}`
      if ((generated?.workflow || generated?.tool_draft) && !scriptSaved) window.localStorage.setItem(key, JSON.stringify({ ...generated, generation_options: options }))
      else window.localStorage.removeItem(key)
    } catch { /* Draft preview remains available when local storage is full. */ }
  }, [detail.id, generated, scriptSaved, options])

  useEffect(() => {
    setActiveFocus(focusArtifact)
    if (focusArtifact === 'all') {
      setAssetTaskStatus('idle')
      setAssetPrompt('')
      setAssetTaskId(null)
      setAssetJobId(null)
      return
    }
    const previousTask = detail.asset_tasks?.find((task) => task.focus_artifact === focusArtifact)
    const previousJob = previousTask?.generation_job
    const previousStatus: AssetTaskStatus = previousJob?.status === 'queued' || previousJob?.status === 'running'
      ? 'generating'
      : previousJob?.status === 'succeeded' && previousTask?.result_asset ? 'succeeded'
        : previousJob?.status === 'failed' || previousTask?.status === 'failed' ? 'failed'
          : previousTask?.status === 'awaiting_confirmation' && previousTask.prompt ? 'ready'
            : previousTask?.status === 'awaiting_confirmation' ? 'awaiting-confirmation' : 'analyzing'
    setAssetTaskStatus(previousTask ? previousStatus : 'analyzing')
    setAssetPrompt(previousTask?.prompt || '')
    setAssetTaskId(previousTask?.id || null)
    setAssetJobId(previousTask?.generation_job_id || null)
    const starter = focusArtifactPrompts[focusArtifact]
    if (starter) setInput(starter)
  }, [detail.id, focusArtifact])

  useEffect(() => {
    if (focusArtifact === 'all' || !selectedModel || !modelId) return
    if (detail.asset_tasks?.some((task) => task.focus_artifact === focusArtifact)) return
    const hasConversation = messages.some((message) => message.role === 'user')
    if (hasConversation) return
    const taskKey = `${detail.id}:${focusArtifact}`
    if (focusTaskStarted.current === taskKey) return
    focusTaskStarted.current = taskKey
    const starter = focusArtifactPrompts[focusArtifact]
    if (starter) void sendChatMessage(starter)
  }, [detail.id, focusArtifact, modelId, selectedModel, messages])

  useEffect(() => {
    if (localConversationSaveTimer.current !== null) window.clearTimeout(localConversationSaveTimer.current)
    localConversationSaveTimer.current = window.setTimeout(() => {
      localConversationSaveTimer.current = null
      try {
        window.localStorage.setItem(directorStorageKey(detail.id), JSON.stringify({ messages: messages.slice(-80), history: history.slice(0, 20) }))
      } catch { /* The current conversation remains available in memory. */ }
    }, 220)
    return () => {
      if (localConversationSaveTimer.current !== null) {
        window.clearTimeout(localConversationSaveTimer.current)
        localConversationSaveTimer.current = null
      }
    }
  }, [detail.id, history, messages])

  useEffect(() => {
    if (hidden || !followMessagesRef.current || messageScrollFrameRef.current !== null) return
    messageScrollFrameRef.current = window.requestAnimationFrame(() => {
      messageScrollFrameRef.current = null
      const viewport = messagesViewportRef.current
      if (!viewport || !followMessagesRef.current) return
      viewport.scrollTo({ top: messageScrollEnd(viewport), behavior: 'auto' })
    })
  }, [messages, assetTaskStatus, artifactsOpen, previewOpen, workflowOpen, minimized, readerKey, hidden, nextStep?.id, composerCollapsed])

  useEffect(() => () => {
    if (messageScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(messageScrollFrameRef.current)
      messageScrollFrameRef.current = null
    }
    if (streamMessageFrameRef.current !== null) {
      window.cancelAnimationFrame(streamMessageFrameRef.current)
      streamMessageFrameRef.current = null
    }
    if (localConversationSaveTimer.current !== null) {
      window.clearTimeout(localConversationSaveTimer.current)
      localConversationSaveTimer.current = null
    }
    if (remoteConversationSaveTimer.current !== null) {
      window.clearTimeout(remoteConversationSaveTimer.current)
      remoteConversationSaveTimer.current = null
    }
  }, [])

  useEffect(() => {
    let active = true
    conversationSyncReady.current = false
    setConversationLoaded(false)
    void api<{ conversations: PersistedConversation[] }>(`/projects/${detail.id}/script/conversations`)
      .then((result) => {
        if (!active) return
        const remote = Array.isArray(result.conversations) ? result.conversations : []
        if (remote.length) {
          const [current, ...rest] = remote
          if (current) {
            setConversationId(current.id)
            setMessages(current.messages.length
              ? current.messages.map(message => ({ ...messages.find(local => local.id === message.id && local.text === message.text), ...message }))
              : [welcomeMessage])
          }
          setHistory(rest.map((conversation) => ({
            id: conversation.id,
            label: conversation.label,
            messages: conversation.messages,
          })))
        } else {
          setConversationId(crypto.randomUUID())
        }
      })
      .catch(() => { /* Keep the local fallback when the service is temporarily unavailable. */ })
      .finally(() => {
        if (active) { conversationSyncReady.current = true; setConversationLoaded(true) }
      })
    return () => { active = false; conversationSyncReady.current = false }
  }, [detail.id])

  useEffect(() => {
    cancelClassification()
    classificationAttempts.current.clear()
    setClassificationErrors({})
    setForceClassificationId(null)
  }, [detail.id, modelId, conversationId])

  useEffect(() => () => {
    classificationRequest.current?.controller.abort()
    classificationRequest.current = null
  }, [])

  useEffect(() => {
    if (!conversationLoaded || activeFocus !== 'all' || !selectedModel || busy || closing) { cancelClassification(); return }
    const scope = JSON.stringify([detail.id, conversationId, modelId])
    const running = classificationRequest.current
    if (running) {
      const unchanged = running.scope === scope && running.batch.every(source => {
        const index = messages.findIndex(message => message.id === source.id && message.text === source.text)
        return index >= 0 && JSON.stringify(followingMessages(messages, index)) === JSON.stringify(source.following_messages) && JSON.stringify(messages[index].stage_context) === JSON.stringify(source.stage_context)
      })
      if (unchanged && !forceClassificationId) return
      cancelClassification()
    }
    const batch = classificationBatch(messages, classificationAttempts.current, forceClassificationId, true)
    if (!batch.length) return
    const force = batch.length === 1 && batch[0].id === forceClassificationId
    if (force) setForceClassificationId(null)
    for (const message of batch) classificationAttempts.current.add(classificationKey(message))
    const request = { controller: new AbortController(), scope, batch }
    classificationRequest.current = request
    setClassificationPending(Object.fromEntries(batch.map(source => [source.id, classificationKey(source)])))
    setClassificationErrors(current => Object.fromEntries(Object.entries(current).filter(([id]) => !batch.some(source => source.id === id))))
    void api<{ classification_version: number; messages: Array<{ id: string; classification: ReplyClassification }> }>(`/projects/${detail.id}/script/replies/classify`, { ...json('POST', { model_id: modelId, stage_controlled: true, messages: batch, ...(force ? { force: true } : {}) }), signal: request.controller.signal })
      .then(result => {
        if (classificationRequest.current !== request) return
        setMessages(current => current.map((message, index) => {
          const source = batch.find(item => item.id === message.id)
          const resultItem = result.messages.find(item => item.id === message.id)
          return source && message.text === source.text && JSON.stringify(followingMessages(current, index)) === JSON.stringify(source.following_messages) && JSON.stringify(message.stage_context) === JSON.stringify(source.stage_context) && resultItem ? { ...message, classification: resultItem.classification, classification_version: result.classification_version, classification_context: JSON.stringify(source.following_messages), classification_source: 'model_extraction' } : message
        }))
      })
      .catch(() => {
        if (classificationRequest.current !== request || request.controller.signal.aborted) return
        setClassificationErrors(current => ({ ...current, ...Object.fromEntries(batch.map(source => [source.id, classificationKey(source)])) }))
      })
      .finally(() => {
        if (classificationRequest.current !== request) return
        classificationRequest.current = null
        setClassificationPending({})
      })
  }, [detail.id, conversationId, conversationLoaded, activeFocus, selectedModel, modelId, busy, closing, classificationPending, messages, forceClassificationId])

  useEffect(() => {
    if (!conversationSyncReady.current) return
    if (messages.some((message) => message.pending)) return
    const serial = ++conversationSaveSerial.current
    if (remoteConversationSaveTimer.current !== null) window.clearTimeout(remoteConversationSaveTimer.current)
    remoteConversationSaveTimer.current = window.setTimeout(() => {
      remoteConversationSaveTimer.current = null
      const currentId = conversationId || crypto.randomUUID()
      if (!conversationId) setConversationId(currentId)
      const currentSnapshot = {
        id: currentId,
        label: messages.find((message) => message.role === 'user')?.text || '当前对话',
        messages,
      }
      // Save older entries first and the active conversation last, so the API's
      // updated-at ordering reliably restores the active conversation on reload.
      const snapshots = [...history.slice(0, 20), currentSnapshot]
      void (async () => {
        for (const conversation of snapshots) {
          if (conversationSaveSerial.current !== serial) return
          await api<PersistedConversation>(`/projects/${detail.id}/script/conversations`, json('PUT', {
            id: conversation.id,
            label: conversation.label,
            messages: conversation.messages.filter((message) => !message.pending).slice(-80).map(conversationMessage),
          })).catch(() => null)
        }
      })()
    }, 360)
    return () => {
      if (remoteConversationSaveTimer.current !== null) {
        window.clearTimeout(remoteConversationSaveTimer.current)
        remoteConversationSaveTimer.current = null
      }
    }
  }, [detail.id, conversationId, history, messages])

  useEffect(() => {
    if (!modelId && availableModels.length === 1) setModelId(availableModels[0]!.id)
    if (modelId && !availableModels.some((model) => model.id === modelId)) setModelId('')
  }, [availableModels, modelId])

  useEffect(() => {
    if (!assetImageModelId && imageModels.length === 1) setAssetImageModelId(imageModels[0]!.id)
    if (assetImageModelId && !imageModels.some((model) => model.id === assetImageModelId)) setAssetImageModelId('')
  }, [assetImageModelId, imageModels])

  useEffect(() => {
    if (!assetJob) return
    if (assetJob.status === 'queued' || assetJob.status === 'running') setAssetTaskStatus('generating')
    else if (assetJob.status === 'succeeded') setAssetTaskStatus('succeeded')
    else if (assetJob.status === 'failed') setAssetTaskStatus('failed')
  }, [assetJob?.id, assetJob?.status])

  function openSettings() {
    const nextDraft = {
      ...options,
      genre: options.genre || defaultPrimaryTheme,
    }
    // Restore the cover of a ranked preset when its distinctive fields are
    // still present. Top 1 and Top 8 share the same genre, so genre alone is
    // insufficient to identify which cover should be shown.
    const matchingPreset = directorSettingPresets.find((preset) => {
      if (!preset.artwork || preset.values.genre !== nextDraft.genre) return false
      return Object.entries(preset.values).every(([key, value]) => nextDraft[key as keyof ScriptGenerationOptions] === value)
    })
    setSettingsPresetArtwork(matchingPreset?.artwork)
    setSettingsDraft(nextDraft)
    setAutoFieldOpen(null)
    setStructurePickerOpen(false)
    setFusionRailOpen(Boolean(nextDraft.genre_fusion))
    setFusionExitActive(false)
    setSettingsOpen(true)
  }

  function selectTheme(theme: string) {
    if (!theme) {
      setSettingsDraft((current) => ({ ...current, genre: '', genre_fusion: '' }))
      setSettingsPresetArtwork(undefined)
      setFusionRailOpen(false)
      return
    }
    setSettingsDraft((current) => ({
      ...current,
      genre: theme,
      genre_fusion: current.genre_fusion === theme ? '' : current.genre_fusion,
    }))
    setSettingsPresetArtwork(undefined)
  }

  function clearFusionTheme() {
    // Keep the paired layout in place while WebGL merges the secondary lobe
    // back into the primary one. Removing the layout class immediately would
    // make the remaining lobe jump before the reverse transition finishes.
    setFusionExitActive(true)
    setSettingsDraft((current) => ({ ...current, genre_fusion: '' }))
    setFusionRailOpen(false)
  }

  function selectFusionTheme(theme: string) {
    if (!theme) {
      setSettingsDraft((current) => ({ ...current, genre_fusion: '' }))
      setFusionRailOpen(true)
      return
    }
    if (theme === settingsDraft.genre) return
    setSettingsDraft((current) => ({ ...current, genre_fusion: theme }))
    setFusionRailOpen(true)
  }

  function updateSettingsDraft(key: keyof ScriptGenerationOptions, value: string | number | undefined) {
    setSettingsDraft((current) => ({ ...current, [key]: value,
      ...(key === 'visual_style' && value !== current.visual_style ? { visual_style_details: undefined } : {}) }))
  }

  function applySettings() {
    const confirmed = { ...settingsDraft }
    setOptions(confirmed)
    setPromptCustomized(false)
    setAutoFieldOpen(null)
    setStructurePickerOpen(false)
    setSettingsOpen(false)
    const summary = [
      confirmed.genre && `题材：${confirmed.genre}`,
      confirmed.genre_fusion && `融合题材：${confirmed.genre_fusion}`,
      confirmed.audience && `受众：${confirmed.audience}`,
      confirmed.era && `时代：${confirmed.era}`,
      confirmed.core_hook && `核心看点：${confirmed.core_hook}`,
      confirmed.visual_style && `画风：${confirmed.visual_style}`,
      confirmed.story_structure && `结构：${confirmed.story_structure}`,
      confirmed.episode_count && `集数：${confirmed.episode_count} 集`,
    ].filter(Boolean).join('；')
    if (summary) appendMessage('assistant', `已确认剧本设定：${summary}。后续对话和剧本生成都会以这组设定为共同上下文。`)

    // Persist the confirmed direction immediately as a durable checkpoint before
    // moving on to outline and character work.
    // Keep existing documents and scenes intact while only replacing the
    // generation options and the current project brief.
    void api<ProjectDetail['script']>(`/projects/${detail.id}/script`, json('PUT', {
      brief: idea.trim() || detail.brief || undefined,
      outline: detail.script?.outline || '',
      characters: detail.script?.characters || '',
      generation_options: confirmed,
    })).then(async () => {
      await onRefresh()
      onNotice('剧本设定已保存')
    }).catch(() => {
      // The local state remains usable when the API is temporarily offline;
      // the next successful project refresh will reconcile the saved values.
    })
  }

  function appendMessage(role: Message['role'], text: string, pending = false) {
    followMessagesRef.current = true
    setMessages((current) => [...current, { id: crypto.randomUUID(), role, text, pending, classification_version: replyClassificationVersion, classification: { type: 'other' } as ReplyClassification }].slice(-80))
  }

  function messageScrollEnd(element: HTMLElement) {
    const latest = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].at(-1)
    // Keep the latest task/reply visible; the project deliverables below it
    // should not push the current execution card above the viewport.
    if (latest?.querySelector('.sd-activity')) return Math.max(0, element.scrollTop + latest.getBoundingClientRect().bottom - element.getBoundingClientRect().top - element.clientHeight + 8)
    return Math.max(0, element.scrollHeight - element.clientHeight)
  }

  function updateMessageFollow() {
    const isAtBottom = (element: HTMLElement | null) => !element || messageScrollEnd(element) - element.scrollTop < 72
    // The panel is a fixed flex shell with overflow hidden. Its scrollHeight
    // includes the composer and other fixed sections, so checking it here
    // incorrectly disables follow mode after the first message grows.
    followMessagesRef.current = isAtBottom(messagesViewportRef.current)
    setShowLatest(!followMessagesRef.current)
  }

  function flushQueuedStreamMessage() {
    if (streamMessageFrameRef.current !== null) {
      window.cancelAnimationFrame(streamMessageFrameRef.current)
      streamMessageFrameRef.current = null
    }
    const update = streamMessageUpdateRef.current
    streamMessageUpdateRef.current = null
    if (!update) return
    setMessages((current) => current.map((item) => item.id === update.pendingId
      ? { ...item, text: update.text, pending: true } : item))
  }

  function queueStreamMessage(pendingId: string, text: string) {
    streamMessageUpdateRef.current = { pendingId, text }
    if (streamMessageFrameRef.current !== null) return
    streamMessageFrameRef.current = window.requestAnimationFrame(() => {
      streamMessageFrameRef.current = null
      const update = streamMessageUpdateRef.current
      streamMessageUpdateRef.current = null
      if (!update) return
      setMessages((current) => current.map((item) => item.id === update.pendingId
        ? { ...item, text: update.text, pending: true } : item))
    })
  }

  function appendProcessEvent(pendingId: string, event: StreamEvent) {
    if (event.activity) {
      const incoming = readActivity(Array.isArray(event.activity) ? event.activity : [event.activity])
      const draftId = activityDraftId(incoming)
      if (draftId) {
        executionDraftIds.current.set(pendingId, draftId)
        if (executionDraftIds.current.size > 80) executionDraftIds.current.delete(executionDraftIds.current.keys().next().value!)
      }
      setMessages(current => current.map(message => message.id === pendingId ? { ...message,
        activity: incoming.reduce((entries, entry) => updateActivity(entries, entry), readActivity(message.activity)) } : message))
      return
    }
    const summary = (event.summary || event.text || '').trim()
    if (!summary) return
    const label = event.label || '创作依据'
    setMessages(current => current.map(message => {
      if (message.id !== pendingId) return message
      const events = readActivity(message.activity)
      // Native calls emit rich activity and a compatibility process summary.
      if (events.some(item => item.kind === 'tool' && item.label === label)) return message
      return { ...message, activity: [...events, { id: crypto.randomUUID(), label, summary: summary.slice(0, 3000), kind: 'context' as const, status: 'succeeded' as const, started_at: Date.now() }] }
    }))
  }

  async function streamDirectorChat(
    pendingId: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const scope = createStreamScope(signal, { idleMs: directorStreamIdleTimeoutMs })
    try {
      const response = await scope.wait(fetch(`/api/projects/${detail.id}/script/director/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/x-ndjson' },
        body: JSON.stringify(body),
        signal: scope.signal,
      }))
      if (response.status === 404 || response.status === 405) {
        throw new StreamUnavailableError('流式接口暂不可用')
      }
      if (!response.ok) {
        const payload = await scope.wait(response.json()).catch(() => {
          if (scope.signal.aborted) throw scope.signal.reason
          return {}
        }) as { detail?: unknown; message?: unknown }
        const detail = payload.detail ?? payload.message
        throw new Error(typeof detail === 'string' ? detail : `请求失败 (${response.status})`)
      }
      if (!response.body) throw new StreamUnavailableError('浏览器不支持流式响应')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let reply = ''
      let documentWorkflow = Boolean(body.workflow || body.adopt_source)
      let completed = false
      let sseLines: string[] = []

      const applyEvent = (event: StreamEvent) => {
        const kind = String(event.type || '').toLowerCase()
        if (kind === 'heartbeat') return
        if (kind === 'revision_progress' && event.task) {
          setLiveRevision(event.task)
          if (event.draft_id) executionDraftIds.current.set(pendingId, event.draft_id)
          return
        }
        if (kind === 'close' && !completed) throw new Error('服务连接已结束，但未返回完整创作结果；请检查草稿后重试')
        if (event.activity) appendProcessEvent(pendingId, event)
        if (kind === 'activity') return
        if (event.stage_context) setMessages(current => current.map(message => message.id === pendingId ? { ...message, stage_context: event.stage_context } : message))
        if (kind === 'intent') {
          documentWorkflow = Boolean(event.workflow)
          if (event.generation_options) setOptions(event.generation_options)
          if (event.generation_options?.episode_duration) setEpisodeDuration(event.generation_options.episode_duration)
          return
        }
        if (kind === 'progress' || kind === 'stage') {
          if (!reply && event.text) queueStreamMessage(pendingId, event.text)
          return
        }
        if (kind === 'process' || kind === 'summary' || kind === 'reasoning_summary') {
          appendProcessEvent(pendingId, event)
          return
        }
        if (kind === 'error') {
          throw new Error(event.message || event.text || '流式生成失败')
        }
        if (kind === 'done' || kind === 'complete') {
          flushQueuedStreamMessage()
          completed = true
          receiveToolResult(event, pendingId)
          if (typeof event.reply === 'string') reply = event.reply
          if (event.draft) {
            receiveWorkflowDraft(event.draft, pendingId)
            setMessages(current => current.map(message => message.id === pendingId ? { ...message, classification_version: replyClassificationVersion, classification: { type: 'other' } } : message))
          }
          return
        }
        const chunk = typeof event.delta === 'string' ? event.delta : typeof event.text === 'string' ? event.text : ''
        if (chunk) {
          reply += chunk
          if (!documentWorkflow && !isStructuredChoiceStream(reply)) setMessages(current => current.map(message => message.id === pendingId ? { ...message, has_reply_text: true } : message))
          queueStreamMessage(pendingId, documentWorkflow ? '正在编写阶段草稿，完成后可预览和确认…' : isStructuredChoiceStream(reply) ? '正在整理可选方向…' : reply)
        }
      }

      const flushSse = () => {
        if (!sseLines.length) return
        const event = parseStreamEvent(sseLines.join('\n'))
        sseLines = []
        if (event) applyEvent(event)
      }

      try {
        while (!completed) {
          const { value, done } = await scope.wait(reader.read())
          if (value?.length) scope.touch()
          buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() || ''
          for (const line of lines) {
            if (!line.trim()) {
              flushSse()
              if (completed) break
              continue
            }
            if (line.startsWith('event:')) continue
            if (line.startsWith('data:')) {
              sseLines.push(line)
              continue
            }
            // NDJSON responses have one JSON object per line.
            const event = parseStreamEvent(line)
            if (event) applyEvent(event)
            if (completed) break
          }
          if (done && !completed) {
            if (buffer.trim()) {
              if (buffer.startsWith('data:')) sseLines.push(buffer)
              else {
                const event = parseStreamEvent(buffer)
                if (event) applyEvent(event)
              }
            }
            flushSse()
            break
          }
        }
      } finally {
        flushQueuedStreamMessage()
        void reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      if (!completed) throw new Error('连接中断，创作结果尚未完整返回；请检查草稿和已保存文档后重试')
      if (!reply.trim()) {
        const current = messages.find((item) => item.id === pendingId)?.text || ''
        reply = current.trim()
      }
      if (!reply.trim()) throw new Error('文本模型未返回对话内容')
      return reply
    } finally { scope.close() }
  }

  function currentDraftIdea() {
    const discussion = messages.filter((item) => item.id !== 'welcome' && !item.pending)
      .map((item) => {
        const label = item.role === 'user' ? '创作者' : '导演'
        // Keep the creator's decisions intact, while clipping long director
        // drafts that are already persisted as project artifacts.
        const limit = item.role === 'user' ? 4000 : 1400
        const text = item.text.length > limit ? `${item.text.slice(0, limit)}…` : item.text
        return `${label}：${text}`
      })
    if (!discussion.some((item) => item.startsWith('创作者：')) && idea.trim()) discussion.unshift(`创意概述：${idea.trim()}`)
    if (input.trim()) discussion.push(`创作者：${input.trim()}`)
    return discussion.join('\n\n').slice(-12000)
  }

  function startNewConversation() {
    setComposerCollapsed(false)
    setInput('')
    setReferences([])
    setReaderReference(null)
    setReaderKey(null)
    followMessagesRef.current = true
    if (messages.some((message) => message.role === 'user')) {
      const currentId = conversationId || crypto.randomUUID()
      const firstIdea = messages.find((message) => message.role === 'user')?.text || '未命名对话'
      setHistory((current) => [{
        id: currentId,
        label: firstIdea.length > 28 ? `${firstIdea.slice(0, 28)}…` : firstIdea,
        messages,
      }, ...current.filter(item => item.id !== currentId)].slice(0, 20))
    }
    setMessages([{ id: crypto.randomUUID(), role: 'assistant', text: '新的创作已经开始。告诉我你的故事想法，我会先和你讨论创作方向。', classification_version: replyClassificationVersion, classification: { type: 'other' } }])
    setAnsweringChoiceId(null)
    setConversationId(crypto.randomUUID())
    // `idea` is also used as the fallback when building the generation input.
    // Clear any idea captured from the previous conversation while retaining
    // the project-level brief that was present when this panel opened.
    setIdea(detail.brief || '')
    setGenerated(null)
    setPreviewOpen(false)
    setArtifactsOpen(false)
    setWorkflowOpen(false)
    setScriptSaved(false)
    setError(null)
    setHistoryOpen(false)
    setPromptOpen(false)
    setPrompt('')
    setBasePrompt('')
    setPromptCustomized(false)
    setDocumentTask(null)
    void refreshToolState(true).catch(() => {})
  }

  function switchConversation(conversation: ConversationSnapshot) {
    if (busy) return
    setInput('')
    setReferences([])
    setReaderReference(null)
    setReaderKey(null)
    followMessagesRef.current = true
    if (messages.some((message) => message.role === 'user')) {
      const currentId = conversationId || crypto.randomUUID()
      const firstIdea = messages.find((message) => message.role === 'user')?.text || '未命名对话'
      setHistory((current) => [{
        id: currentId,
        label: firstIdea.length > 28 ? `${firstIdea.slice(0, 28)}…` : firstIdea,
        messages,
      }, ...current.filter(item => item.id !== currentId && item.id !== conversation.id)].slice(0, 20))
    }
    setMessages(conversation.messages)
    setAnsweringChoiceId(null)
    setConversationId(conversation.id)
    // Do not prepend the current conversation's unsaved idea to a restored
    // history. A restored conversation should be generated from its own
    // messages and the project's original brief only.
    setIdea(detail.brief || '')
    setHistoryOpen(false)
    setGenerated(null)
    setPreviewOpen(false)
    setArtifactsOpen(false)
    setWorkflowOpen(false)
    setScriptSaved(false)
    setError(null)
    setDocumentTask(null)
    void refreshToolState(true).catch(() => {})
  }

  async function refreshPrompt() {
    setComposerCollapsed(false)
    const currentIdea = currentDraftIdea()
    if (!currentIdea) {
      setPromptError('先输入故事想法，再生成提示词')
      setPromptOpen(true)
      return
    }
    setPromptCustomized(false)
    setPromptOpen(true)
    setPromptLoading(true)
    setPromptError(null)
    const requestId = ++promptRequestId.current
    try {
      const result = await api<{ prompt: string }>(`/projects/${detail.id}/script/generate/prompt`, json('POST', {
        skill_selections: skillControl.selections,
        idea: currentIdea,
        generation_options: options,
      }))
      if (requestId === promptRequestId.current) {
        setBasePrompt(result.prompt)
        setPrompt(promptForMode(result.prompt, mode))
      }
    } catch (issue) {
      if (requestId === promptRequestId.current) setPromptError(`提示词加载失败：${readableError(issue)}`)
    } finally {
      if (requestId === promptRequestId.current) setPromptLoading(false)
    }
  }

  function receiveWorkflowDraft(draft: WorkflowDraft, sourceMessageId?: string) {
    setGenerated({
      ...(sourceMessageId ? { source_message_id: sourceMessageId } : {}),
      workflow: workflowRequestForStage(draft.stage, draft.episode_number, draft.target_duration),
      outline: draft.artifacts.find(item => item.artifact_type === 'outline')?.content || detail.script.outline,
      characters: draft.artifacts.find(item => item.artifact_type === 'characters')?.content || detail.script.characters,
      artifacts: draft.artifacts.map(item => ({ ...item, episode_number: draft.stage === 'episode' ? draft.episode_number : 0 })),
      scenes: draft.scenes.map(scene => ({ ...normaliseScene(scene), episode_number: draft.episode_number })),
    })
    setWorkflowStage(draft.stage)
    if (draft.stage === 'episode') setEpisodeNumber(draft.episode_number)
    setScriptSaved(false)
    setPreviewOpen(true)
    setWorkflowOpen(false)
    setArtifactsOpen(false)
  }

  function receiveToolDraft(draft: ScriptToolDraft | null, showPreview = true) {
    if (draft) setMessages(current => current.map(message => message.execution?.outcome?.draft_id === draft.id ? { ...message,
      execution: { ...message.execution, outcome: toolDraftOutcome(draft) } } : message))
    if (!draft || draft.status === 'discarded') { setGenerated(current => current?.tool_draft ? null : current); setPreviewOpen(false); return }
    const artifacts = toolDraftArtifacts(draft)
    setGenerated({ tool_draft: draft, ...(draft.workflow ? { workflow: draft.workflow } : {}), resource_changes: draft.resource_changes,
      outline: artifacts.find(item => item.artifact_type === 'outline')?.content || detail.script.outline,
      characters: artifacts.find(item => item.artifact_type === 'characters')?.content || detail.script.characters,
      artifacts, scenes: toolDraftScenes(draft) })
    setScriptSaved(draft.status === 'saved')
    if (showPreview) setPreviewOpen(draft.status === 'pending')
    setArtifactsOpen(false); setWorkflowOpen(false); setReaderKey(null); setReaderReference(null)
  }

  function continueRevisionTask() {
    const task = generated?.tool_draft?.revision_task
    if (!task) return
    setPreviewOpen(false)
    void sendChatMessage(`继续统一修订任务 ${task.id}，沿用原范围和拟定决定，处理未完成项，核对当前有效草稿、全部分场和关联内容，完成后给我统一预览。不重建任务，不重复确认授权，不自动保存。`, false, undefined, true)
  }

  async function refreshToolState(restoreDraft = false, sourceMessageId?: string) {
    const requestId = ++creationRefreshId.current
    const result = await api<{ draft: ScriptToolDraft | null; decisions: StoryDecision[]; creation?: ScriptCreationState }>(`/projects/${detail.id}/script/director/tools-state`)
    if (requestId !== creationRefreshId.current) return result
    setDecisions(result.decisions)
    setCreation(result.creation || null)
    const knownDraftId = sourceMessageId && executionDraftIds.current.get(sourceMessageId)
    if (restoreDraft && knownDraftId && result.draft?.id !== knownDraftId) {
      const draft = await api<ScriptToolDraft>(`/projects/${detail.id}/script/director/tool-drafts/${knownDraftId}`)
      if (requestId !== creationRefreshId.current) return result
      receiveExecutionResult({ tool_draft: draft }, sourceMessageId!)
      if (!result.draft) receiveToolDraft(draft)
      if (draft.status === 'saved') await onRefresh()
      return result
    }
    if (restoreDraft && result.draft) {
      receiveToolDraft(result.draft, !sourceMessageId || Boolean(knownDraftId))
      if (sourceMessageId && knownDraftId === result.draft.id) receiveExecutionResult({ tool_draft: result.draft }, sourceMessageId)
    }
    else if (restoreDraft && generated?.tool_draft && !scriptSaved) {
      const draft = await api<ScriptToolDraft>(`/projects/${detail.id}/script/director/tool-drafts/${generated.tool_draft.id}`)
      if (requestId !== creationRefreshId.current) return result
      receiveToolDraft(draft, !sourceMessageId || Boolean(knownDraftId))
      if (sourceMessageId && knownDraftId === draft.id) receiveExecutionResult({ tool_draft: draft }, sourceMessageId)
      if (draft.status === 'saved') await onRefresh()
    }
    return result
  }

  const savedCreationKey = JSON.stringify([detail.id, detail.brief, detail.script])
  useEffect(() => {
    let active = true
    const requestId = ++creationRefreshId.current
    void api<{ draft: ScriptToolDraft | null; decisions: StoryDecision[]; creation?: ScriptCreationState }>(`/projects/${detail.id}/script/director/tools-state`).then(result => {
      if (!active || requestId !== creationRefreshId.current) return
      setDecisions(result.decisions)
      setCreation(result.creation || null)
      if (result.draft) {
        if (result.draft.version !== generated?.tool_draft?.version) receiveToolDraft(result.draft)
      } else setGenerated(current => current?.tool_draft ? null : current)
    }).catch(() => { /* Local draft remains visible if the server is unavailable. */ })
    return () => { active = false }
  }, [savedCreationKey])

  function receiveToolResult(event: StreamEvent, pendingId: string) {
    if (event.creation) {
      ++creationRefreshId.current
      setCreation(event.creation)
    }
    if (event.generation_options) setOptions(event.generation_options)
    if (event.generation_options?.episode_duration) setEpisodeDuration(event.generation_options.episode_duration)
    if (event.tool_draft !== undefined) receiveToolDraft(event.tool_draft)
    if (event.review) setMessages(current => current.map(message => message.id === pendingId ? { ...message, review: event.review } : message))
    if (event.classification_version && event.classification) setMessages(current => current.map(message => message.id === pendingId
      ? { ...message, classification_version: event.classification_version, classification: event.classification, classification_context: '[]', classification_source: event.classification_source } : message))
    if (event.project_changed) void onRefresh().catch(() => onNotice('文档已保存，刷新失败，请稍后重试'))
    receiveExecutionResult(event, pendingId)
  }

  function receiveExecutionResult(event: StreamEvent, pendingId: string) {
    setMessages(current => current.map(message => {
      if (message.id !== pendingId || !message.execution) return message
      let outcome: ScriptExecution['outcome'] = { kind: 'reply', summary: '本轮回复已完成，可在下方阅读或继续讨论。' }
      const draft = event.tool_draft
      let targets = message.execution.targets, title = message.execution.title
      if (draft) {
        targets = [...draft.documents.map(doc => doc.title), ...(draft.resource_changes || []).map(change => change.title)].slice(0, 50).map(title => title.slice(0, 200))
        if (!message.execution.document_action && !message.execution.workflow) title = draft.kind === 'resource' ? '视觉设定与分镜处理' : draft.kind === 'patch' ? '修订项目文档' : '整理创作草稿'
        outcome = toolDraftOutcome(draft)
      } else if (event.draft) {
        targets = event.draft.artifacts.map(doc => doc.title).slice(0, 50).map(title => title.slice(0, 200))
        title = `生成${event.draft.stage === 'episode' ? `第 ${event.draft.episode_number} 集正文` : workflowLabels[event.draft.stage]}`
        outcome = { kind: 'draft', summary: '创作草稿已准备，尚未写入项目。请预览、编辑后确认保存。', draft_id: `workflow:${pendingId}` }
      } else if (event.review) outcome = { kind: 'review', summary: `评审已完成，整理了 ${event.review.findings.length} 项发现与建议。报告见下方，文档正文未修改。` }
      else if (event.classification && 'status' in event.classification && event.classification.status === 'pending') outcome = { kind: 'question', summary: '需要你确认当前设定，请在下方回答。回答后继续讨论。' }
      else if (event.completion_kind === 'next_step') outcome = { kind: 'next_step', summary: '下一步建议已准备，请查看对话下方的当前创作操作。' }
      if (event.execution_outcome) outcome = { ...outcome, ...event.execution_outcome }
      return { ...message, execution: { ...message.execution, title, targets, outcome,
        ...(event.draft ? { workflow: workflowRequestForStage(event.draft.stage, event.draft.episode_number, event.draft.target_duration) } : {}) } }
    }))
  }

  async function syncEditedToolDraft() {
    if (!generated?.tool_draft || scriptSaved) return generated?.tool_draft
    const edited = editedToolDraft(generated.tool_draft, generated.artifacts, generated.scenes, generated.resource_changes)
    if (!edited.changed) return generated.tool_draft
    const draft = await api<ScriptToolDraft>(`/projects/${detail.id}/script/director/tool-drafts/${generated.tool_draft.id}`, json('PUT', edited.input))
    receiveToolDraft(draft, false)
    return draft
  }

  async function discardGenerated() {
    if (busy) return
    if (generated?.tool_draft) {
      setWorking('save')
      try { await api(`/projects/${detail.id}/script/director/tool-drafts/${generated.tool_draft.id}/discard`, json('POST', { version: generated.tool_draft.version })) }
      catch (issue) { setError(readableError(issue)); return }
      finally { setWorking(null) }
    }
    if (generated?.source_message_id) setMessages(current => current.map(message => message.id === generated.source_message_id && message.execution ? { ...message,
      execution: { ...message.execution, outcome: { kind: 'discarded', summary: '草稿已放弃，正式资料保持原状。' } } } : message))
    if (generated?.tool_draft) setMessages(current => current.map(message => message.execution?.outcome?.draft_id === generated.tool_draft!.id ? { ...message,
      execution: { ...message.execution, outcome: { ...message.execution.outcome!, kind: 'discarded', summary: '草稿已放弃，正式资料保持原状。' } } } : message))
    setGenerated(null); setPreviewOpen(false); setError(null)
    setCreation(null)
    void refreshToolState().catch(() => {})
  }

  function reviewDocument(operation: DocumentAction['operation']) {
    if (!readerArtifact || readerReference || readerArtifact.isUnsaved || busy || !selectedModel) return
    const saved = detail.script.artifacts?.find(item => artifactKey(item) === artifactKey(readerArtifact))
    const id = saved?.id || `legacy:${readerArtifact.artifact_type}`
    const task = { operation, document_ids: [id], title: readerArtifact.title }
    setDocumentTask(operation === 'revise' ? task : null)
    setReaderKey(null); setReaderReference(null); setArtifactsOpen(false)
    if (operation === 'review') void sendChatMessage(documentTaskPrompt(readerArtifact.title, 'review'), false, undefined, true, undefined, undefined, undefined, task)
    else { setComposerCollapsed(false); setInput(documentTaskPrompt(readerArtifact.title, 'revise')); window.requestAnimationFrame(() => composerRef.current?.focus()) }
  }

  function generateWorkflow(stage: WorkflowStage = workflowStage, label?: string, targetEpisode = episodeNumber, step?: CreationNextStep) {
    if (busy || generated && !scriptSaved) return
    setWorkflowStage(stage)
    if (stage === 'episode') setEpisodeNumber(targetEpisode)
    const request = workflowRequestForStage(stage, targetEpisode, episodeDuration)
    const instruction = workflowInstruction(request, label)
    const message = input.trim() ? `${input.trim()}\n\n${instruction}` : instruction
    void sendChatMessage(message, false, request, false, undefined, undefined, undefined, undefined, step?.id)
  }

  async function answerQuestion(messageId: string, question: string, answer: string) {
    setAnsweringChoiceId(messageId)
    const reply = await sendChatMessage(`关于“${question}”，我的回答是：${answer}`, false, undefined, true, undefined, undefined,
      { status: 'answered', question })
    if (reply !== null) {
      setChoiceAnswers(current => ({ ...current, [messageId]: { ...current[messageId], custom: current[messageId]?.custom || false, text: current[messageId]?.text || '', status: 'answered' } }))
      setChoiceDismissed(current => ({ ...current, [messageId]: true }))
      setAnsweringChoiceId(null)
    }
  }

  async function skipQuestion(messageId: string, question: string) {
    setAnsweringChoiceId(messageId)
    const reply = await sendChatMessage(`关于“${question}”，我交给你决定。请结合已有故事和已确认的约束，选定最合适的方案或补齐具体设定，简短说明理由并继续推进。这项不要保留待定或再次询问确认，后续创作沿用你的决定，除非我提出修改。`, false, undefined, true, undefined, undefined, { status: 'skipped', question })
    if (reply !== null) {
      setChoiceAnswers(current => ({ ...current, [messageId]: { ...current[messageId], custom: current[messageId]?.custom || false, text: current[messageId]?.text || '', status: 'skipped' } }))
      setChoiceDismissed(current => ({ ...current, [messageId]: true }))
      setAnsweringChoiceId(null)
    }
  }

  function reclassifyReply(message: Message) {
    if (busy || classificationPending[message.id] || !selectedModel || activeFocus !== 'all') return
    cancelClassification()
    const index = messages.findIndex(item => item.id === message.id)
    classificationAttempts.current.delete(classificationKey({ ...message, following_messages: followingMessages(messages, index) }))
    setClassificationErrors(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== message.id)))
    setForceClassificationId(message.id)
    setMessages(current => current.map(item => item.id === message.id ? { ...item, classification: undefined, classification_version: undefined, classification_context: undefined } : item))
  }

  async function regenerateReply(message: Message) {
    if (busy || classificationPending[message.id] || closing) return
    if (!canRetryExecution(message.activity) || ['draft', 'saved', 'discarded'].includes(message.execution?.outcome?.kind || '')) { await recoverExecution(message); return }
    if (generated && !scriptSaved) { setPreviewOpen(true); setError('请先保存或放弃当前草稿，再重新生成回复'); return }
    setAnsweringChoiceId(null)
    setAdoptingMessageId(null)
    setForceClassificationId(null)
    await sendChatMessage(undefined, false, message.execution?.workflow, true, undefined, message.id, undefined, message.execution?.document_action)
  }

  async function sendChatMessage(overrideInput?: string, skipAssetStatus = false, workflowOverride?: WorkflowRequest, preserveComposer = false, adoptSource?: { text: string; episode_number: number }, regenerateId?: string, questionResponse?: Message['question_response'], actionOverride?: DocumentAction, nextStepId?: string): Promise<string | null> {
    const retry = regenerateId ? regenerationSource(messages, regenerateId) : null
    if (regenerateId && !retry) return null
    const usesComposer = !preserveComposer && !adoptSource
    const attached = usesComposer ? references : []
    const message = (retry?.question.text ?? overrideInput ?? (input.trim() || (attached.length ? '请参考引用文档，帮我分析并建议下一步。' : ''))).trim()
    if (!message) return null
    if (busy || chatSubmitLock.current || skillControl.loading) return null
    if (skillControl.error) { setError(`技能配置读取失败：${skillControl.error}`); return null }
    const previousExecution = regenerateId ? messages.find(item => item.id === regenerateId)?.execution : undefined
    const requestFocus = previousExecution?.focus_artifact || activeFocus
    const requestMode = previousExecution?.mode || mode
    const workflow = requestFocus === 'all' ? workflowOverride : undefined
    if ((workflow || adoptSource) && generated && !scriptSaved) { setPreviewOpen(true); setError('请先确认保存或放弃当前草稿'); return null }
    if (!modelId || !selectedModel) { setError('请选择文本模型'); return null }
    const userMessage: Message = retry ? { ...retry.question, failed: false } : { id: crypto.randomUUID(), role: 'user', text: message, ...(questionResponse ? { question_response: questionResponse } : {}), ...(attached.length ? { reference_documents: attached } : {}) }
    let conversation: ReturnType<typeof referenceMessages>
    try { conversation = referenceMessages(directorChatContext(retry ? retry.context : [...messages, userMessage])) }
    catch (issue) { setError(readableError(issue)); return null }
    chatSubmitLock.current = true
    const generationOptions = options
    setError(null)
    setLiveRevision(null)
    setCreation(null)
    ++creationRefreshId.current
    if (activeFocus !== 'all' && !skipAssetStatus) setAssetTaskStatus('analyzing')
    const pendingId = crypto.randomUUID()
    const startedAt = performance.now()
    const selectedAction = (actionOverride || usesComposer && documentTask) && !workflow && !adoptSource && !questionResponse ? actionOverride || documentTask! : undefined
    const targets = selectedAction?.document_ids.map(id => detail.script.artifacts?.find(doc => doc.id === id)?.title || artifactCards.find(doc => id === `legacy:${doc.artifact_type}`)?.title || '指定文档')
    const execution: ScriptExecution = { title: workflow ? `生成${workflow.stage === 'episode' ? `第 ${workflow.episode_number} 集正文` : workflowLabels[workflow.stage]}` : selectedAction ? `${selectedAction.operation === 'review' ? '评审' : '修订'}项目文档` : requestFocus === 'all' ? '剧本创作对话' : `${assetTaskMeta[requestFocus].label}创作讨论`,
      request: message.slice(0, 8000), started_at: Date.now(), focus_artifact: requestFocus, mode: requestMode, ...(targets ? { targets: targets.map(title => title.slice(0, 200)) } : {}), ...(selectedAction ? { document_action: { operation: selectedAction.operation, document_ids: selectedAction.document_ids } } : {}), ...(workflow ? { workflow } : {}) }
    const pendingMessage: Message = { id: pendingId, role: 'assistant', text: '正在整理你的想法…', pending: true, processing_started_at: startedAt, execution }
    const originalMessages = messages
    const originalConversationId = conversationId || crypto.randomUUID()
    followMessagesRef.current = true
    setMessages((current) => (retry ? [...retry.before, pendingMessage] : [...current, userMessage, pendingMessage]).slice(-80))
    const composerInput = input
    if (usesComposer) setInput('')
    if (usesComposer) setReferences([])
    if (!idea.trim()) setIdea(message)
    setWorking('chat')
    const controller = new AbortController()
    const scope = createStreamScope(controller.signal)
    streamAbortController.current = controller
    let toolRequestStarted = false
    try {
      if (requestFocus === 'all' && !adoptSource) await scope.wait(syncEditedToolDraft())
      const requestBody = {
        model_id: modelId,
        mode: requestMode,
        focus_artifact: requestFocus,
        skill_selections: skillControl.selections,
        generation_options: generationOptions,
        use_tools: requestFocus === 'all' && !adoptSource,
        ...(nextStepId ? { next_step_id: nextStepId } : {}),
        ...(selectedAction ? { document_action: { operation: selectedAction.operation, document_ids: selectedAction.document_ids } } : {}),
        ...(workflow ? { workflow } : {}),
        ...(adoptSource ? { adopt_source: adoptSource } : {}),
        ...(userMessage.question_response ? { question_response: userMessage.question_response } : {}),
        intent_context: { ...(stageContext.mode === 'explicit' ? { discussion: stageContext } : {}), ...(workflow && workflow.stage !== 'episode' ? {} : { selected_episode: workflow?.episode_number || episodeNumber }), ...(generated && !scriptSaved && !generated.tool_draft ? { pending_draft: generated.workflow || workflowRequestForStage('episode', episodeNumber) } : {}) },
        messages: conversation,
      }
      let reply: string
      toolRequestStarted = requestBody.use_tools
      try {
        reply = await streamDirectorChat(pendingId, requestBody, scope.signal)
      } catch (issue) {
        if (!(issue instanceof StreamUnavailableError)) throw issue
        const result = await scope.wait(api<StreamEvent & { reply: string }>(`/projects/${detail.id}/script/director/chat`, { ...json('POST', requestBody), signal: scope.signal }))
        reply = result.reply
        receiveToolResult(result, pendingId)
        if (result.activity) appendProcessEvent(pendingId, result)
        if (result.stage_context) setMessages(current => current.map(message => message.id === pendingId ? { ...message, stage_context: result.stage_context } : message))
        if (result.generation_options) setOptions(result.generation_options)
        if (result.generation_options?.episode_duration) setEpisodeDuration(result.generation_options.episode_duration)
        if (result.draft) {
          receiveWorkflowDraft(result.draft, pendingId)
          setMessages(current => current.map(message => message.id === pendingId ? { ...message, classification_version: replyClassificationVersion, classification: { type: 'other' } } : message))
        }
      }
      const timing = finishMessageTiming(startedAt)
      if (requestBody.use_tools) void refreshToolState().catch(() => {})
      if (usesComposer) setDocumentTask(null)
      setMessages((current) => current.map((item) => item.id === pendingId
        ? { ...item, ...timing, text: reply, pending: false } : item))
      if (retry) {
        setHistory(current => [{ id: originalConversationId, label: `原回复 · ${retry.question.text.slice(0, 80)}`, messages: originalMessages }, ...current.filter(item => item.id !== originalConversationId)].slice(0, 20))
        setConversationId(crypto.randomUUID())
        onNotice('回复已重新生成，原版本可在历史对话中查看')
      }
      if (activeFocus !== 'all' && !skipAssetStatus) setAssetTaskStatus('awaiting-confirmation')
      return reply
    } catch (issue) {
      if (toolRequestStarted) void refreshToolState(true, pendingId).catch(() => {})
      if (retry) {
        flushQueuedStreamMessage()
        setHistory(current => [{ id: originalConversationId, label: `原回复 · ${retry.question.text.slice(0, 80)}`, messages: originalMessages }, ...current.filter(item => item.id !== originalConversationId)].slice(0, 20))
        setConversationId(crypto.randomUUID())
      }
      if (usesComposer) setInput(current => current || composerInput)
      if (usesComposer) setReferences(attached)
      const timing = finishMessageTiming(startedAt)
      if (controller.signal.aborted || isAbortError(issue)) {
        flushQueuedStreamMessage()
        setMessages((current) => current.map((item) => item.id === pendingId
          ? { ...item, ...timing, execution: item.execution ? { ...item.execution, outcome: { ...item.execution.outcome, kind: 'cancelled', summary: '已停止等待本轮结果。已完成的读取和操作记录会保留。' } } : undefined, activity: settleActivity(item.activity, 'cancelled'), text: item.text && item.text !== '正在整理你的想法…' ? `${item.text}\n\n已停止生成` : '已停止生成', pending: false, failed: true }
          : item.id === userMessage.id ? { ...item, failed: true } : item))
        return null
      }
      flushQueuedStreamMessage()
      const messageText = `对话失败：${readableError(issue)}`
      setError(messageText)
      setMessages((current) => current.map((item) => item.id === pendingId
        ? { ...item, ...timing, execution: item.execution ? { ...item.execution, outcome: { ...item.execution.outcome, kind: 'failed', summary: readableError(issue).slice(0, 3000) } } : undefined, activity: settleActivity(item.activity, 'failed'), text: item.text && !/^正在/.test(item.text) ? `${item.text}\n\n${messageText}` : messageText, pending: false, failed: true } : item.id === userMessage.id ? { ...item, failed: true } : item))
    } finally {
      scope.close()
      if (streamAbortController.current === controller) streamAbortController.current = null
      chatSubmitLock.current = false
      setWorking(null)
      setLiveRevision(null)
    }
    return null
  }

  async function adoptMessage(message: Message) {
    setAdoptingMessageId(null)
    await sendChatMessage(`将选中的正文采用为第 ${episodeNumber} 集，保留原文并整理分场。`, false, undefined, false, { text: message.text, episode_number: episodeNumber })
  }

  function openExecutionDocuments() {
    setReaderKey(null); setReaderReference(null); setPreviewOpen(false); setWorkflowOpen(false); setArtifactsOpen(true)
  }

  function openExecutionSource(source: ScriptActivityTarget) {
    const saved = detail.script.artifacts?.find(item => item.id === source.id)
    const artifact = artifactCards.find(item => saved ? artifactKey(item) === artifactKey(saved) : source.id === `legacy:${item.artifact_type}`)
    if (!artifact) { openExecutionDocuments(); onNotice('这份来源文档已不存在，请在文档库查看当前资料'); return }
    setReaderKey(artifactKey(artifact))
    setReaderReference(saved && artifact.isUnsaved ? { key: artifactKey(saved), title: saved.title, artifact_type: saved.artifact_type, episode_number: saved.episode_number || 0, content: saved.content } : null)
    setArtifactsOpen(false); setPreviewOpen(false); setWorkflowOpen(false)
  }

  async function recoverExecution(message: Message) {
    if (busy || recoveringMessageId || closing) return
    setRecoveringMessageId(message.id)
    setError(null)
    try {
      const draftId = message.execution?.outcome?.draft_id || activityDraftId(message.activity)
      if (draftId && !draftId.startsWith('workflow:')) {
        const draft = await api<ScriptToolDraft>(`/projects/${detail.id}/script/director/tool-drafts/${draftId}`)
        receiveExecutionResult({ tool_draft: draft }, message.id)
        // A historical draft must not replace the current pending preview.
        if (draft.status === 'pending' && (!generated || scriptSaved || generated.tool_draft?.id === draft.id)) { receiveToolDraft(draft); return }
        if (draft.status === 'saved') await onRefresh()
        openExecutionDocuments()
        if (draft.status === 'pending') onNotice('当前还有另一份待确认草稿，请先处理它，再打开这份历史草稿')
        if (draft.status === 'discarded') onNotice('这份草稿已放弃，可以继续讨论或查看项目文档')
        return
      }
      const result = await refreshToolState(message.id === messages.at(-1)?.id, message.id === messages.at(-1)?.id ? message.id : undefined)
      await onRefresh()
      if (result?.draft && message.id === messages.at(-1)?.id) { setPreviewOpen(true); return }
      openExecutionDocuments()
      onNotice('已检查当前项目状态，未发现本轮可恢复的待确认草稿，请查看已保存文档')
    } catch (issue) { setError(`检查执行结果失败：${readableError(issue)}`) }
    finally { setRecoveringMessageId(null) }
  }

  function renderActivity(message: Message) {
    let execution = message.execution
    if (execution?.outcome?.kind === 'reply' && activeChoice?.messageId === message.id) {
      execution = { ...execution, outcome: { kind: 'question', summary: '需要你确认当前设定，请在下方回答。回答后继续讨论。' } }
    } else if (execution?.outcome?.kind === 'question' && activeChoice?.messageId !== message.id) {
      const status = choiceAnswers[message.id]?.status
      execution = { ...execution, outcome: { ...execution.outcome, kind: 'reply', summary: status === 'skipped' ? '此问题已跳过，交由模型决定。' : status === 'answered' || message.classification && 'status' in message.classification && message.classification.status === 'answered' ? '此问题已回答，后续讨论沿用已确认的设定。' : '此问题已归入历史记录，当前可操作的问题见对话下方。' } }
    } else if (execution?.outcome?.kind === 'next_step' && message.id !== messages.at(-1)?.id) {
      execution = { ...execution, outcome: { ...execution.outcome, kind: 'reply', summary: '本轮下一步建议已记录，当前创作进度和操作见对话下方。' } }
    }
    const currentDraft = generated && (generated.source_message_id === message.id || execution?.outcome?.draft_id && generated.tool_draft?.id === execution.outcome.draft_id)
    const openDraft = currentDraft ? () => { setReaderKey(null); setReaderReference(null); setArtifactsOpen(false); setWorkflowOpen(false); setPreviewOpen(true) }
      : ['draft', 'partial'].includes(execution?.outcome?.kind || '') && execution?.outcome?.draft_id && !execution.outcome.draft_id.startsWith('workflow:') ? () => void recoverExecution(message) : undefined
    const interrupted = message.failed || execution?.outcome?.kind === 'failed' || execution?.outcome?.kind === 'cancelled'
    return <DirectorActivity activity={message.activity} execution={execution} pending={message.pending} failed={message.failed}
      disabled={busy || closing || Boolean(recoveringMessageId)} onOpenDraft={openDraft} onOpenDocuments={openExecutionDocuments} onOpenSource={openExecutionSource}
      onRetry={interrupted && regenerationSource(messages, message.id) && selectedModel ? () => void regenerateReply(message) : undefined}
      onRecover={() => void recoverExecution(message)} onStop={message.pending ? stopChatGeneration : undefined} />
  }

  function replyActions(message: Message) {
    if (!regenerationSource(messages, message.id)) return null
    const retryable = canRetryExecution(message.activity) && !['draft', 'saved', 'discarded'].includes(message.execution?.outcome?.kind || '')
    const interrupted = message.failed || ['failed', 'cancelled'].includes(message.execution?.outcome?.kind || '')
    return <div className="sd-reply-actions" aria-label="回复操作">
      {retryable && !interrupted && <button type="button" disabled={busy || Boolean(classificationPending[message.id]) || closing || !selectedModel || Boolean(generated && !scriptSaved)} onClick={() => void regenerateReply(message)}
        title={generated && !scriptSaved ? '请先保存或放弃当前草稿' : '沿用原问题和引用资料重新回答；原版本保留在历史对话'}><RotateCcw size={13} />重新生成</button>}
      {activeFocus === 'all' && !message.failed && <button type="button" disabled={busy || Boolean(classificationPending[message.id]) || closing || !selectedModel} onClick={() => reclassifyReply(message)} title="保留回复内容，仅让模型重新判断选择、填写问题和分集入口">重新识别选项</button>}
    </div>
  }

  function cancelClassification() {
    const request = classificationRequest.current
    if (!request) return
    classificationRequest.current = null
    request.controller.abort()
    for (const source of request.batch) classificationAttempts.current.delete(classificationKey(source))
    setClassificationPending({})
  }

  function replyRecognition(message: Message) {
    if (activeFocus !== 'all' || busy) return null
    const state = replyRecognitionState(messages, message.id, classificationPending, classificationErrors, true)
    if (!state) return null
    return <div className="sd-reply-classification-status" role="status">
      {state === 'processing' ? <><LoaderCircle size={12} className="script-director-spinner" aria-hidden="true" />正在整理可操作项…</>
        : <>操作项整理失败，正文仍可阅读和继续讨论。<button type="button" disabled={closing || !selectedModel} onClick={() => reclassifyReply(message)}>重试识别</button></>}
    </div>
  }

  async function handleAssetConfirm() {
    if (activeFocus === 'all' || busy || !selectedModel || skillControl.loading || skillControl.error) return
    const meta = assetTaskMeta[activeFocus]
    setAssetTaskStatus('generating')
    setWorking('prompt')
    setError(null)
    try {
      const result = await api<{ prompt_zh: string; prompt_en: string; notes: string }>(`/projects/${detail.id}/script/director/asset-prompt`, json('POST', {
        model_id: modelId, focus_artifact: activeFocus, generation_options: options, skill_selections: skillControl.selections,
        messages: messages.filter(message => !message.pending && !message.failed).slice(-32).map(({ role, text }) => ({ role, text })),
      }))
      setAssetPrompt(result.prompt_zh)
      const task = await api<{ id: string; status: string }>(`/projects/${detail.id}/asset-tasks`, json('POST', {
        focus_artifact: activeFocus,
        prompt: result.prompt_zh,
      }))
      setAssetTaskId(task.id)
      setAssetTaskStatus('ready')
      appendMessage('assistant', `已整理${meta.label}生图提示词，当前编辑区使用中文版本。\n\n### 中文提示词\n${result.prompt_zh}\n\n### 英文提示词\n${result.prompt_en}${result.notes ? `\n\n### 需要核实\n${result.notes}` : ''}`)
      onNotice(`${meta.label}资料已确认，可选择图片模型生成`)
    } catch (issue) {
      setAssetTaskStatus('failed')
      setError(`保存${meta.label}任务失败：${readableError(issue)}`)
    } finally { setWorking(null) }
  }

  function retryAssetAnalysis() {
    if (activeFocus === 'all') return
    const starter = focusArtifactPrompts[activeFocus]
    setAssetPrompt('')
    setAssetTaskStatus('analyzing')
    if (starter) void sendChatMessage(starter)
  }

  function copyAssetPrompt() {
    if (!assetPrompt.trim()) return
    const write = navigator.clipboard?.writeText(assetPrompt)
    if (write) void write.then(() => onNotice('提示词已复制'))
  }

  async function generateAssetImage() {
    if (activeFocus === 'all' || !assetTaskId || !assetPrompt.trim() || !assetImageModelId || busy) return
    const model = imageModels.find((item) => item.id === assetImageModelId)
    if (!model) return
    setError(null)
    setAssetTaskStatus('generating')
    try {
      const settings = model.settings || {}
      const firstConfigured = (...keys: string[]) => {
        for (const key of keys) {
          const value = settings[key]
          if (typeof value === 'string' && value.trim()) return value
          if (Array.isArray(value)) {
            const first = value.find((item): item is string => typeof item === 'string' && item.trim().length > 0)
            if (first) return first
          }
        }
        return null
      }
      const response = await api<{ task: { id: string }; job: Job }>(`/asset-tasks/${assetTaskId}/generate`, json('POST', {
        model_id: model.id,
        prompt: assetPrompt.trim(),
        mode: 'text',
        reference_asset_ids: [],
        resolution: firstConfigured('default_resolution', 'resolution', 'resolutions'),
        clarity: firstConfigured('default_clarity', 'clarity', 'clarities'),
        quality: firstConfigured('default_quality', 'quality', 'qualities'),
        background: firstConfigured('default_background', 'background', 'backgrounds'),
        ratio: detail.ratio,
      }))
      setAssetJobId(response.job.id)
      setAssetTaskStatus('generating')
      await onRefresh()
      onNotice(`已提交${assetTaskMeta[activeFocus].noun}生成任务`)
    } catch (issue) {
      setAssetTaskStatus('failed')
      setError(`提交${assetTaskMeta[activeFocus].noun}失败：${readableError(issue)}`)
    }
  }

  async function saveAssetResult() {
    if (!assetResult || assetResult.saved) return
    try {
      await api<Asset>(`/assets/${assetResult.id}/save`, json('POST', {}))
      await onRefresh()
      onNotice('资产已保存，可在资产库中继续使用')
    } catch (issue) {
      setError(`保存资产失败：${readableError(issue)}`)
    }
  }

  function stopChatGeneration() {
    streamAbortController.current?.abort()
  }

  async function generateScript() {
    if (skillControl.loading || skillControl.error) { setError(skillControl.error || '正在读取技能配置'); return }
    const attached = references
    const composerInput = input
    const message = currentDraftIdea()
    if (!message) { setError('先输入一个故事想法'); return }
    if (!modelId || !selectedModel) { setError('请选择文本模型'); return }
    const startedAt = performance.now()
    setError(null)
    let promptToUse = prompt
    if (!promptCustomized || !promptToUse.trim()) {
      setWorking('prompt')
      setPromptOpen(true)
      setPromptLoading(true)
      setPromptError(null)
      try {
        const result = await api<{ prompt: string }>(`/projects/${detail.id}/script/generate/prompt`, json('POST', {
        skill_selections: skillControl.selections,
          idea: message,
          generation_options: options,
        }))
        setBasePrompt(result.prompt)
        promptToUse = promptForMode(result.prompt, mode)
        setPrompt(promptToUse)
        setPromptCustomized(false)
      } catch (issue) {
        const messageText = `提示词加载失败：${readableError(issue)}`
        setPromptError(messageText)
        setError(messageText)
        setWorking(null)
        return
      } finally {
        setPromptLoading(false)
      }
    }
    if (input.trim() || attached.length) {
      const messageText = input.trim() || '参考引用文档，生成完整剧本草稿。'
      const userMessage: Message = { id: crypto.randomUUID(), role: 'user', text: messageText, reference_documents: attached }
      setMessages(current => [...current, userMessage].slice(-80))
      if (!idea.trim()) setIdea(messageText)
      setInput('')
    }
    const pendingId = crypto.randomUUID()
    const pendingMessage: Message = { id: pendingId, role: 'assistant', text: '正在整理故事结构、人物关系和场次节奏…', pending: true, processing_started_at: startedAt }
    setMessages((current) => [...current, pendingMessage].slice(-80))
    setWorking('generate')
    try {
      const result = await api<GeneratedScript>(`/projects/${detail.id}/script/generate`, json('POST', {
        skill_selections: skillControl.selections,
        model_id: modelId,
        idea: message,
        generation_options: options,
        prompt_override: promptToUse,
        reference_documents: attached,
      }))
      const next: GeneratedScript = {
        outline: typeof result.outline === 'string' ? result.outline : '',
        characters: typeof result.characters === 'string' ? result.characters : '',
        scenes: Array.isArray(result.scenes) ? result.scenes.map(normaliseScene) : [],
        artifacts: Array.isArray(result.artifacts)
          ? result.artifacts.map(normaliseArtifact).filter((artifact): artifact is GeneratedArtifact => artifact !== null)
          : [],
      }
      setReferences([])
      setGenerated(next)
      setPreviewOpen(true)
      setArtifactsOpen(true)
      const timing = finishMessageTiming(startedAt)
      setMessages((current) => current.map((item) => item.id === pendingId && item.pending
        ? { ...item, ...timing, text: `剧本草稿已经完成，共 ${next.scenes.length} 场、约 ${next.scenes.reduce((sum, scene) => sum + scene.duration, 0)} 秒。你可以先查看预览，确认后写入项目。`, pending: false, classification_version: replyClassificationVersion, classification: { type: 'other' } }
        : item))
    } catch (issue) {
      setInput(current => current || composerInput)
      setError(`生成失败：${readableError(issue)}`)
      const timing = finishMessageTiming(startedAt)
      setMessages((current) => current.map((item) => item.id === pendingId && item.pending
        ? { ...item, ...timing, text: `生成没有完成：${readableError(issue)}`, pending: false, failed: true, classification_version: replyClassificationVersion, classification: { type: 'other' } }
        : item))
    } finally {
      setWorking(null)
    }
  }

  async function saveGenerated() {
    const brief = messages.find((message) => message.role === 'user')?.text.trim() || idea.trim()
    if (!generated) return
    if (!generated.workflow && !generated.tool_draft && !brief) { setError('请先补充故事想法，再保存完整剧本。'); return }
    setWorking('save')
    setError(null)
    try {
      if (generated.tool_draft) {
        const draft = (await syncEditedToolDraft())!
        const saved = await api<ScriptToolDraft>(`/projects/${detail.id}/script/director/tool-drafts/${draft.id}/commit`, json('POST', { version: draft.version, approved: true }))
        receiveToolDraft(saved)
        if (saved.workflow?.stage === 'episode') setHandoffEpisode(saved.workflow.episode_number)
        appendMessage('assistant', saved.kind === 'resource' ? '视觉设定或分镜修改已保存。可以在视觉设定列表或分镜中查看。' : '文档已保存，未涉及的资料继续保留。')
        await onRefresh().catch(() => onNotice('文档已保存，项目刷新失败，请稍后重试'))
        await refreshToolState().catch(() => { setCreation(null) })
        onNotice(saved.kind === 'resource' ? '视觉设定或分镜已保存' : '文档已保存')
        return
      }
      if (generated.workflow) {
        const saved = await api<ProjectDetail['script']>(`/projects/${detail.id}/script/director/draft`, json('PUT', {
          ...generated.workflow,
          ...(!detail.brief.trim() && brief ? { brief } : {}),
          generation_options: options,
          artifacts: generated.artifacts.map(({ artifact_type, title, content }) => ({ artifact_type, title, content })),
          scenes: generated.scenes.map(({ episode_number: _episode, ...scene }) => scene),
        }))
        const completed = generated.workflow.stage
        setPreviewOpen(false)
        setScriptSaved(true)
        if (generated.source_message_id) setMessages(current => current.map(message => message.id === generated.source_message_id && message.execution ? { ...message,
          execution: { ...message.execution, outcome: { ...message.execution.outcome, kind: 'saved', summary: '当前阶段草稿已写入项目，可以查看保存结果。' } } } : message))
        const next = workflowProgress(saved)
        setWorkflowStage(next.next_stage || 'episode')
        if (next.next_episode) setEpisodeNumber(next.next_episode)
        if (completed === 'episode') {
          setHandoffEpisode(generated.workflow.episode_number)
        }
        const suggestion = next.next_stage ? `按已保存成果，建议接下来${next.next_stage === 'episode' ? `写第 ${next.next_episode} 集正文` : `补充${workflowLabels[next.next_stage]}`}。` : '全剧资料与已设定集数的正文已齐备，可以核对连续性或制作分镜。'
        appendMessage('assistant', `${completed === 'episode' ? `第 ${generated.workflow.episode_number} 集` : workflowLabels[completed]}已保存。${suggestion}${completed === 'outline' && next.completed.characters ? '已有全剧人物设定会继续复用；如主线变化影响人物，只需针对相关部分更新。' : ''}`)
        await onRefresh().catch(() => onNotice('草稿已保存，项目刷新失败，请稍后重试'))
        await refreshToolState().catch(() => { setCreation(null) })
        onNotice('当前阶段已保存')
        return
      }
      const linkedSceneIds = new Set(detail.shots.map((shot) => shot.source_scene_id).filter((id): id is string => !!id))
      const linkedScenes = detail.script.scenes.filter((scene) => linkedSceneIds.has(scene.id) || (scene.episode_number || 0) > 0).map((scene) => ({
        id: scene.id,
        episode_number: scene.episode_number,
        heading: scene.heading,
        location: scene.location,
        time_of_day: scene.time_of_day,
        characters: scene.characters,
        action: scene.action,
        dialogue: scene.dialogue,
        narration: scene.narration,
        duration: scene.duration,
      }))
      const artifactMap = new Map<string, GeneratedArtifact>()
      detail.script.artifacts?.forEach(artifact => artifactMap.set(artifactKey(artifact), artifact))
      generated.artifacts.forEach(artifact => artifactMap.set(artifactKey(artifact), artifact))
      if (!artifactMap.has('outline:0') && generated.outline.trim()) artifactMap.set('outline:0', { artifact_type: 'outline', title: '故事大纲', content: generated.outline })
      if (!artifactMap.has('characters:0') && generated.characters.trim()) artifactMap.set('characters:0', { artifact_type: 'characters', title: '人物小传', content: generated.characters })
      if (!artifactMap.has('structure:0') && generatedStructure.trim()) artifactMap.set('structure:0', { artifact_type: 'structure', title: '全剧分段', content: generatedStructure })
      const artifactPayload = [...artifactMap.values()]
        .map((artifact, position) => ({ ...artifact, position, status: 'ready' as const }))
      await api<ProjectDetail['script']>(`/projects/${detail.id}/script/commit`, json('PUT', {
        brief,
        outline: generated.outline,
        characters: generated.characters,
        generation_options: options,
        scenes: [...linkedScenes, ...generated.scenes],
        artifacts: artifactPayload,
      }))
      setPreviewOpen(false)
      setScriptSaved(true)
      if (generated.source_message_id) setMessages(current => current.map(message => message.id === generated.source_message_id && message.execution ? { ...message,
        execution: { ...message.execution, outcome: { ...message.execution.outcome, kind: 'saved', summary: '创作文本已写入项目，可以查看保存结果。' } } } : message))
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        text: `创作文本已保存到项目：${artifactPayload.length} 份剧本文档、${generated.scenes.length} 个场次。你可以继续补充内容，或将场次加入故事板。`,
        classification_version: replyClassificationVersion, classification: { type: 'other' } as ReplyClassification,
      }].slice(-80))
      try {
        await onRefresh()
        onNotice('剧本已写入项目')
      } catch {
        onNotice('剧本已写入项目，项目刷新失败，请稍后重试')
      }
    } catch (issue) {
      setError(`保存失败：${readableError(issue)}`)
    } finally {
      setWorking(null)
    }
  }

  function handleInputKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (shouldSendDirectorMessage({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) {
      event.preventDefault()
      void sendChatMessage()
    }
  }

  function startWindowGesture(event: React.PointerEvent<HTMLElement>, resize = false) {
    if (windowLayout.docked || event.button !== 0 || (!resize && (event.target as HTMLElement).closest('button, input'))) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, rect: windowLayout.rect, resize }
  }
  function moveWindowGesture(event: React.PointerEvent<HTMLElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointer !== event.pointerId) return
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y
    const rect = gesture.resize ? { ...gesture.rect, width: gesture.rect.width + dx, height: gesture.rect.height + dy }
      : { ...gesture.rect, x: gesture.rect.x + dx, y: gesture.rect.y + dy }
    setWindowLayout(current => ({ ...current, rect: clampDirectorWindow(rect, { width: window.innerWidth, height: window.innerHeight }) }))
  }
  function latestMessages() {
    followMessagesRef.current = true
    setShowLatest(false)
    messagesViewportRef.current?.scrollTo({ top: messagesViewportRef.current.scrollHeight, behavior: 'smooth' })
  }

  async function closeDirector() {
    if (closing) return
    if (busy) {
      setMinimized(true)
      onNotice('任务仍在运行，对话已收起，可展开查看或停止生成')
      return
    }
    setClosing(true)
    // Flush the active conversation before unmounting; the normal debounce
    // would otherwise drop a just-completed reply when the user closes it.
    ++conversationSaveSerial.current
    if (remoteConversationSaveTimer.current !== null) window.clearTimeout(remoteConversationSaveTimer.current)
    try { window.localStorage.setItem(directorStorageKey(detail.id), JSON.stringify({ messages: messages.slice(-80), history: history.slice(0, 20) })) } catch { /* API remains available. */ }
    if (conversationSyncReady.current) {
      const snapshots = [...history.slice(0, 20), { id: conversationId || crypto.randomUUID(), label: messages.find(message => message.role === 'user')?.text || '当前对话', messages }]
      try {
        for (const conversation of snapshots) await api(`/projects/${detail.id}/script/conversations`, json('PUT', {
          id: conversation.id, label: conversation.label,
          messages: conversation.messages.filter(message => !message.pending).slice(-80).map(conversationMessage),
        }))
      } catch { onNotice('对话已缓存在本机，服务端保存失败，请稍后重试') }
    }
    onClose()
  }

  return <aside
    hidden={hidden}
    className={`script-director-panel sd-chat${previewOpen && generated ? ' is-reviewing' : ''}${windowLayout.docked ? ' is-docked' : ''}${minimized ? ' is-minimized' : ''}${(windowLayout.docked ? window.innerHeight : windowLayout.rect.height) <= 520 ? ' is-compact' : ''}`}
    style={{ '--chat-x': `${windowLayout.rect.x}px`, '--chat-y': `${windowLayout.rect.y}px`, '--chat-width': `${windowLayout.rect.width}px`, '--chat-height': `${windowLayout.rect.height}px` } as CSSProperties}
    data-canvas-overlay
    onKeyDown={event => {
      if (event.key !== 'Escape') return
      if (settingsOpen) setSettingsOpen(false)
      else if (composerMenuOpen) setComposerMenuOpen(false)
      else if (historyOpen) setHistoryOpen(false)
      else if (workflowOpen) setWorkflowOpen(false)
      else if (artifactsOpen) setArtifactsOpen(false)
      else if (readerKey || readerReference) { setReaderKey(null); setReaderReference(null) }
      else return
      event.preventDefault(); event.stopPropagation()
    }}
    aria-label="剧本导演"
    ref={directorPanelRef}
  >
    <header className="script-director-header" onPointerDown={startWindowGesture} onPointerMove={moveWindowGesture} onPointerUp={() => { gestureRef.current = null }} onPointerCancel={() => { gestureRef.current = null }}>
      <div className="script-director-title">
        <strong title={messages.find(message => message.role === 'user')?.text || '剧本创作'}>{messages.find(message => message.role === 'user')?.text.replace(/[#*`]/g, '').slice(0, 32) || '剧本创作'}</strong>
        <div className="sd-title-meta"><small>{detail.name || '未命名项目'}</small>
        </div>
      </div>
      <div className="script-director-header-actions">
        <button type="button" title="新建对话" aria-label="新建对话" onClick={startNewConversation} disabled={busy}><MessageCirclePlus size={17} /></button>
        <button type="button" title="历史对话" aria-label="历史对话" className={historyOpen ? 'is-active' : 'is-muted'} onClick={() => setHistoryOpen((value) => !value)}><History size={16} /></button>
        <button type="button" title="剧本设定" aria-label="剧本设定" onClick={openSettings}><Settings2 size={16} /></button>
        <button type="button" title={`项目文档 · ${artifactCards.length}`} aria-label="项目文档" aria-expanded={artifactsOpen} onClick={() => { setArtifactsOpen(value => !value); setWorkflowOpen(false); setReaderKey(null); setMinimized(false) }}><FileText size={16} /></button>
        <button type="button" title={windowLayout.docked ? '切换为浮窗' : '停靠到右侧'} aria-label={windowLayout.docked ? '切换为浮窗' : '停靠到右侧'} onClick={() => setWindowLayout(current => ({ ...current, docked: !current.docked }))}><PanelRight size={16} /></button>
        <button type="button" title={minimized ? '展开对话' : '收起对话'} aria-label={minimized ? '展开对话' : '收起对话'} onClick={() => setMinimized(value => !value)}>{minimized ? <Maximize2 size={16} /> : <Minus size={16} />}</button>
        <button type="button" title={busy ? '收起运行中的对话' : '关闭'} aria-label="关闭剧本导演" disabled={closing} onClick={() => void closeDirector()}>{closing ? <LoaderCircle size={16} className="script-director-spinner" /> : <X size={18} />}</button>
      </div>
    </header>
    {historyOpen && <div className="script-director-history" role="listbox" aria-label="历史对话">
      <strong>历史对话</strong>
      {history.length ? history.map((conversation) => <button type="button" key={conversation.id} disabled={busy} onClick={() => switchConversation(conversation)}>
        <History size={13} /><span>{conversation.label}</span>
      </button>) : <p>当前还没有历史对话</p>}
    </div>}

    <div className="sd-chat-main" hidden={minimized || Boolean(readerArtifact)}>
    <div
      className="script-director-messages"
      role="log"
      aria-label="导演对话消息"
      aria-live="polite"
      ref={messagesViewportRef}
      onScroll={updateMessageFollow}
    >
      {activeFocus !== 'all' && <AssetTaskCard
      detail={detail}
      generated={generated}
      focus={activeFocus}
      status={assetTaskStatus}
      prompt={assetPrompt}
      imageModels={imageModels}
      imageModelId={assetImageModelId}
      resultAsset={assetResult}
      onImageModelChange={setAssetImageModelId}
      onPromptChange={setAssetPrompt}
      onConfirm={() => void handleAssetConfirm()}
      onRetry={retryAssetAnalysis}
      onGenerate={() => void generateAssetImage()}
      onSave={() => void saveAssetResult()}
      onCopy={copyAssetPrompt}
      onOpenModels={onOpenModels}
    />}
      {messages.map((message) => {
        const parsedChoices = replyChoices(message)
        const semanticChoices = contextualReplyTypes.includes(message.classification?.type || '') && !parseMessageChoices(message.text)
        const dismissed = Boolean(choiceDismissed[message.id])
        const storedAnswer = choiceAnswers[message.id]
        const answer = storedAnswer?.status === 'skipped' ? undefined : storedAnswer?.status === 'answered'
          ? parsedChoices ? choiceAnswerText(parsedChoices, storedAnswer) : storedAnswer.text
          : undefined
        if (parsedChoices) return <div className="script-director-message assistant" data-message-id={message.id} key={message.id}>
          {renderActivity(message)}
          <div className="sd-choice-explanation">
            {semanticChoices ? <DirectorMessageText text={replyDisplayText(message)} /> : <>
            {parsedChoices.intro && <DirectorMessageText text={parsedChoices.intro} />}
            {parsedChoices.confirmation && <DirectorMessageText text={parsedChoices.question} />}
            {(parsedChoices.questions || [parsedChoices]).map((item, index) => <div key={index}>
            {parsedChoices.questions && <DirectorMessageText text={item.question} />}
            {!item.confirmation && item.options.filter(option => option.kind !== 'custom').map(option => <div className="sd-choice-direction" key={option.label}>
              {!option.text.replace(/[*#`]/g, '').startsWith(option.title.split(/[｜|]/)[0].trim()) && <strong>{option.title}</strong>}
              <DirectorMessageText text={option.text} />
            </div>)}</div>)}
            {parsedChoices.trailing && <DirectorMessageText text={parsedChoices.trailing} />}
            </>}
          </div>
          {activeChoice?.messageId === message.id ? <span className="sd-question-status">请在下方回答</span>
            : <details className="sd-answered-question"><summary>{storedAnswer?.status === 'skipped' ? '已跳过' : answer || message.classification && 'status' in message.classification && message.classification.status === 'answered' ? '已回答' : dismissed ? '已结束' : '历史问题'}</summary><p>{parsedChoices.question}</p>{answer && <p>{answer}</p>}</details>}
          <DirectorMessageTiming {...message} />
          {replyRecognition(message)}
          {replyActions(message)}
        </div>
        return <div className={`script-director-message ${message.role}`} data-message-id={message.id} key={message.id}>
          <DirectorReferences documents={readReferences(message.reference_documents)} onOpen={setReaderReference} />
          {message.role === 'assistant' && renderActivity(message)}
          {(!message.pending || message.has_reply_text || !message.execution && !message.activity?.length) && <div className={`script-director-bubble${message.pending && !message.has_reply_text ? ' is-pending' : ''}`}>
            {message.pending && !message.has_reply_text ? <><LoaderCircle size={13} className="script-director-spinner" /><span>{message.text}</span></> : message.role === 'assistant' ? <DirectorMessageText text={replyDisplayText(message)} /> : message.text}
          </div>}
          {message.review && !message.pending && <DirectorReviewReport review={message.review} />}
          {message.role === 'assistant' && <DirectorMessageTiming {...message} />}
          {activeFocus === 'all' && stageContext.stage === 'episode' && stageContext.mode !== 'review' && canAdoptReply(message) && <div className="sd-message-adopt">
            {adoptingMessageId === message.id ? <>
              <label>采用为第 <input type="number" min={1} max={200} value={episodeNumber} aria-label="采用为第几集" onChange={event => setEpisodeNumber(Math.max(1, Math.min(200, Number(event.currentTarget.value) || 1)))} /> 集</label>
              <button type="button" disabled={busy} onClick={() => void adoptMessage(message)}>整理为分集草稿</button>
              <button type="button" onClick={() => setAdoptingMessageId(null)}>取消</button>
            </> : <button type="button" disabled={busy || Boolean(generated && !scriptSaved)} onClick={() => { if (message.classification?.type === 'episode_script' && message.classification.episode_number) setEpisodeNumber(message.classification.episode_number); setAdoptingMessageId(message.id) }}>采用为分集剧本</button>}
          </div>}
          {replyRecognition(message)}
          {replyActions(message)}
        </div>
      })}
    {(!!artifactCards.length || hasSavedScript && detail.script.scenes.length > 0) && <section className="sd-deliverables" aria-label="创作成果">
      <header><span>创作成果</span><button type="button" onClick={() => { setArtifactsOpen(true); setWorkflowOpen(false); setReaderKey(null) }}>文档库 <span>{artifactCards.length}</span><ChevronRight size={13} /></button></header>
      {generated && !scriptSaved ? <button type="button" className="sd-deliverable-document" aria-label={generated.workflow?.stage === 'episode' ? `查看第 ${generated.workflow.episode_number} 集草稿` : '查看草稿'} onClick={() => { setReaderKey(null); setArtifactsOpen(false); setWorkflowOpen(false); setPreviewOpen(true) }}>
        <span className="sd-document-icon"><FileText size={18} /></span><span><strong>{generated.tool_draft?.kind === 'resource' ? '视觉设定与分镜草稿' : generated.workflow?.stage === 'episode' ? `第 ${generated.workflow.episode_number} 集草稿` : '待确认的创作草稿'}</strong><small>{generated.tool_draft?.kind === 'resource' ? `${generated.resource_changes?.length || 0} 项修改` : `${generated.artifacts.length} 份文档`} · 预览后确认保存</small></span><span className="sd-document-status">待确认</span><ChevronRight size={15} />
      </button> : primaryArtifact && <button type="button" className="sd-deliverable-document" onClick={() => { setReaderKey(artifactKey(primaryArtifact)); setArtifactsOpen(false); setWorkflowOpen(false) }}>
        <span className="sd-document-icon"><FileText size={18} /></span><span><strong>{primaryArtifact.artifact_type === 'episode_script' ? `第 ${primaryArtifact.episode_number} 集剧本` : primaryArtifact.title}</strong><small>{primaryArtifact.title}{primaryArtifact.artifact_type === 'episode_script' && primaryArtifactScenes.length ? ` · ${primaryArtifactScenes.length} 场 · ${primaryArtifactScenes.reduce((sum, scene) => sum + scene.duration, 0)} 秒` : ''}</small></span><span className="sd-document-status">已保存</span><ChevronRight size={15} />
      </button>}
      {hasSavedScript && detail.script.scenes.length > 0 && <section className="sd-production-row" aria-label="故事板制作">
        <div className="sd-production-target"><span><Clapperboard size={14} />制作分镜</span>
          {!!savedEpisodes.length && <Select className="sd-episode-select" aria-label="选择制作分镜的集数" value={String(handoffEpisode)} allowDeselect={false}
            rightSection={<ChevronDown size={14} />} comboboxProps={{ withinPortal: true, zIndex: 400 }}
            data={[{ value: '0', label: '全部场次' }, ...savedEpisodes.map(artifact => ({ value: String(artifact.episode_number), label: `第 ${artifact.episode_number} 集` }))]}
            onChange={value => value !== null && setHandoffEpisode(Number(value))} />}
        </div>
        <div className="sd-production-action"><small>{handoffScenes.length} 场 · 规划后加入</small>
          <button type="button" className="sd-document-primary" title="规划并确认分镜后加入画布" onClick={() => { setPlanningSceneIds(handoffScenes.map(scene => scene.id)); setStoryboardOpen(true) }} disabled={busy || !handoffScenes.length}><Plus size={14} />加入画布</button>
        </div>
      </section>}
    </section>}

    {activeFocus === 'all' && !previewOpen && !artifactsOpen && !workflowOpen && <nav className="sd-creation-actions" aria-label="创作操作">
      {(creation?.status !== 'direction' || busy || generated && !scriptSaved) && <span className="sd-creation-progress" role="status">{generated && !scriptSaved ? generated.tool_draft?.revision_task && generated.tool_draft.revision_task.status !== 'ready' ? '统一修订未完成' : '草稿待确认' : busy ? '正在处理当前创作'
        : creation?.status === 'complete' ? '可核对连续性或制作分镜' : nextStep ? '下一步：' : '继续讨论当前创作'}</span>}
      {generated?.tool_draft?.revision_task && generated.tool_draft.revision_task.status !== 'ready' && !scriptSaved && <button type="button" disabled={busy || closing || !selectedModel} onClick={continueRevisionTask}>继续统一修订<ChevronRight size={14} /></button>}
      {!busy && !closing && !activeChoice && !(generated && !scriptSaved) && nextStep && <button type="button" disabled={!selectedModel}
        title={nextStep.basis || nextStep.summary}
        onClick={() => generateWorkflow(nextStep.stage, `${nextStep.purpose === 'revise' ? '修订' : '生成'}${nextStep.stage === 'episode' ? `第 ${nextStep.episode_number} 集正文` : workflowLabels[nextStep.stage]}`, nextStep.episode_number, nextStep)}>
        <FileText size={14} aria-hidden="true" />{nextStep.purpose === 'revise' ? '修订' : '生成'}{nextStep.stage === 'episode' ? `第 ${nextStep.episode_number} 集正文` : workflowLabels[nextStep.stage]}
      </button>}
      {directionStart && !busy && !activeChoice && !(generated && !scriptSaved) && <button type="button" disabled={closing || !selectedModel}
        title="提供几个故事方向供你选择"
        onClick={() => void sendChatMessage('基于当前对话，给我几个故事方向供选择。保留已经确认的设定，说明各方向的区别。')}>
        <Lightbulb size={14} aria-hidden="true" />探索故事方向
      </button>}
    </nav>}
    </div>
    <StoryboardPlanner opened={storyboardOpen} onClose={() => setStoryboardOpen(false)} detail={detail} models={availableModels} initialSceneIds={planningSceneIds}
      onRefresh={onRefresh} onOpenCanvas={onClose} onNotice={onNotice} />
    {artifactsOpen && <section className="sd-utility-panel" aria-label="项目文档列表">
      <header><strong>项目文档 · {artifactCards.length}</strong><button type="button" aria-label="关闭项目文档" onClick={() => setArtifactsOpen(false)}><X size={16} /></button></header>
      <div className="sd-utility-body">
        {!!decisions.length && <details className="sd-story-decisions"><summary>已确认设定 · {decisions.length}</summary>{decisions.map(decision => <div key={decision.id}><strong>{decision.topic}</strong><p>{decision.content}</p><small>{decision.basis === 'delegated_model' ? '跳过后由模型确定' : '创作者确认'}</small><details><summary>查看确认来源</summary><p>{decision.source_text}</p></details></div>)}<small>需要调整时，在对话中说明要修改的设定。</small></details>}
        {artifactCards.length ? artifactCards.map(artifact => <button type="button" className="sd-artifact-card" key={artifactKey(artifact)} aria-label={`阅读文档：${artifact.title}`} onClick={() => { setReaderKey(artifactKey(artifact)); setArtifactsOpen(false) }}>
          <FileText size={18} /><span><strong>{artifact.title}</strong><small>{artifact.isUnsaved ? '草稿待确认' : '已保存文档'}{artifact.episode_number ? ` · 第 ${artifact.episode_number} 集` : ''}</small></span><ChevronRight size={14} />
        </button>) : <p className="sd-utility-empty">还没有项目文档。可以先讨论故事方向，再生成并确认保存大纲、人物和分集正文。</p>}
      </div>
    </section>}
    {workflowOpen && <section className="sd-utility-panel" aria-label="分阶段生成面板">
      <header><strong>分阶段生成</strong><button type="button" aria-label="关闭分阶段生成" onClick={() => setWorkflowOpen(false)}><X size={16} /></button></header>
      <div className="sd-utility-body">
        <p>{workflowStage === 'episode' ? `本次仅创作第 ${episodeNumber} 集正文，承接全剧资料，不修改其他集。` : '本次整理全剧资料，覆盖整个故事；不会生成下一集正文。'}生成后可编辑、确认保存。</p>
        <p>推荐顺序：大纲 → 人物与关系 → 场景 → 道具 → 分集正文。{progress.next_stage ? `当前建议：${progress.next_stage === 'episode' ? `第 ${progress.next_episode} 集正文` : workflowLabels[progress.next_stage]}。` : '当前资料与正文已齐备。'}已有文档会复用，你也可以自行选择其他阶段。</p>
        {availableModels.length ? <>{modelSelector}{skillSelector}</> : <button type="button" className="script-director-model-link" onClick={onOpenModels}>配置可用文本模型</button>}
        <Select label="创作阶段" aria-label="创作阶段" value={workflowStage} allowDeselect={false}
          data={workflowStages.map(stage => ({ value: stage, label: `${workflowLabels[stage]}${stage !== 'episode' && progress.completed[stage] ? ' · 已有' : ''}` }))}
          disabled={busy || Boolean(generated && !scriptSaved)} onChange={value => value && setWorkflowStage(value as WorkflowStage)} />
        {workflowStage === 'episode' && <div className="script-director-episode-fields">
          <label>第 <input type="number" min={1} max={200} value={episodeNumber} aria-label="生成第几集" disabled={busy} onChange={event => setEpisodeNumber(Math.max(1, Math.min(200, Number(event.currentTarget.value) || 1)))} /> 集</label>
          <label>单集 <input type="number" min={5} max={600} value={episodeDuration ?? ''} placeholder="自动" aria-label="单集目标秒数" disabled={busy} onChange={event => { const duration = event.currentTarget.value ? Math.max(5, Math.min(600, Number(event.currentTarget.value) || 5)) : undefined; setEpisodeDuration(duration); setOptions(current => ({ ...current, episode_duration: duration })) }} /> 秒</label>
        </div>}
        {generated && !scriptSaved ? <div className="script-director-workflow-actions">
          <button type="button" onClick={() => { setWorkflowOpen(false); setPreviewOpen(true) }}>查看待确认草稿</button>
          <button type="button" disabled={busy} onClick={() => void discardGenerated()}>放弃草稿</button>
        </div> : <button type="button" className="script-director-workflow-generate" disabled={busy || !selectedModel || !references.length && !input.trim() && !idea.trim() && !messages.some(message => message.role === 'user')} onClick={() => { setWorkflowOpen(false); generateWorkflow() }}><FileText size={13} />{`生成${workflowStage === 'episode' ? `第 ${episodeNumber} 集正文` : workflowLabels[workflowStage]}`}</button>}
        {promptCustomized && <button type="button" className="script-director-workflow-generate" disabled={busy || !selectedModel || Boolean(generated && !scriptSaved)} onClick={() => { setWorkflowOpen(false); void generateScript() }}>按自定义提示词生成完整草稿</button>}
      </div>
    </section>}
    {showLatest && <button type="button" className="sd-latest" onClick={latestMessages}><ArrowDown size={14} />回到最新消息</button>}

    {error && <div className="script-director-error" role="alert">{error}<button type="button" onClick={() => setError(null)} aria-label="关闭错误"><X size={14} /></button></div>}

    {liveRevision && <RevisionProgress task={liveRevision} working={working === 'chat'} />}
    {previewOpen && generated && <DirectorDraftReview draft={generated} busy={busy} saving={working === 'save'} saved={scriptSaved} onChange={setGenerated} onClose={() => setPreviewOpen(false)} onSave={() => void saveGenerated()} onDiscard={() => void discardGenerated()}
      onContinue={generated.tool_draft?.revision_task ? continueRevisionTask : undefined}
      profileNames={Object.fromEntries((detail.visual_profiles || []).map(profile => [profile.id, `${profile.name} · ${profile.variant}`]))} sceneNames={Object.fromEntries(detail.script.scenes.map(scene => [scene.id, scene.heading]))} />}
    {!previewOpen && !artifactsOpen && !workflowOpen && <section className={`sd-composer-area${composerCollapsed ? ' is-collapsed' : ''}`} aria-label="对话输入区">
      <div className="sd-composer-area-head">
        {composerCollapsed ? <button type="button" className="sd-composer-expand" aria-expanded={false} aria-controls={composerBodyId} onClick={() => setComposerCollapsed(false)}>
          <PanelBottomOpen size={15} /><span>展开输入区</span><small>{activeChoice ? '有选项待回答' : [input.length ? `草稿 ${input.length} 字` : '', references.length ? `已引用 ${references.length} 份文档` : ''].filter(Boolean).join(' · ')}</small>
        </button> : <>
          {!previewOpen && !artifactsOpen && !workflowOpen ? <div className="sd-skill-context" aria-label="当前创作技能">
            <span>{currentSkillStage === 'script' ? '创作技能' : '视觉设定技能'}</span>{skillSelector}
          </div> : <span className="sd-composer-area-label">输入区</span>}
          <button type="button" className="sd-composer-collapse" aria-label="收起输入区" title="收起输入区" aria-expanded={true} aria-controls={composerBodyId} onClick={() => { setComposerCollapsed(true); setComposerMenuOpen(false) }}><PanelBottomClose size={14} /><span>收起</span></button>
        </>}
        {composerCollapsed && working === 'chat' && <button type="button" className="sd-composer-stop" aria-label="停止生成" title="停止生成" onClick={stopChatGeneration}><Square size={12} fill="currentColor" /><span>停止生成</span></button>}
      </div>
      <div id={composerBodyId} className="sd-composer-area-content" hidden={composerCollapsed}>
    {activeChoice && !previewOpen && !references.length ? <DirectorQuestionPanel key={activeChoice.messageId}
      choice={activeChoice.choice} answer={choiceAnswers[activeChoice.messageId] || { custom: false, text: '' }} busy={busy} unavailable={!selectedModel} controls={availableModels.length ? modelSelector : undefined} onConfigure={onOpenModels} onStop={working === 'chat' ? stopChatGeneration : undefined}
      onChange={answer => setChoiceAnswers(current => ({ ...current, [activeChoice.messageId]: answer }))}
      onSkip={() => skipQuestion(activeChoice.messageId, activeChoice.choice.question)}
      onContinue={answer => answerQuestion(activeChoice.messageId, activeChoice.choice.question, answer)} />
      : <div className={`script-director-composer ${promptOpen ? 'is-prompt-open' : ''}`}>
      <DirectorReferences documents={references} disabled={busy} onOpen={setReaderReference} onRemove={key => setReferences(current => current.filter(document => document.key !== key))} />
      {documentTask && <div className="sd-document-task"><span>修订：{documentTask.title}</span><button type="button" aria-label="取消定向修订" disabled={busy} onClick={() => setDocumentTask(null)}><X size={13} /></button></div>}
      <textarea ref={composerRef} value={input} maxLength={8000} onChange={(event) => setInput(event.currentTarget.value)} onKeyDown={handleInputKeyDown} placeholder={activeFocus === 'all' ? '聊聊你的故事想法…' : `描述你希望如何处理${focusArtifactLabels[activeFocus]}…`} aria-label="剧本创作对话" disabled={busy} />
      {promptOpen && <div className="script-director-prompt-editor">
        <div className="script-director-prompt-head"><span>实际发送提示词</span><button type="button" onClick={() => void refreshPrompt()} disabled={promptLoading || busy}>恢复自动提示词</button></div>
        <textarea value={prompt} onChange={(event) => { setPromptCustomized(true); setPrompt(event.currentTarget.value) }} placeholder="正在生成提示词…" disabled={promptLoading || busy} />
        {promptError && <small>{promptError}</small>}
      </div>}
      <div className="script-director-composer-toolbar">
        <button type="button" className="sd-composer-add" aria-label="对话工具" aria-expanded={composerMenuOpen} onClick={() => setComposerMenuOpen(value => !value)}><Plus size={19} /></button>
        {composerMenuOpen && <div className="sd-composer-menu" role="menu" aria-label="对话工具菜单">
          <button type="button" role="menuitem" disabled={busy} onClick={() => { setComposerMenuOpen(false); openSettings() }}><Settings2 size={15} />剧本设定</button>
          <button type="button" role="menuitem" onClick={() => { setComposerMenuOpen(false); setWorkflowOpen(true); setArtifactsOpen(false) }}><FileText size={15} />分阶段生成</button>
          <button type="button" role="menuitem" onClick={() => { setComposerMenuOpen(false); setArtifactsOpen(true); setWorkflowOpen(false) }}><FileText size={15} />项目文档 · {artifactCards.length}</button>
          <button type="button" role="menuitem" onClick={() => { setComposerMenuOpen(false); void refreshPrompt() }} disabled={busy}><PenLine size={15} />编辑发送提示词</button>
        </div>}
        <Select
          className="script-director-mode-select"
          aria-label="创作模式"
          value={mode}
          data={directorModes.map(value => ({ value, label: directorModeProfiles[value].label }))}
          allowDeselect={false}
          rightSection={<ChevronDown size={13} />}
          size="xs"
          comboboxProps={{ withinPortal: true, zIndex: 400, position: 'top-start' }}
          onChange={(value) => {
            if (!value) return
            const nextMode = value as DirectorMode
            setMode(nextMode)
            if (!promptCustomized && basePrompt) setPrompt(promptForMode(basePrompt, nextMode))
          }}
        />
        {modelSelector}
        <button type="button" className="script-director-send" onClick={() => working === 'chat' ? stopChatGeneration() : void sendChatMessage()} disabled={working === 'chat' ? false : busy || skillControl.loading || !!skillControl.error || (!input.trim() && !references.length) || !selectedModel} aria-label={working === 'chat' ? '停止生成' : '发送消息'} title={working === 'chat' ? '停止生成' : '发送消息'}>{working === 'chat' ? <Square size={15} fill="currentColor" /> : <ArrowUp size={20} />}</button>
      </div>
      {!availableModels.length && <button type="button" className="script-director-model-link" onClick={onOpenModels}>还没有可用文本模型，前往模型设置添加</button>}
      <div className="sd-composer-hint"><span>Enter 发送 · Shift+Enter 换行</span><span>{input.length ? `${input.length}/8000` : ''}</span></div>
    </div>}
      </div>
    </section>}
    </div>

    {readerArtifact && !minimized && <section className="sd-document-reader" aria-label="导演文档阅读器">
      <header><button type="button" aria-label="返回导演对话" onClick={() => { setReaderKey(null); setReaderReference(null) }}><ChevronLeft size={18} /></button><strong>{readerReference ? '引用文档' : '项目文档'}</strong><button type="button" aria-label="关闭文档阅读器" onClick={() => { setReaderKey(null); setReaderReference(null) }}><X size={17} /></button></header>
      <div className="sd-document-toolbar">{!readerReference && <Select className="sd-document-select" aria-label="选择阅读文档" value={readerKey} data={artifactCards.map(artifact => ({ value: artifactKey(artifact), label: artifact.title }))} allowDeselect={false} rightSection={<ChevronDown size={14} />} comboboxProps={{ withinPortal: true, zIndex: 400 }} onChange={setReaderKey} />}
        {!!readerScenes.length && <div className="sd-view-switch" role="group" aria-label="剧本展示方式"><button type="button" aria-pressed={readerView === 'body'} onClick={() => setReaderView('body')}>正文</button><button type="button" aria-pressed={readerView === 'scenes'} onClick={() => setReaderView('scenes')}>分场</button></div>}
      </div>
      <div className="sd-document-meta"><span className="sd-document-status">{readerReference ? '引用快照' : readerArtifact.isUnsaved ? '草稿待确认' : readerArtifact.status === 'draft' ? '已保存草稿' : '已保存'}</span><span>{readerScenes.length ? `${readerScenes.length} 场 · ${readerScenes.reduce((sum, scene) => sum + scene.duration, 0)} 秒` : '创作资料'}</span></div>
      <article key={`${readerKey}:${readerView}`}>{readerView === 'scenes' && readerScenes.length ? <DirectorSceneList scenes={readerScenes} /> : <div className="sd-document-page"><h2>{readerArtifact.title}</h2><DirectorDocumentBody text={readerArtifact.content} /></div>}</article>
      <footer><button type="button" className="sd-document-secondary" disabled={busy} onClick={() => {
        try {
          const reference = { key: artifactKey(readerArtifact), title: readerArtifact.title, artifact_type: readerArtifact.artifact_type, episode_number: readerArtifact.episode_number || 0, content: readerArtifact.content }
          setReferences(addReference(references, reference))
          setComposerCollapsed(false)
          setArtifactsOpen(false)
          setReaderKey(null); setReaderReference(null); setError(null)
          window.requestAnimationFrame(() => composerRef.current?.focus())
        } catch (issue) { setError(readableError(issue)); setReaderKey(null); setReaderReference(null) }
      }}><Plus size={14} />引用到对话</button>
        {!readerReference && !readerArtifact.isUnsaved && activeFocus === 'all' && <><button type="button" disabled={busy || !selectedModel} onClick={() => reviewDocument('review')}><FileText size={14} />模型评审</button><button type="button" disabled={busy || !selectedModel} onClick={() => reviewDocument('revise')}><PenLine size={14} />对话修订</button></>}
        {!readerReference && (readerArtifact.isUnsaved ? <button type="button" className="sd-document-primary" onClick={() => { setReaderKey(null); setPreviewOpen(true) }}>查看待确认草稿<ChevronRight size={14} /></button> : onOpenDocument && <button type="button" className="sd-document-primary" onClick={() => { const saved = detail.script.artifacts?.find(artifact => artifactKey(artifact) === readerKey); if (saved) onOpenDocument(saved) }}><PenLine size={14} />编辑文档</button>)}
      </footer>
    </section>}
    {!windowLayout.docked && !minimized && <button type="button" className="sd-window-resize" aria-label="调整对话窗口大小" title="拖动或用方向键调整窗口大小" onPointerDown={event => startWindowGesture(event, true)} onPointerMove={moveWindowGesture} onPointerUp={() => { gestureRef.current = null }} onPointerCancel={() => { gestureRef.current = null }} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
      event.preventDefault()
      const step = event.shiftKey ? 40 : 10
      setWindowLayout(current => ({ ...current, rect: clampDirectorWindow({ ...current.rect, width: current.rect.width + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), height: current.rect.height + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0) }, { width: window.innerWidth, height: window.innerHeight }) }))
    }} />}

    {settingsOpen && <div className="script-director-settings-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false) }}>
      <section className={`script-director-settings-modal${showSettingPresets ? '' : ' is-presets-hidden'}`} role="dialog" aria-modal="true" aria-label="剧本设定器" onMouseDown={(event) => event.stopPropagation()}>
        {showSettingPresets && <aside className="script-director-settings-presets">
          <header><div><strong>爆款预设 Top 8</strong></div></header>
          <div className="script-director-settings-preset-list">
            {directorSettingPresets.map((preset, index) => <button type="button" key={preset.label} className={settingsDraft.genre === preset.values.genre && (!preset.artwork || settingsPresetArtwork === preset.artwork) ? 'is-active' : ''} style={preset.artwork ? { backgroundImage: `linear-gradient(100deg, #111720e8 0%, #11172072 62%, #11172025 100%), url("${preset.artwork}")` } : undefined} onClick={() => { setAutoFieldOpen(null); setStructurePickerOpen(false); setFusionRailOpen(Boolean(preset.values.genre_fusion)); setSettingsPresetArtwork(preset.artwork); setSettingsDraft((current) => ({ ...current, ...preset.values, ...(preset.values.visual_style ? { visual_style_details: undefined } : {}) })) }}>
              <span className="script-director-preset-copy"><b>{index + 1}</b><span>{preset.label}</span></span>
            </button>)}
          </div>
          <button type="button" className="script-director-settings-custom" onClick={() => { setAutoFieldOpen(null); setStructurePickerOpen(false); setSettingsPresetArtwork(undefined); setFusionExitActive(Boolean(settingsDraft.genre_fusion)); setFusionRailOpen(false); setSettingsDraft(emptyOptions) }}><PenLine size={13} />自定义设定</button>
        </aside>}
        <div className="script-director-settings-main">
          <header className="script-director-settings-modal-head"><div><span>剧本设定器</span></div><button type="button" onClick={() => setSettingsOpen(false)} aria-label="关闭剧本设定器"><X size={19} /></button></header>
          <div className="script-director-settings-scroll" onMouseDown={(event) => {
            const target = event.target as HTMLElement
            if (!target.closest('.script-director-structure-picker')) setStructurePickerOpen(false)
            if (!target.closest('.script-director-auto-field')) setAutoFieldOpen(null)
          }}>
            <section className="script-director-settings-theme">
              <div className={`script-director-settings-theme-layout${fusionRailOpen || fusionExitActive ? ' has-fusion-rail' : ''}`}>
                <div className="script-director-theme-rail-column">
                  <InfiniteThemeRail
                    items={directorThemeChoices}
                    selected={isScriptThemeCategory(settingsDraft.genre || '') ? settingsDraft.genre! : '其他'}
                    side="primary"
                    activeArtwork={settingsPresetArtwork === directorTop8Artwork ? undefined : settingsPresetArtwork}
                    onSelect={selectTheme}
                  />
                </div>
                <div className="script-director-theme-stage">
                  <div className="script-director-theme-stage-label"><span>当前题材关系</span><small>先选主题材，点击融合题材后从右侧选择</small></div>
                  <div className={`script-director-theme-orbit${settingsDraft.genre_fusion || fusionExitActive ? ' has-fusion' : ''}`}>
                    <ScriptThemeWaterCanvas active={!hidden && !minimized} primary={settingsDraft.genre || ''} fusion={settingsDraft.genre_fusion || ''} primaryArtwork={primaryThemeArtwork} fusionArtwork={fusionThemeArtwork} onFusionSettled={() => setFusionExitActive(false)} />
                    {settingsDraft.genre_fusion ? <div className="script-director-theme-fusion-wrap">
                      <span
                        className={`script-director-theme-circle is-fusion tone-${directorThemeTone(settingsDraft.genre_fusion)}`}
                        style={{ '--theme-artwork': `url("${fusionThemeArtwork}")` } as CSSProperties}
                      >
                        {directorArtworkForTheme(settingsDraft.genre_fusion) && <span className="script-director-theme-cover" aria-hidden="true" />}
                        <span>{settingsDraft.genre_fusion}</span>
                      </span>
                      <button type="button" aria-label="移除融合题材" onClick={clearFusionTheme}><Minus size={14} strokeWidth={1.8} /></button>
                    </div>
                    : !fusionExitActive && <button type="button" className="script-director-theme-fusion-trigger" aria-expanded={fusionRailOpen} onClick={() => {
                      setAutoFieldOpen(null)
                      setStructurePickerOpen(false)
                      setSettingsDraft((current) => {
                        const primary = current.genre || defaultPrimaryTheme
                        const fusion = current.genre_fusion || (
                          directorThemeChoices.find((theme) => theme !== primary && theme !== '其他') || defaultFusionTheme
                        )
                        return { ...current, genre: primary, genre_fusion: fusion }
                      })
                      setFusionRailOpen(true)
                    }}><span>＋</span><small>融合题材</small></button>}
                    {settingsDraft.genre_fusion && <>
                      <span className="script-director-theme-liquid-gel" aria-hidden="true" />
                      <span className="script-director-theme-fusion-bridge" aria-hidden="true" />
                    </>}
                  </div>
                </div>
                {fusionRailOpen && <InfiniteThemeRail
                    items={directorThemeChoices.filter((theme) => theme !== settingsDraft.genre)}
                    selected={isScriptThemeCategory(settingsDraft.genre_fusion || '') ? settingsDraft.genre_fusion! : '其他'}
                    side="fusion"
                    onSelect={selectFusionTheme}
                  />}
              </div>
              <div className="script-director-theme-selection" aria-label="当前题材">
                {[
                  { label: '主题材', name: settingsDraft.genre || '自定义题材', category: themeVisuals.primary, artwork: primaryThemeArtwork },
                  ...(settingsDraft.genre_fusion ? [{ label: '融合题材', name: settingsDraft.genre_fusion, category: themeVisuals.fusion, artwork: fusionThemeArtwork }] : []),
                ].map(theme => <div className="script-director-theme-selected" key={theme.label}>
                  <img src={theme.artwork} alt="" onError={event => { if (!event.currentTarget.src.endsWith(neutralThemeArtwork)) event.currentTarget.src = neutralThemeArtwork }} />
                  <div><span className="script-director-theme-selected-label">{theme.label}</span>
                    <div className="script-director-theme-selected-name"><strong>{theme.name}</strong>{theme.name !== '自定义题材' && !isScriptThemeCategory(theme.name) && <small>自定义</small>}</div>
                    {!isScriptThemeCategory(theme.name) && <span className="script-director-theme-cover-note" aria-live="polite">
                      {theme.category ? `封面参考：${theme.category}` : themeVisuals.status === 'pending' ? '正在匹配封面…' : '使用中性封面'}
                    </span>}
                  </div>
                </div>)}
                {themeVisuals.status === 'error' && <button className="script-director-theme-match-retry" type="button" onClick={themeVisuals.retry}><RotateCcw size={12} />重试封面匹配</button>}
              </div>
            </section>
            <div className="script-director-settings-divider" aria-hidden="true" />
            <div className="script-director-settings-grid">
              {directorAutoFieldMeta.map((field) => <DirectorAutoField
                key={field.key}
                label={field.label}
                value={settingsDraft[field.key] || ''}
                placeholder={field.placeholder}
                options={directorAutoFieldOptions[field.key]}
                icon={field.icon}
                open={autoFieldOpen === field.label}
                onToggle={() => {
                  setStructurePickerOpen(false)
                  setAutoFieldOpen((current) => current === field.label ? null : field.label)
                }}
                onChange={(value) => updateSettingsDraft(field.key, value)}
              />)}
              <DirectorStructurePicker
                value={settingsDraft.story_structure || ''}
                episodeCount={settingsDraft.episode_count}
                open={structurePickerOpen}
                onToggle={() => { setAutoFieldOpen(null); setStructurePickerOpen((value) => !value) }}
                onChange={(value) => updateSettingsDraft('story_structure', value)}
                onEpisodeCountChange={(value) => updateSettingsDraft('episode_count', value)}
              />
            </div>
          </div>
          <footer className="script-director-settings-modal-foot"><button type="button" className={`script-director-presets-switch${showSettingPresets ? ' is-on' : ''}`} aria-pressed={showSettingPresets} onClick={() => setShowSettingPresets((value) => !value)}><span aria-hidden="true" /><em>展示爆款预设</em></button><div><button type="button" className="script-director-settings-cancel" onClick={() => setSettingsOpen(false)}>取消</button><button type="button" className="script-director-settings-confirm" onClick={applySettings}>确认设定</button></div></footer>
        </div>
      </section>
    </div>}
  </aside>
}

export default ScriptDirectorPanel
