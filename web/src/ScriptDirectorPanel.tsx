import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Select } from '@mantine/core'
import {
  Check,
  Clapperboard,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  FileText,
  History,
  Info,
  LoaderCircle,
  MessageCirclePlus,
  Minus,
  PenLine,
  Send,
  Settings2,
  Sparkles,
  UserRound,
  MapPin,
  Package,
  WandSparkles,
  Copy,
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
import './script-director.css'
import { ScriptThemeWaterCanvas as WebGLScriptThemeWaterCanvas } from './ScriptThemeWaterCanvas'

type GeneratedScene = {
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
  artifact_type: ScriptArtifactType
  title: string
  content: string
}

type GeneratedScript = {
  outline: string
  characters: string
  scenes: GeneratedScene[]
  artifacts: GeneratedArtifact[]
}

type Message = {
  id: string
  role: 'assistant' | 'user'
  text: string
  pending?: boolean
}

type MessageChoice = { label: string; text: string }
type ParsedMessageChoices = { intro: string; question: string; options: MessageChoice[]; trailing: string }

function parseMessageChoices(text: string): ParsedMessageChoices | null {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const source = fenced?.[1] || trimmed
  if (!source.startsWith('{')) return null
  let value: unknown
  try { value = JSON.parse(source) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const payload = value as Record<string, unknown>
  if (payload.kind !== 'choices' || typeof payload.question !== 'string' || !payload.question.trim() || !Array.isArray(payload.options) || payload.options.length > 8) return null
  const options = payload.options.flatMap((entry, index): MessageChoice[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const option = entry as Record<string, unknown>
    const optionText = typeof option.text === 'string' ? option.text : ''
    if (!optionText.trim()) return []
    const label = typeof option.id === 'string' && option.id.trim() ? option.id.trim() : String(index + 1)
    return [{ label, text: optionText.trim() }]
  })
  if (options.length < 2 || options.length > 8) return null
  return {
    intro: typeof payload.intro === 'string' ? payload.intro.trim() : '',
    question: payload.question.trim(),
    options,
    trailing: typeof payload.trailing === 'string' ? payload.trailing.trim() : '',
  }
}

function isStructuredChoiceStream(text: string): boolean {
  const prefix = text.trimStart()
  return prefix.startsWith('{') || prefix.startsWith('```') || /"kind"\s*:\s*"choices"/.test(prefix)
}

type ProcessEvent = {
  id: string
  label: string
  summary: string
}

type StreamEvent = {
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
  messages: Array<{ id: string; role: Message['role']; text: string }>
  updated_at?: string
}

type DirectorMode = 'all' | 'script' | 'director'

type DirectorStageKey = 'idea' | 'outline' | 'characters' | 'scenes' | 'props' | 'episode'

const directorStages: Array<{ key: DirectorStageKey; label: string; hint: string }> = [
  { key: 'idea', label: '创作方向', hint: '题材、受众和核心冲突' },
  { key: 'outline', label: '故事大纲', hint: '故事主线与结构节奏' },
  { key: 'characters', label: '人物设定', hint: '人物小传与关系网络' },
  { key: 'scenes', label: '场景设计', hint: '分场、动作与对白' },
  { key: 'props', label: '道具设计', hint: '关键道具与视觉线索' },
  { key: 'episode', label: '分集剧本', hint: '确认后继续写单集' },
]

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
  onRefresh: () => Promise<unknown>
  onClose: () => void
  onOpenModels: () => void
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
  episode_outline: '单集大纲', episode_script: '单集正文',
}

function normaliseArtifact(artifact: Partial<GeneratedArtifact>): GeneratedArtifact | null {
  const type = artifact.artifact_type
  if (!type || !(type in generatedArtifactTitles) || typeof artifact.content !== 'string' || !artifact.content.trim()) return null
  return {
    artifact_type: type,
    title: typeof artifact.title === 'string' && artifact.title.trim() ? artifact.title.trim() : generatedArtifactTitles[type],
    content: artifact.content.trim(),
  }
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
  const direction = mode === 'all'
    ? '兼顾故事构思、角色塑造和可制作的分场剧本。'
    : mode === 'director'
      ? '以导演视角组织场次，突出视觉调度、动作节拍、情绪变化和可执行的画面。'
      : '优先打磨人物动机、戏剧冲突、对白和故事结构，再落实为分场剧本。'
  return `${prompt.trim()}\n\n创作模式要求：${direction}`
}

function stageIndex(detail: ProjectDetail, generated: GeneratedScript | null, scriptSaved: boolean): number {
  const artifacts = detail.script?.artifacts || []
  const hasArtifact = (type: ScriptArtifactType) => artifacts.some((artifact) => artifact.artifact_type === type && artifact.content.trim())
    || Boolean(generated?.artifacts.some((artifact) => artifact.artifact_type === type && artifact.content.trim()))
  if (scriptSaved) return 5
  const complete = [
    Boolean(detail.brief?.trim()),
    Boolean(generated?.outline?.trim() || detail.script?.outline?.trim() || hasArtifact('outline')),
    Boolean(generated?.characters?.trim() || detail.script?.characters?.trim() || hasArtifact('characters') || hasArtifact('relationships')),
    Boolean(generated?.scenes?.length || detail.script?.scenes?.length || hasArtifact('locations') || hasArtifact('structure')),
    Boolean(hasArtifact('props')),
    scriptSaved,
  ]
  const firstOpen = complete.findIndex((value) => !value)
  return firstOpen === -1 ? complete.length - 1 : firstOpen
}

function processSummaryFor(stage: number, hasScript: boolean, hasDraft: boolean): string {
  if (hasScript) return '项目已有剧本。你可以继续补充人物关系、场景动作和道具线索，确认后回到画布故事板继续制作。'
  if (hasDraft) return '已根据当前对话整理出故事大纲、人物设定和分场草稿。你可以先检查内容，再写入项目。'
  if (stage > 0) return '已记录你的创作方向，接下来会按故事大纲、人物关系、场景设计逐步整理，所有产物都会在确认后写入项目。'
  return '先提供题材、人物或一个场景想法，导演会据此整理创作方向。'
}

function stageCompleted(detail: ProjectDetail, generated: GeneratedScript | null, scriptSaved: boolean, index: number): boolean {
  const artifacts = detail.script?.artifacts || []
  const hasArtifact = (type: ScriptArtifactType) => artifacts.some((artifact) => artifact.artifact_type === type && artifact.content.trim())
    || Boolean(generated?.artifacts.some((artifact) => artifact.artifact_type === type && artifact.content.trim()))
  if (index === 0) return Boolean(detail.brief?.trim())
  if (index === 1) return Boolean(generated?.outline?.trim() || detail.script?.outline?.trim() || hasArtifact('outline'))
  if (index === 2) return Boolean(generated?.characters?.trim() || detail.script?.characters?.trim() || hasArtifact('characters') || hasArtifact('relationships'))
  if (index === 3) return Boolean(generated?.scenes?.length || detail.script?.scenes?.length || hasArtifact('locations') || hasArtifact('structure'))
  if (index === 4) return Boolean(hasArtifact('props'))
  return scriptSaved
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
      <span className="script-director-structure-label">剧本结构</span>
      <span className="script-director-structure-value">{value || '自动判断'}</span>
      <span className="script-director-structure-meta">{episodeCount ? `${count} 集` : '集数自动判断'}</span>
      <ChevronDown size={14} className="script-director-structure-chevron" />
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
      <span className="script-director-auto-icon"><Icon size={15} /></span>
      <span className="script-director-auto-copy"><small>{label}</small><strong>{value || '自动'}</strong></span>
      <ChevronDown size={13} className="script-director-auto-chevron" />
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
const directorXianxiaArtwork = '/topic-art/covers/topics/xianxia.jpg'

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

const directorThemeChoices = [
  '玄幻修仙', '都市现实', '古装言情', '悬疑推理', '惊悚怪谈', '犯罪谍战',
  '家庭伦理', '末世科幻', '历史传奇', '喜剧', '主旋律', '体育竞技', '文旅非遗',
  '其他',
]

// Keep the first open of the settings dialog useful even when a project has
// no saved generation options yet. The fusion default is selected when the
// user explicitly adds the second topic, so opening the dialog still shows a
// single stable anchor orb.
const defaultPrimaryTheme = '玄幻修仙'
const defaultFusionTheme = '都市现实'

const directorThemeArtwork: Record<string, string> = {
  // User supplied cinematic topic covers. Keep these separate from the Top
  // preset covers so a shared genre (for example 玄幻修仙) can still have
  // different ranked and topic artwork.
  '玄幻修仙': directorXianxiaArtwork,
  '都市现实': '/topic-art/covers/topics/urban.jpg',
  '古装言情': '/topic-art/covers/topics/costume-romance.jpg',
  '悬疑推理': '/topic-art/covers/topics/mystery.jpg',
  '惊悚怪谈': '/topic-art/covers/topics/horror.jpg',
  '犯罪谍战': '/topic-art/covers/topics/crime-spy.jpg',
  '家庭伦理': '/topic-art/covers/topics/family.jpg',
  '末世科幻': '/topic-art/covers/topics/apocalypse.jpg',
  '历史传奇': '/topic-art/covers/topics/history.jpg',
  '喜剧': '/topic-art/covers/topics/comedy.jpg',
  '主旋律': '/topic-art/covers/topics/hero.jpg',
  '体育竞技': '/topic-art/covers/topics/sports.jpg',
  '文旅非遗': '/topic-art/covers/topics/heritage.jpg',
  '重生复仇': '/topic-art/covers/top/top-7.jpg',
}

function directorArtworkForTheme(theme: string): string | undefined {
  const direct = directorThemeArtwork[theme]
  if (direct) return direct
  if (/玄幻|修仙|仙侠|仙门|东方奇幻/.test(theme)) return directorXianxiaArtwork
  if (/都市|职场|现实/.test(theme)) return '/topic-art/covers/topics/urban.jpg'
  if (/古装|历史/.test(theme)) return '/topic-art/covers/topics/costume-romance.jpg'
  if (/悬疑|推理|怪谈|惊悚/.test(theme)) return '/topic-art/covers/topics/mystery.jpg'
  if (/末世|科幻/.test(theme)) return '/topic-art/covers/topics/apocalypse.jpg'
  if (/文旅|非遗|国潮/.test(theme)) return '/topic-art/covers/topics/heritage.jpg'
  if (/犯罪|谍战|复仇/.test(theme)) return '/topic-art/covers/topics/crime-spy.jpg'
  if (/家庭|伦理/.test(theme)) return '/topic-art/covers/topics/family.jpg'
  if (/喜剧/.test(theme)) return '/topic-art/covers/topics/comedy.jpg'
  if (/体育|竞技/.test(theme)) return '/topic-art/covers/topics/sports.jpg'
  if (/主旋律/.test(theme)) return '/topic-art/covers/topics/hero.jpg'
  return undefined
}

function ScriptThemeWaterCanvas({ primary, fusion, primaryArtwork, onFusionSettled }: { primary: string; fusion: string; primaryArtwork?: string; onFusionSettled?: (hasFusion: boolean) => void }) {
  return <WebGLScriptThemeWaterCanvas
    primary={primary}
    fusion={fusion}
    primaryArtwork={primaryArtwork || directorArtworkForTheme(primary)}
    fusionArtwork={directorArtworkForTheme(fusion)}
    onFusionSettled={onFusionSettled}
  />
}

function directorThemeTone(value: string): string {
  if (/玄幻|修仙|仙/.test(value)) return 'fantasy'
  if (/都市|职场|现实/.test(value)) return 'city'
  if (/古装|历史/.test(value)) return 'heritage'
  if (/文旅|非遗|国潮/.test(value)) return 'culture'
  if (/悬疑|惊悚|怪谈/.test(value)) return 'thriller'
  if (/犯罪|谍战|重生|复仇/.test(value)) return 'crime'
  if (/家庭|伦理/.test(value)) return 'family'
  if (/末世|科幻/.test(value)) return 'future'
  if (/喜剧/.test(value)) return 'comedy'
  if (/体育|竞技/.test(value)) return 'sports'
  if (/主旋律/.test(value)) return 'hero'
  return 'neutral'
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

function DirectorChoiceCard({
  messageId,
  choice,
  selectedLabel,
  busy,
  onSelect,
  onDismiss,
  onContinue,
}: {
  messageId: string
  choice: ParsedMessageChoices
  selectedLabel?: string
  busy: boolean
  onSelect: (label: string) => void
  onDismiss: () => void
  onContinue: (text: string) => void
}) {
  const selectedOption = choice.options.find((option) => option.label === selectedLabel)
  const pageSize = 5
  const pageCount = Math.max(1, Math.ceil(choice.options.length / pageSize))
  const [page, setPage] = useState(0)
  useEffect(() => setPage(0), [messageId])
  const pageOptions = choice.options.slice(page * pageSize, (page + 1) * pageSize)
  return <section className="script-director-choice-card" aria-label="导演建议选项">
    <header>
      <strong>{choice.question}</strong>
      <span className="script-director-choice-pagination">
        <button type="button" aria-label="上一组问题" disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}><ChevronLeft size={14} /></button>
        <span>{page + 1}/{pageCount}</span>
        <button type="button" aria-label="下一组问题" disabled={page >= pageCount - 1} onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}><ChevronRight size={14} /></button>
      </span>
    </header>
    {choice.intro && <p className="script-director-choice-intro">{choice.intro}</p>}
    <div className="script-director-choice-list" role="group" aria-label="导演建议选项">
      {pageOptions.map((option, index) => <button
        type="button"
        key={`${messageId}-${option.label}`}
        className={`${selectedLabel === option.label ? 'is-selected' : ''} ${/我有别的想法|其他想法/.test(option.text) ? 'is-muted' : ''}`.trim()}
        aria-pressed={selectedLabel === option.label}
        onClick={() => onSelect(option.label)}
      >
        <span>{page * pageSize + index + 1}</span>
        <strong>{option.text}</strong>
      </button>)}
    </div>
    {choice.trailing && <p className="script-director-choice-followup">{choice.trailing}</p>}
    <footer>
      <button type="button" onClick={onDismiss}>忽略</button>
      <button type="button" disabled={!selectedOption || busy} onClick={() => selectedOption && onContinue(selectedOption.text)}>继续</button>
    </footer>
  </section>
}

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
      {(status === 'ready' || status === 'failed' || status === 'succeeded') && (imageModels.length ? <div className="script-director-asset-task-generate-row"><Select size="xs" searchable allowDeselect={false} value={imageModelId || null} placeholder="选择图片模型" data={imageModels.map((model) => ({ value: model.id, label: model.name }))} onChange={(value) => onImageModelChange(value || '')} /><button type="button" className="script-director-task-primary" onClick={onGenerate} disabled={!imageModelId || !prompt.trim()}><WandSparkles size={13} />重新生成{meta.noun}</button></div> : <button type="button" className="script-director-model-link" onClick={onOpenModels}>还没有可用的图片模型，前往模型设置添加</button>)}
      {status === 'succeeded' && resultAsset && <div className="script-director-asset-result"><img src={resultAsset.url} alt={`${meta.label}结果`} /><div><strong>{resultAsset.filename}</strong><span>{resultAsset.saved ? '已保存到资产' : '生成结果未保存'}</span></div><button type="button" className="script-director-task-secondary" onClick={onSave} disabled={resultAsset.saved}>{resultAsset.saved ? '已保存' : '保存资产'}</button></div>}
      {status === 'succeeded' && !resultAsset && <div className="script-director-asset-task-ready"><CheckCircle2 size={13} />任务已完成，正在刷新生成结果…</div>}
      {status === 'failed' && <div className="script-director-asset-task-ready is-error">生成失败，可修改提示词后重新提交</div>}
    </div>}
  </section>
}

function ScriptDirectorPanel({ detail, models, providers, focusArtifact = 'all', onRefresh, onClose, onOpenModels, onNotice }: ScriptDirectorPanelProps) {
  const availableModels = useMemo(() => models.filter((model) => {
    const provider = providers.find((item) => item.id === model.provider_id)
    return model.modality === 'text' && model.enabled && !!provider?.enabled && provider.adapter !== 'demo'
  }), [models, providers])
  const imageModels = useMemo(() => models.filter((model) => {
    const provider = providers.find((item) => item.id === model.provider_id)
    return model.modality === 'image' && model.enabled && !!provider?.enabled && provider.adapter !== 'demo'
  }), [models, providers])
  const [options, setOptions] = useState<ScriptGenerationOptions>(() => optionsFromDetail(detail))
  const [idea, setIdea] = useState(detail.brief || '')
  const [modelId, setModelId] = useState('')
  const [activeFocus, setActiveFocus] = useState<ScriptAction>(focusArtifact)
  const [mode, setMode] = useState<DirectorMode>('script')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showSettingPresets, setShowSettingPresets] = useState(true)
  const [structurePickerOpen, setStructurePickerOpen] = useState(false)
  const [autoFieldOpen, setAutoFieldOpen] = useState<DirectorAutoFieldProps['label'] | null>(null)
  const [fusionRailOpen, setFusionRailOpen] = useState(false)
  const [fusionExitActive, setFusionExitActive] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<ScriptGenerationOptions>(() => optionsFromDetail(detail))
  const [settingsPresetArtwork, setSettingsPresetArtwork] = useState<string | undefined>(undefined)
  const [promptOpen, setPromptOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [basePrompt, setBasePrompt] = useState('')
  const [promptCustomized, setPromptCustomized] = useState(false)
  const [promptLoading, setPromptLoading] = useState(false)
  const [promptError, setPromptError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [working, setWorking] = useState<'chat' | 'prompt' | 'generate' | 'save' | 'shots' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [generated, setGenerated] = useState<GeneratedScript | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [artifactsOpen, setArtifactsOpen] = useState(false)
  const [processSummaryOpen, setProcessSummaryOpen] = useState(false)
  const [processEvents, setProcessEvents] = useState<ProcessEvent[]>([])
  const [scriptSaved, setScriptSaved] = useState(false)
  const [assetTaskStatus, setAssetTaskStatus] = useState<AssetTaskStatus>(focusArtifact === 'all' ? 'idle' : 'analyzing')
  const [assetPrompt, setAssetPrompt] = useState('')
  const [assetImageModelId, setAssetImageModelId] = useState('')
  const [assetJobId, setAssetJobId] = useState<string | null>(null)
  const [assetTaskId, setAssetTaskId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>(() => loadDirectorState(detail.id).messages)
  const [history, setHistory] = useState<ConversationSnapshot[]>(() => loadDirectorState(detail.id).history)
  const [choiceSelections, setChoiceSelections] = useState<Record<string, string>>({})
  const [choiceDismissed, setChoiceDismissed] = useState<Record<string, boolean>>({})
  const [historyOpen, setHistoryOpen] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const conversationSyncReady = useRef(false)
  const conversationSaveSerial = useRef(0)
  const localConversationSaveTimer = useRef<number | null>(null)
  const remoteConversationSaveTimer = useRef<number | null>(null)
  const streamAbortController = useRef<AbortController | null>(null)
  const focusTaskStarted = useRef<string | null>(null)
  const directorPanelRef = useRef<HTMLElement>(null)
  const messagesViewportRef = useRef<HTMLDivElement>(null)
  const followMessagesRef = useRef(true)
  const messageScrollFrameRef = useRef<number | null>(null)
  const streamMessageFrameRef = useRef<number | null>(null)
  const streamMessageUpdateRef = useRef<{ pendingId: string; text: string } | null>(null)
  const hasSavedScript = scriptExists(detail)
  const linkedSceneIds = useMemo(() => new Set(detail.shots.map((shot) => shot.source_scene_id).filter((id): id is string => !!id)), [detail.shots])
  const pendingSceneCount = (detail.script?.scenes || []).filter((scene) => !linkedSceneIds.has(scene.id)).length
  const promptRequestId = useRef(0)
  const selectedModel = availableModels.find((model) => model.id === modelId)
  const assetJob = assetJobId ? detail.jobs.find((job) => job.id === assetJobId) : undefined
  const assetResult = assetJob?.result_asset_id ? detail.assets.find((asset) => asset.id === assetJob.result_asset_id) : undefined
  // Project detail is refreshed periodically by the shell. Compare the
  // serialized values instead of the nested object reference so that a
  // background refresh cannot replace an in-progress local edit.
  const persistedOptionsKey = JSON.stringify(optionsFromDetail(detail))
  const busy = working !== null
  const currentStage = stageIndex(detail, generated, scriptSaved)
  const hasScript = Boolean(scriptSaved || hasSavedScript)
  const generatedStructure = generated?.scenes.map((scene, index) => `第${index + 1}场｜${scene.heading || scene.location || '未命名场景'}\n${scene.action || scene.dialogue || scene.narration || ''}`).join('\n\n') || ''
  const artifactCards: Array<Pick<ScriptArtifact, 'artifact_type' | 'title' | 'content' | 'status'> & { sceneCount?: number; duration?: number }> = generated
    ? [
      ...generated.artifacts.map((artifact) => ({ artifact_type: artifact.artifact_type, title: artifact.title, content: artifact.content, status: 'ready' as const })),
      ...(generated.artifacts.some((artifact) => artifact.artifact_type === 'outline') ? [] : [{ artifact_type: 'outline' as const, title: '故事大纲', content: generated.outline, status: 'ready' as const }]),
      ...(generated.artifacts.some((artifact) => artifact.artifact_type === 'characters') ? [] : [{ artifact_type: 'characters' as const, title: '人物小传', content: generated.characters, status: 'ready' as const }]),
      ...(generated.artifacts.some((artifact) => artifact.artifact_type === 'structure') ? [] : [{ artifact_type: 'structure' as const, title: '全剧分段', content: generatedStructure, status: 'ready' as const }]),
    ].map((artifact) => artifact.artifact_type === 'structure'
      ? { ...artifact, sceneCount: generated.scenes.length, duration: generated.scenes.reduce((sum, scene) => sum + scene.duration, 0) }
      : artifact).filter((artifact) => {
        const withMeta = artifact as typeof artifact & { sceneCount?: number }
        return Boolean(artifact.content.trim() || withMeta.sceneCount)
      }) as Array<Pick<ScriptArtifact, 'artifact_type' | 'title' | 'content' | 'status'> & { sceneCount?: number; duration?: number }>
    : (detail.script?.artifacts || []).map((artifact) => ({ artifact_type: artifact.artifact_type, title: artifact.title, content: artifact.content, status: artifact.status }))
  const quickReplies = useMemo(() => {
    if (busy) return []
    if (generated && !scriptSaved) return ['继续补充场景与道具', '确认写入项目剧本']
    if (hasScript) return ['补充人物关系', '完善场景动作', '开始写第 1 集']
    return ['先整理故事大纲', '补充人物关系', '整理对话并生成剧本草稿']
  }, [busy, generated, hasScript, scriptSaved])
  const activeChoice = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.role !== 'assistant' || message.pending) continue
      const choice = parseMessageChoices(message.text)
      if (!choice) continue
      return choiceDismissed[message.id] ? null : { messageId: message.id, choice }
    }
    return null
  }, [choiceDismissed, messages])

  useEffect(() => {
    setOptions(optionsFromDetail(detail))
    setIdea(detail.brief || '')
  }, [detail.id, detail.brief, persistedOptionsKey])

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
    if (!followMessagesRef.current || messageScrollFrameRef.current !== null) return
    messageScrollFrameRef.current = window.requestAnimationFrame(() => {
      messageScrollFrameRef.current = null
      const viewport = messagesViewportRef.current
      if (!viewport || !followMessagesRef.current) return
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'auto' })
    })
  }, [messages, processEvents, processSummaryOpen, assetTaskStatus, artifactsOpen, previewOpen])

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
    void api<{ conversations: PersistedConversation[] }>(`/projects/${detail.id}/script/conversations`)
      .then((result) => {
        if (!active) return
        const remote = Array.isArray(result.conversations) ? result.conversations : []
        if (remote.length) {
          const [current, ...rest] = remote
          if (current) {
            setConversationId(current.id)
            setMessages(current.messages.length
              ? current.messages.map(({ id, role, text }) => ({ id, role, text }))
              : [welcomeMessage])
          }
          setHistory(rest.map((conversation) => ({
            id: conversation.id,
            label: conversation.label,
            messages: conversation.messages.map(({ id, role, text }) => ({ id, role, text })),
          })))
        } else {
          setConversationId(crypto.randomUUID())
        }
      })
      .catch(() => { /* Keep the local fallback when the service is temporarily unavailable. */ })
      .finally(() => {
        if (active) conversationSyncReady.current = true
      })
    return () => { active = false; conversationSyncReady.current = false }
  }, [detail.id])

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
            messages: conversation.messages.filter((message) => !message.pending).slice(-80).map(({ id, role, text }) => ({ id, role, text })),
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
    setSettingsDraft((current) => ({ ...current, [key]: value }))
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
    void api<ProjectDetail['script']>(`/projects/${detail.id}/script/commit`, json('PUT', {
      brief: idea.trim() || detail.brief || undefined,
      outline: detail.script?.outline || '',
      characters: detail.script?.characters || '',
      generation_options: confirmed,
      scenes: (detail.script?.scenes || []).map((scene) => ({
        id: scene.id,
        heading: scene.heading,
        location: scene.location,
        time_of_day: scene.time_of_day,
        characters: scene.characters,
        action: scene.action,
        dialogue: scene.dialogue,
        narration: scene.narration,
        duration: scene.duration,
      })),
      artifacts: (detail.script?.artifacts || []).map((artifact) => ({
        id: artifact.id,
        artifact_type: artifact.artifact_type,
        title: artifact.title,
        content: artifact.content,
        position: artifact.position,
        status: artifact.status,
      })),
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
    setMessages((current) => [...current, { id: crypto.randomUUID(), role, text, pending }].slice(-80))
  }

  function updateMessageFollow() {
    const isAtBottom = (element: HTMLElement | null) => !element || element.scrollHeight - element.scrollTop - element.clientHeight < 72
    // The panel is a fixed flex shell with overflow hidden. Its scrollHeight
    // includes the composer and other fixed sections, so checking it here
    // incorrectly disables follow mode after the first message grows.
    followMessagesRef.current = isAtBottom(messagesViewportRef.current)
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

  function appendProcessEvent(event: StreamEvent) {
    const stageLabels: Record<string, string> = {
      preparing: '准备创作',
      analysis: '分析故事结构',
      writing: '整理文字内容',
      revising: '校对创作内容',
    }
    const rawLabel = typeof event.label === 'string' && event.label.trim() ? event.label.trim() : '创作进度'
    const label = stageLabels[rawLabel] || rawLabel
    const summary = typeof event.summary === 'string' && event.summary.trim()
      ? event.summary.trim()
      : typeof event.text === 'string' ? event.text.trim() : ''
    if (!summary) return
    setProcessEvents((current) => {
      const existingIndex = current.findIndex((item) => item.label === label)
      const next = { id: existingIndex >= 0 ? current[existingIndex]!.id : crypto.randomUUID(), label, summary }
      if (existingIndex < 0) return [...current, next].slice(-8)
      return current.map((item, index) => index === existingIndex ? next : item)
    })
    setProcessSummaryOpen(true)
  }

  async function streamDirectorChat(
    pendingId: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await fetch(`/api/projects/${detail.id}/script/director/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/x-ndjson' },
      body: JSON.stringify(body),
      signal,
    })
    if (response.status === 404 || response.status === 405) {
      throw new StreamUnavailableError('流式接口暂不可用')
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { detail?: unknown; message?: unknown }
      const detail = payload.detail ?? payload.message
      throw new Error(typeof detail === 'string' ? detail : `请求失败 (${response.status})`)
    }
    if (!response.body) throw new StreamUnavailableError('浏览器不支持流式响应')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let reply = ''
    let sseLines: string[] = []

    const applyEvent = (event: StreamEvent) => {
      const kind = String(event.type || '').toLowerCase()
      if (kind === 'stage' || kind === 'process' || kind === 'summary' || kind === 'progress' || kind === 'reasoning_summary') {
        appendProcessEvent({
          ...event,
          label: event.label || event.stage || (kind === 'reasoning_summary' ? '生成依据' : '创作进度'),
          summary: event.summary || event.text,
        })
        return
      }
      if (kind === 'error') {
        throw new Error(event.message || event.text || '流式生成失败')
      }
      if (kind === 'done' || kind === 'complete') {
        if (typeof event.reply === 'string') reply = event.reply
        return
      }
      const chunk = typeof event.delta === 'string' ? event.delta : typeof event.text === 'string' ? event.text : ''
      if (chunk) {
        reply += chunk
        queueStreamMessage(pendingId, isStructuredChoiceStream(reply) ? '正在整理可选方向…' : reply)
      }
    }

    const flushSse = () => {
      if (!sseLines.length) return
      const event = parseStreamEvent(sseLines.join('\n'))
      sseLines = []
      if (event) applyEvent(event)
    }

    try {
      while (true) {
        const { value, done } = await reader.read()
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) {
            flushSse()
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
        }
        if (done) {
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
      reader.releaseLock()
    }
    if (!reply.trim()) {
      const current = messages.find((item) => item.id === pendingId)?.text || ''
      reply = current.trim()
    }
    if (!reply.trim()) throw new Error('文本模型未返回对话内容')
    return reply
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
    followMessagesRef.current = true
    if (messages.some((message) => message.role === 'user')) {
      const firstIdea = messages.find((message) => message.role === 'user')?.text || '未命名对话'
      setHistory((current) => [{
        id: conversationId || crypto.randomUUID(),
        label: firstIdea.length > 28 ? `${firstIdea.slice(0, 28)}…` : firstIdea,
        messages,
      }, ...current].slice(0, 20))
    }
    setMessages([{ id: crypto.randomUUID(), role: 'assistant', text: '新的创作已经开始。告诉我你的故事想法，我会先和你讨论创作方向。' }])
    setChoiceSelections({})
    setChoiceDismissed({})
    setConversationId(crypto.randomUUID())
    // `idea` is also used as the fallback when building the generation input.
    // Clear any idea captured from the previous conversation while retaining
    // the project-level brief that was present when this panel opened.
    setIdea(detail.brief || '')
    setGenerated(null)
    setPreviewOpen(false)
    setArtifactsOpen(false)
    setProcessSummaryOpen(false)
    setProcessEvents([])
    setScriptSaved(false)
    setError(null)
    setHistoryOpen(false)
    setPromptOpen(false)
    setPrompt('')
    setBasePrompt('')
    setPromptCustomized(false)
  }

  function switchConversation(conversation: ConversationSnapshot) {
    followMessagesRef.current = true
    if (messages.some((message) => message.role === 'user')) {
      const firstIdea = messages.find((message) => message.role === 'user')?.text || '未命名对话'
      setHistory((current) => [{
        id: conversationId || crypto.randomUUID(),
        label: firstIdea.length > 28 ? `${firstIdea.slice(0, 28)}…` : firstIdea,
        messages,
      }, ...current].slice(0, 20))
    }
    setMessages(conversation.messages)
    setChoiceSelections({})
    setChoiceDismissed({})
    setConversationId(conversation.id)
    // Do not prepend the current conversation's unsaved idea to a restored
    // history. A restored conversation should be generated from its own
    // messages and the project's original brief only.
    setIdea(detail.brief || '')
    setHistoryOpen(false)
    setGenerated(null)
    setPreviewOpen(false)
    setArtifactsOpen(false)
    setProcessSummaryOpen(false)
    setProcessEvents([])
    setScriptSaved(false)
    setError(null)
  }

  async function refreshPrompt() {
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

  async function sendChatMessage(overrideInput?: string, skipAssetStatus = false): Promise<string | null> {
    const message = (overrideInput ?? input).trim()
    if (!message) return null
    if (!modelId || !selectedModel) { setError('请选择文本模型'); return null }
    setError(null)
    if (activeFocus !== 'all' && !skipAssetStatus) setAssetTaskStatus('analyzing')
    const userMessage: Message = { id: crypto.randomUUID(), role: 'user', text: message }
    const pendingId = crypto.randomUUID()
    const pendingMessage: Message = { id: pendingId, role: 'assistant', text: '正在整理你的想法…', pending: true }
    const priorMessages = messages.filter((item) => item.id !== 'welcome' && !item.pending).slice(-31).map(({ role, text }) => ({ role, text }))
    const conversation = [...priorMessages, { role: userMessage.role, text: userMessage.text }]
    followMessagesRef.current = true
    setMessages((current) => [...current, userMessage, pendingMessage].slice(-80))
    setInput('')
    if (!idea.trim()) setIdea(message)
    setProcessEvents([])
    setWorking('chat')
    const controller = new AbortController()
    streamAbortController.current = controller
    try {
      const requestBody = {
        model_id: modelId,
        mode,
        focus_artifact: activeFocus,
        generation_options: options,
        messages: conversation,
      }
      let reply: string
      try {
        reply = await streamDirectorChat(pendingId, requestBody, controller.signal)
      } catch (issue) {
        if (!(issue instanceof StreamUnavailableError)) throw issue
        const result = await api<{ reply: string }>(`/projects/${detail.id}/script/director/chat`, json('POST', requestBody))
        reply = result.reply
      }
      setMessages((current) => current.map((item) => item.id === pendingId
        ? { ...item, text: reply, pending: false } : item))
      if (activeFocus !== 'all' && !skipAssetStatus) setAssetTaskStatus('awaiting-confirmation')
      return reply
    } catch (issue) {
      if (controller.signal.aborted || isAbortError(issue)) {
        flushQueuedStreamMessage()
        setMessages((current) => current.map((item) => item.id === pendingId
          ? { ...item, text: item.text && item.text !== '正在整理你的想法…' ? `${item.text}\n\n已停止生成` : '已停止生成', pending: false }
          : item))
        return null
      }
      flushQueuedStreamMessage()
      const messageText = `对话失败：${readableError(issue)}`
      setError(messageText)
      setMessages((current) => current.map((item) => item.id === pendingId
        ? { ...item, text: messageText, pending: false } : item))
    } finally {
      if (streamAbortController.current === controller) streamAbortController.current = null
      setWorking(null)
    }
    return null
  }

  async function handleAssetConfirm() {
    if (activeFocus === 'all') return
    const meta = assetTaskMeta[activeFocus]
    setAssetTaskStatus('generating')
    const reply = await sendChatMessage(`我确认${meta.label}资料。请基于剧本和已确认资料，整理一份可直接用于生成${meta.noun}的提示词。要求：包含主体、外观/空间、材质、光线、镜头、风格和负面约束；先给中文提示词，再给英文提示词；不要解释内部思考。`, true)
    if (!reply) { setAssetTaskStatus('awaiting-confirmation'); return }
    setAssetPrompt(reply)
    try {
      const task = await api<{ id: string; status: string }>(`/projects/${detail.id}/asset-tasks`, json('POST', {
        focus_artifact: activeFocus,
        prompt: reply,
      }))
      setAssetTaskId(task.id)
      setAssetTaskStatus('ready')
      onNotice(`${meta.label}资料已确认，可选择图片模型生成`)
    } catch (issue) {
      setAssetTaskStatus('failed')
      setError(`保存${meta.label}任务失败：${readableError(issue)}`)
    }
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

  function handleQuickReply(reply: string) {
    if (reply === '确认写入项目剧本' && generated) {
      void saveGenerated()
      return
    }
    if (reply === '生成剧本草稿' || reply === '整理对话并生成剧本草稿') {
      void generateScript()
      return
    }
    void sendChatMessage(reply)
  }

  async function generateScript() {
    const message = currentDraftIdea()
    if (!message) { setError('先输入一个故事想法'); return }
    if (!modelId || !selectedModel) { setError('请选择文本模型'); return }
    setError(null)
    let promptToUse = prompt
    if (!promptCustomized || !promptToUse.trim()) {
      setWorking('prompt')
      setPromptOpen(true)
      setPromptLoading(true)
      setPromptError(null)
      try {
        const result = await api<{ prompt: string }>(`/projects/${detail.id}/script/generate/prompt`, json('POST', {
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
    if (input.trim()) {
      const messageText = input.trim()
      appendMessage('user', messageText)
      if (!idea.trim()) setIdea(messageText)
      setInput('')
    }
    const pendingId = crypto.randomUUID()
    const pendingMessage: Message = { id: pendingId, role: 'assistant', text: '正在整理故事结构、人物关系和场次节奏…', pending: true }
    setMessages((current) => [...current, pendingMessage].slice(-80))
    setWorking('generate')
    try {
      const result = await api<GeneratedScript>(`/projects/${detail.id}/script/generate`, json('POST', {
        model_id: modelId,
        idea: message,
        generation_options: options,
        prompt_override: promptToUse,
      }))
      const next: GeneratedScript = {
        outline: typeof result.outline === 'string' ? result.outline : '',
        characters: typeof result.characters === 'string' ? result.characters : '',
        scenes: Array.isArray(result.scenes) ? result.scenes.map(normaliseScene) : [],
        artifacts: Array.isArray(result.artifacts)
          ? result.artifacts.map(normaliseArtifact).filter((artifact): artifact is GeneratedArtifact => artifact !== null)
          : [],
      }
      setGenerated(next)
      setPreviewOpen(true)
      setArtifactsOpen(true)
      setMessages((current) => current.map((item) => item.id === pendingId && item.pending
        ? { ...item, text: `剧本草稿已经完成，共 ${next.scenes.length} 场、约 ${next.scenes.reduce((sum, scene) => sum + scene.duration, 0)} 秒。你可以先查看预览，确认后写入项目。`, pending: false }
        : item))
    } catch (issue) {
      setError(`生成失败：${readableError(issue)}`)
      setMessages((current) => current.map((item) => item.id === pendingId && item.pending
        ? { ...item, text: `生成没有完成：${readableError(issue)}`, pending: false }
        : item))
    } finally {
      setWorking(null)
    }
  }

  async function saveGenerated() {
    const brief = messages.find((message) => message.role === 'user')?.text.trim() || idea.trim()
    if (!generated || !brief) return
    setWorking('save')
    setError(null)
    try {
      const linkedSceneIds = new Set(detail.shots.map((shot) => shot.source_scene_id).filter((id): id is string => !!id))
      const linkedScenes = detail.script.scenes.filter((scene) => linkedSceneIds.has(scene.id)).map((scene) => ({
        id: scene.id,
        heading: scene.heading,
        location: scene.location,
        time_of_day: scene.time_of_day,
        characters: scene.characters,
        action: scene.action,
        dialogue: scene.dialogue,
        narration: scene.narration,
        duration: scene.duration,
      }))
      const artifactMap = new Map<ScriptArtifactType, GeneratedArtifact>()
      generated.artifacts.forEach((artifact) => artifactMap.set(artifact.artifact_type, artifact))
      if (!artifactMap.has('outline') && generated.outline.trim()) artifactMap.set('outline', { artifact_type: 'outline', title: '故事大纲', content: generated.outline })
      if (!artifactMap.has('characters') && generated.characters.trim()) artifactMap.set('characters', { artifact_type: 'characters', title: '人物小传', content: generated.characters })
      if (!artifactMap.has('structure') && generatedStructure.trim()) artifactMap.set('structure', { artifact_type: 'structure', title: '全剧分段', content: generatedStructure })
      const artifactPayload: Array<{ artifact_type: ScriptArtifactType; title: string; content: string; position: number; status: 'ready' }> = [...artifactMap.values()]
        .map((artifact, position) => ({ artifact_type: artifact.artifact_type, title: artifact.title, content: artifact.content, position, status: 'ready' as const }))
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
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        text: `创作文本已保存到项目：${artifactPayload.length} 份剧本文档、${generated.scenes.length} 个场次。你可以继续补充内容，或将场次加入故事板。`,
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

  async function createSceneShots() {
    if (working || pendingSceneCount === 0) return
    const sceneIds = (detail.script?.scenes || []).filter((scene) => !linkedSceneIds.has(scene.id)).map((scene) => scene.id)
    if (!sceneIds.length) {
      onNotice('所有场次都已有分镜')
      return
    }
    setWorking('shots')
    setError(null)
    try {
      const result = await api<{ shots: { id: string }[]; skipped_scene_ids: string[] }>(`/projects/${detail.id}/script/convert-to-shots`, json('POST', { scene_ids: sceneIds }))
      await onRefresh()
      onNotice(`已将 ${result.shots.length} 个场次加入画布，可继续配置和生成镜头`)
      onClose()
    } catch (issue) {
      setError(`加入画布失败：${readableError(issue)}`)
    } finally {
      setWorking(null)
    }
  }

  function handleInputKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void sendChatMessage()
    }
  }

  return <aside
    className="script-director-panel"
    aria-label="剧本导演"
    ref={directorPanelRef}
  >
    <header className="script-director-header">
      <div className="script-director-title">
        <strong>剧本创作</strong>
      </div>
      <div className="script-director-header-actions">
        <button type="button" title="新建对话" aria-label="新建对话" onClick={startNewConversation} disabled={busy}><MessageCirclePlus size={17} /></button>
        <button type="button" title="历史对话" aria-label="历史对话" className={historyOpen ? 'is-active' : 'is-muted'} onClick={() => setHistoryOpen((value) => !value)}><History size={16} /></button>
        <button type="button" title="关闭" aria-label="关闭剧本导演" onClick={onClose}><X size={18} /></button>
      </div>
    </header>
    {historyOpen && <div className="script-director-history" role="listbox" aria-label="历史对话">
      <strong>历史对话</strong>
      {history.length ? history.map((conversation) => <button type="button" key={conversation.id} onClick={() => switchConversation(conversation)}>
        <History size={13} /><span>{conversation.label}</span>
      </button>) : <p>当前还没有历史对话</p>}
    </div>}

    <div className="script-director-context">
      <FileText size={15} />
      <span>{detail.name || '未命名项目'}</span>
      <span className="script-director-context-dot">·</span>
      <span>{detail.ratio}</span>
      <span className="script-director-context-dot">·</span>
      <span>{focusArtifactLabels[activeFocus]}</span>
    </div>

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

    <section className="script-director-progress" aria-label="剧本创作阶段">
      <div className="script-director-progress-head">
        <div><span>创作进度</span><strong>{directorStages[currentStage]?.label || '创作方向'}</strong></div>
        <button type="button" className={processSummaryOpen ? 'is-active' : ''} onClick={() => setProcessSummaryOpen((value) => !value)} aria-expanded={processSummaryOpen} title="查看创作过程摘要"><Info size={14} /></button>
      </div>
      <ol className="script-director-stage-list">
        {directorStages.map((stage, index) => {
          const completed = stageCompleted(detail, generated, scriptSaved, index)
          const active = index === currentStage
          return <li className={`${completed ? 'is-complete' : ''} ${active ? 'is-active' : ''}`} key={stage.key}>
            <span className="script-director-stage-marker">{completed ? <Check size={11} /> : active ? <Circle size={8} fill="currentColor" /> : index + 1}</span>
            <span className="script-director-stage-label">{stage.label}</span>
          </li>
        })}
      </ol>
      {processSummaryOpen && <div className="script-director-process-summary">
        <strong>创作过程摘要</strong>
        {processEvents.length ? <ol className="script-director-process-events">
          {processEvents.map((event) => <li key={event.id}><span>{event.label}</span><p>{event.summary}</p></li>)}
        </ol> : <p>{processSummaryFor(currentStage, hasScript, Boolean(generated))}</p>}
        <small>这里展示阶段进度与生成依据，不包含模型的内部隐式思考内容。</small>
      </div>}
    </section>

    <div
      className="script-director-messages"
      aria-live="polite"
      ref={messagesViewportRef}
      onScroll={updateMessageFollow}
    >
      {messages.map((message) => {
        const parsedChoices = message.role === 'assistant' && !message.pending
          ? parseMessageChoices(message.text)
          : null
        const dismissed = Boolean(choiceDismissed[message.id])
        if (parsedChoices && !dismissed) return null
        return <div className={`script-director-message ${message.role}`} key={message.id}>
          {parsedChoices && dismissed ? <div className="script-director-choice-dismissed"><span>{parsedChoices.question}</span><em>已忽略</em></div> : <div className={`script-director-bubble${message.pending ? ' is-pending' : ''}`}>
            {message.pending ? <><LoaderCircle size={13} className="script-director-spinner" /><span>{message.text}</span></> : message.text}
          </div>}
        </div>
      })}
    </div>

    {!!artifactCards.length && <section className={`script-director-artifacts ${artifactsOpen ? 'is-open' : ''}`} aria-label="剧本产物">
      <button type="button" className="script-director-artifacts-toggle" onClick={() => setArtifactsOpen((value) => !value)} aria-expanded={artifactsOpen}>
        <span><FileText size={14} />剧本产物</span><span className="script-director-artifacts-count">{artifactCards.length} 项</span><ChevronRight size={14} />
      </button>
      {artifactsOpen && <div className="script-director-artifacts-body">
        {artifactCards.map((artifact) => <article key={artifact.artifact_type}>
          <header><span>{artifact.title}</span>{artifact.status === 'ready' || artifact.status === 'edited' ? <Check size={12} /> : <em>待完善</em>}</header>
          <p>{artifact.content || '尚未填写内容'}</p>
        </article>)}
      </div>}
    </section>}

    {hasSavedScript && detail.script.scenes.length > 0 && <section className="script-director-storyboard-handoff" aria-label="故事板制作">
      <div><span><Clapperboard size={14} />故事板制作</span><small>{pendingSceneCount ? `${pendingSceneCount} 场尚未加入画布` : '所有场次都已加入画布'}</small></div>
      <button type="button" onClick={() => void createSceneShots()} disabled={busy || pendingSceneCount === 0}>
        {working === 'shots' ? <LoaderCircle size={13} className="script-director-spinner" /> : <Clapperboard size={13} />}
        {pendingSceneCount ? '将场次加入画布' : '已加入画布'}
      </button>
    </section>}

    {!activeChoice && !!quickReplies.length && <div className="script-director-quick-replies" aria-label="快捷回复">
      {quickReplies.map((reply) => <button type="button" key={reply} onClick={() => handleQuickReply(reply)} disabled={busy || (!selectedModel && reply !== '确认写入项目剧本')}><ChevronRight size={13} />{reply}</button>)}
    </div>}

    {error && <div className="script-director-error" role="alert">{error}<button type="button" onClick={() => setError(null)} aria-label="关闭错误"><X size={14} /></button></div>}

    {previewOpen && generated && <section className="script-director-preview" aria-label="剧本草稿预览">
      <div className="script-director-preview-head"><div><span>生成草稿</span><strong>{generated.scenes.length} 场 · {generated.scenes.reduce((sum, scene) => sum + scene.duration, 0)} 秒</strong></div><button type="button" onClick={() => setPreviewOpen(false)} aria-label="收起预览"><ChevronUp size={16} /></button></div>
      <div className="script-director-preview-scroll">
        <label>故事大纲<textarea value={generated.outline} onChange={(event) => setGenerated({ ...generated, outline: event.currentTarget.value })} /></label>
        <label>人物设定<textarea value={generated.characters} onChange={(event) => setGenerated({ ...generated, characters: event.currentTarget.value })} /></label>
        {generated.artifacts.filter((artifact) => artifact.artifact_type !== 'outline' && artifact.artifact_type !== 'characters' && artifact.artifact_type !== 'structure').map((artifact) => <label key={artifact.artifact_type}>{artifact.title}<textarea value={artifact.content} onChange={(event) => setGenerated({ ...generated, artifacts: generated.artifacts.map((item) => item.artifact_type === artifact.artifact_type ? { ...item, content: event.currentTarget.value } : item) })} /></label>)}
        {generated.scenes.map((scene, index) => <article key={`${scene.heading}-${index}`} className="script-director-scene-preview">
          <header><span>{String(index + 1).padStart(2, '0')}</span><input value={scene.heading} onChange={(event) => setGenerated({ ...generated, scenes: generated.scenes.map((item, itemIndex) => itemIndex === index ? { ...item, heading: event.currentTarget.value } : item) })} /><input className="script-director-scene-duration" type="number" min={1} max={30} value={scene.duration} aria-label={`第${index + 1}场时长`} onChange={(event) => setGenerated({ ...generated, scenes: generated.scenes.map((item, itemIndex) => itemIndex === index ? { ...item, duration: Math.max(1, Math.min(30, Number(event.currentTarget.value) || 1)) } : item) })} /><em>s</em></header>
          <input value={scene.location} placeholder="地点" aria-label={`第${index + 1}场地点`} onChange={(event) => setGenerated({ ...generated, scenes: generated.scenes.map((item, itemIndex) => itemIndex === index ? { ...item, location: event.currentTarget.value } : item) })} />
          <textarea value={scene.action} placeholder="画面与动作" aria-label={`第${index + 1}场动作`} onChange={(event) => setGenerated({ ...generated, scenes: generated.scenes.map((item, itemIndex) => itemIndex === index ? { ...item, action: event.currentTarget.value } : item) })} />
          <textarea value={scene.dialogue} placeholder="对白（可留空）" aria-label={`第${index + 1}场对白`} onChange={(event) => setGenerated({ ...generated, scenes: generated.scenes.map((item, itemIndex) => itemIndex === index ? { ...item, dialogue: event.currentTarget.value } : item) })} />
        </article>)}
      </div>
      <div className="script-director-preview-actions"><button type="button" className="script-director-secondary" onClick={() => setPreviewOpen(false)}>稍后处理</button><button type="button" className="script-director-primary" onClick={() => void saveGenerated()} disabled={working === 'save'}>{working === 'save' ? <LoaderCircle size={15} className="script-director-spinner" /> : <PenLine size={15} />} 写入项目剧本</button></div>
    </section>}

    {activeChoice && <div className="script-director-choice-dock" aria-label="待确认的问题">
      <DirectorChoiceCard
        messageId={activeChoice.messageId}
        choice={activeChoice.choice}
        selectedLabel={choiceSelections[activeChoice.messageId]}
        busy={busy}
        onSelect={(label) => setChoiceSelections((current) => ({ ...current, [activeChoice.messageId]: label }))}
        onDismiss={() => setChoiceDismissed((current) => ({ ...current, [activeChoice.messageId]: true }))}
        onContinue={(text) => {
          setChoiceDismissed((current) => ({ ...current, [activeChoice.messageId]: true }))
          void sendChatMessage(text)
        }}
      />
    </div>}

    {!activeChoice && <div className={`script-director-composer ${promptOpen ? 'is-prompt-open' : ''}`}>
      <button type="button" className="script-director-settings-trigger" onClick={openSettings} disabled={busy}>
        <span><Settings2 size={14} />剧本设定器</span>
        <small>{options.genre || '未设置，交给模型判断'}</small>
        <ChevronDown size={14} />
      </button>
      <textarea value={input} maxLength={8000} onChange={(event) => setInput(event.currentTarget.value)} onKeyDown={handleInputKeyDown} placeholder={activeFocus === 'all' ? '聊聊你的故事想法…' : `描述你希望如何处理${focusArtifactLabels[activeFocus]}…`} aria-label="剧本创作对话" disabled={busy} />
      {promptOpen && <div className="script-director-prompt-editor">
        <div className="script-director-prompt-head"><span>实际发送提示词</span><button type="button" onClick={() => void refreshPrompt()} disabled={promptLoading || busy}>恢复自动提示词</button></div>
        <textarea value={prompt} onChange={(event) => { setPromptCustomized(true); setPrompt(event.currentTarget.value) }} placeholder="正在生成提示词…" disabled={promptLoading || busy} />
        {promptError && <small>{promptError}</small>}
      </div>}
      <div className="script-director-composer-toolbar">
        <Select
          className="script-director-mode-select"
          aria-label="创作模式"
          value={mode}
          data={[{ value: 'all', label: '全能创作' }, { value: 'script', label: '剧本创编' }, { value: 'director', label: '导演执导' }]}
          allowDeselect={false}
          leftSection={<Sparkles size={13} />}
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
        <Select
          className="script-director-model-select"
          aria-label="文本模型"
          placeholder="选择文本模型"
          value={modelId || null}
          data={availableModels.map((model) => ({
            value: model.id,
            label: model.name,
          }))}
          allowDeselect={false}
          searchable
          size="xs"
          comboboxProps={{ withinPortal: true, zIndex: 400, position: 'top-start' }}
          onChange={(value) => setModelId(value || '')}
        />
        <button type="button" className="script-director-prompt-toggle" onClick={() => void refreshPrompt()} title="编辑发送提示词" disabled={busy}><PenLine size={14} /></button>
        <button type="button" className="script-director-draft" onClick={() => void generateScript()} disabled={busy || !input.trim() && !idea.trim()} title="生成剧本草稿" aria-label="生成剧本草稿">{working === 'prompt' || working === 'generate' ? <LoaderCircle size={15} className="script-director-spinner" /> : <FileText size={15} />}</button>
        <button type="button" className="script-director-send" onClick={() => working === 'chat' ? stopChatGeneration() : void sendChatMessage()} disabled={working === 'chat' ? false : busy || !input.trim() || !selectedModel} aria-label={working === 'chat' ? '停止生成' : '发送消息'} title={working === 'chat' ? '停止生成' : '发送消息'}>{working === 'chat' ? <X size={17} /> : <Send size={17} />}</button>
      </div>
      {!availableModels.length && <button type="button" className="script-director-model-link" onClick={onOpenModels}>还没有可用文本模型，前往模型设置添加</button>}
    </div>}

    {settingsOpen && <div className="script-director-settings-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false) }}>
      <section className={`script-director-settings-modal${showSettingPresets ? '' : ' is-presets-hidden'}`} role="dialog" aria-modal="true" aria-label="剧本设定器" onMouseDown={(event) => event.stopPropagation()}>
        {showSettingPresets && <aside className="script-director-settings-presets">
          <header><div><strong>爆款预设 Top 8</strong></div></header>
          <div className="script-director-settings-preset-list">
            {directorSettingPresets.map((preset, index) => <button type="button" key={preset.label} className={settingsDraft.genre === preset.values.genre && (!preset.artwork || settingsPresetArtwork === preset.artwork) ? 'is-active' : ''} style={preset.artwork ? { backgroundImage: `linear-gradient(100deg, #111720e8 0%, #11172072 62%, #11172025 100%), url("${preset.artwork}")` } : undefined} onClick={() => { setAutoFieldOpen(null); setStructurePickerOpen(false); setFusionRailOpen(Boolean(preset.values.genre_fusion)); setSettingsPresetArtwork(preset.artwork); setSettingsDraft((current) => ({ ...current, ...preset.values })) }}>
              <span className="script-director-preset-copy"><b>{index + 1}</b><span>{preset.label}</span></span>
            </button>)}
          </div>
          <button type="button" className="script-director-settings-custom" onClick={() => { setAutoFieldOpen(null); setStructurePickerOpen(false); setSettingsPresetArtwork(undefined); setSettingsDraft(emptyOptions) }}><PenLine size={13} />自定义设定</button>
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
                    items={settingsDraft.genre && !directorThemeChoices.includes(settingsDraft.genre) ? [settingsDraft.genre, ...directorThemeChoices] : directorThemeChoices}
                    selected={settingsDraft.genre || ''}
                    side="primary"
                    activeArtwork={settingsPresetArtwork === directorTop8Artwork ? undefined : settingsPresetArtwork}
                    onSelect={selectTheme}
                  />
                </div>
                <div className="script-director-theme-stage">
                  <div className="script-director-theme-stage-label"><span>当前题材关系</span><small>先选主题材，点击融合题材后从右侧选择</small></div>
                  <div className={`script-director-theme-orbit${settingsDraft.genre_fusion || fusionExitActive ? ' has-fusion' : ''}`}>
                    <ScriptThemeWaterCanvas primary={settingsDraft.genre || ''} fusion={settingsDraft.genre_fusion || ''} primaryArtwork={settingsPresetArtwork === directorTop8Artwork ? undefined : settingsPresetArtwork} onFusionSettled={() => setFusionExitActive(false)} />
                    {settingsDraft.genre_fusion ? <div className="script-director-theme-fusion-wrap">
                      <span
                        className={`script-director-theme-circle is-fusion tone-${directorThemeTone(settingsDraft.genre_fusion)}`}
                        style={{ '--theme-artwork': `url("${directorArtworkForTheme(settingsDraft.genre_fusion) || ''}")` } as CSSProperties}
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
                    items={(settingsDraft.genre_fusion && !directorThemeChoices.includes(settingsDraft.genre_fusion) ? [settingsDraft.genre_fusion, ...directorThemeChoices] : directorThemeChoices).filter((theme) => theme !== settingsDraft.genre)}
                    selected={settingsDraft.genre_fusion || ''}
                    side="fusion"
                    onSelect={selectFusionTheme}
                  />}
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
