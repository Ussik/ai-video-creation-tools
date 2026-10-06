import { useEffect, useState, type CSSProperties, type SyntheticEvent } from 'react'
import { Menu, NumberInput, Popover, Slider, Switch } from '@mantine/core'
import { ArrowLeftRight, Check, ChevronDown, Film, Image, Images, Scan, SlidersHorizontal, SquarePen, Type, Volume2, VolumeX } from 'lucide-react'
import { imageSizeChoices, selectImageSize } from './canvas-model-parameters'

export type CanvasVideoMode = 'text' | 'first_frame' | 'first_last_frame' | 'reference' | 'edit' | 'extend'
/** Parameters shared by the canvas generation popover and provider templates.
 *
 * Image-only fields intentionally live alongside the existing generic fields.
 * Providers decide whether they use them through their request template (for
 * example `{{quality}}` or `{{background}}`), so adding these controls does not
 * couple the canvas to a particular image API.
 */
export type ParametersPatch = {
  ratio?: string
  resolution?: string
  clarity?: string
  duration?: number
  generate_audio?: boolean
  quality?: string
  background?: string
}

export interface CanvasVideoModeMenuProps {
  value: CanvasVideoMode
  supportedModes: CanvasVideoMode[]
  onChange: (mode: CanvasVideoMode) => void
}

export interface CanvasGenerationParametersProps {
  modality: 'image' | 'video'
  ratios: string[]
  ratio: string
  resolutions: string[]
  resolution: string
  /** Image-only display levels shown as 1K/2K/4K. */
  clarities?: string[]
  clarity?: string
  duration: number
  minDuration: number
  maxDuration: number
  durationOptions?: number[]
  showDuration: boolean
  audioSupported: boolean
  generateAudio: boolean
  count: number
  /** Image quality choices, e.g. low/standard/high/ultra/extreme. */
  qualities?: string[]
  quality?: string
  /** Image background choices, e.g. auto/preserve/transparent. */
  backgrounds?: string[]
  background?: string
  onChange: (patch: ParametersPatch) => void
  onCountChange: (count: number) => void
}

const videoModes = [
  { value: 'text' as const, label: '文生视频', icon: Type },
  { value: 'first_frame' as const, label: '图生视频', icon: Image },
  { value: 'first_last_frame' as const, label: '首尾帧生视频', icon: ArrowLeftRight },
  { value: 'reference' as const, label: '参考生成', icon: Images },
  { value: 'edit' as const, label: '编辑视频', icon: SquarePen },
  { value: 'extend' as const, label: '延长视频', icon: Film },
]
const stopPropagation = (event: SyntheticEvent) => event.stopPropagation()
const overlayEvents = { onPointerDown: stopPropagation, onClick: stopPropagation, onWheel: stopPropagation, onKeyUp: stopPropagation }
const floatingMiddlewares = { flip: { padding: 12 }, shift: { padding: 12 } }

export function CanvasVideoModeMenu({ value, supportedModes, onChange }: CanvasVideoModeMenuProps) {
  const [opened, setOpened] = useState(false)
  const current = videoModes.find(mode => mode.value === value) || videoModes[0]
  const Icon = current.icon
  return <Menu opened={opened} onChange={setOpened} position="top-start" offset={10} width={236} withinPortal
    zIndex={220} middlewares={floatingMiddlewares} returnFocus preventPositionChangeWhenVisible={false}
    classNames={{ dropdown: 'pc-generation-mode-menu', item: 'pc-generation-mode-item', label: 'pc-generation-menu-heading' }}>
    <Menu.Target>
      <button type="button" className="pc-generation-control pc-generation-mode-trigger nodrag nowheel" data-canvas-overlay
        aria-label={`视频生成模式：${current.label}`} aria-expanded={opened} {...overlayEvents} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') setOpened(false) }}>
        <Icon size={15} /><span>{current.label}</span><ChevronDown size={13} />
      </button>
    </Menu.Target>
    <Menu.Dropdown className="nodrag nowheel" data-canvas-overlay {...overlayEvents} onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Escape') setOpened(false)
    }}>
      <Menu.Label>视频生成模式</Menu.Label>
      {videoModes.map(mode => {
        const ModeIcon = mode.icon
        const supported = supportedModes.includes(mode.value)
        return <Menu.Item key={mode.value} disabled={!supported} data-selected={mode.value === value || undefined}
          leftSection={<ModeIcon size={17} />} rightSection={mode.value === value ? <Check size={16} /> : undefined}
          aria-label={`${mode.label}${supported ? '' : '，当前模型不支持'}`} onClick={() => onChange(mode.value)}>
          {mode.label}
        </Menu.Item>
      })}
    </Menu.Dropdown>
  </Menu>
}

function ratioShape(ratio: string, maxSize = 29): CSSProperties {
  const [width, height] = ratio.split(':').map(Number)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { width: 23, height: 20 }
  const factor = maxSize / Math.max(width, height)
  return { width: Math.max(9, Math.round(width * factor)), height: Math.max(9, Math.round(height * factor)) }
}

const imageQualityLabels: Record<string, string> = {
  low: '低画质',
  standard: '标准画质',
  medium: '标准画质',
  high: '高画质',
  ultra: '超高画质',
  extreme: '极致画质',
  auto: '自动',
}
const imageBackgroundLabels: Record<string, string> = {
  auto: '自动',
  preserve: '保留背景',
  keep: '保留背景',
  transparent: '透明背景',
}
const imageQualityLabel = (value: string) => imageQualityLabels[value.toLowerCase()] || value
const imageBackgroundLabel = (value: string) => imageBackgroundLabels[value.toLowerCase()] || value

export function CanvasGenerationParameters({ modality, ratios, ratio, resolutions, resolution, clarities = [], clarity = '', duration,
  minDuration, maxDuration, durationOptions, showDuration, audioSupported, generateAudio, count,
  qualities = [], quality = '', backgrounds = [], background = '', onChange, onCountChange }: CanvasGenerationParametersProps) {
  const [opened, setOpened] = useState(false)
  const min = Number.isFinite(minDuration) ? Math.max(1, Math.ceil(minDuration)) : 1
  const max = Number.isFinite(maxDuration) ? Math.max(min, Math.floor(maxDuration)) : min
  const options = [...new Set((durationOptions || []).filter(value => Number.isInteger(value) && value >= min && value <= max))].sort((a, b) => a - b)
  const optionsKey = options.join(',')
  const [durationDraft, setDurationDraft] = useState<string | number>(duration)
  useEffect(() => { setDurationDraft(duration) }, [duration, min, max, optionsKey])
  const snapDuration = (value: number) => {
    const clamped = Math.max(min, Math.min(max, Math.round(value)))
    return options.length ? options.reduce((best, option) => Math.abs(option - clamped) < Math.abs(best - clamped) ? option : best) : clamped
  }
  const commitDurationDraft = () => {
    const parsed = typeof durationDraft === 'number' ? durationDraft : Number(durationDraft)
    const next = snapDuration(Number.isFinite(parsed) && String(durationDraft).trim() ? parsed : duration)
    setDurationDraft(next)
    if (next !== duration) onChange({ duration: next })
  }
  const selectedDuration = snapDuration(Number.isFinite(duration) ? duration : min)
  const durationEnabled = modality === 'video' && showDuration
  const audioEnabled = modality === 'video' && audioSupported
  const fixedSizes = modality === 'image' && ratios.length === 0 ? imageSizeChoices(resolutions) : []
  const imageClarity = clarity || fixedSizes.find(option => option.resolution === resolution)?.clarity || resolution
  const supportedClarities = [...new Set(clarities.length ? clarities : fixedSizes.length ? fixedSizes.map(option => option.clarity) : resolutions)]
  const displayRatios = [...new Set(fixedSizes.length ? fixedSizes.map(option => option.ratio) : ratios)]
  const changeImageSize = (selection: { ratio?: string; clarity?: string }) => {
    const next = selectImageSize(resolutions, resolution, selection)
    if (next) onChange({ resolution: next.resolution, ratio: next.ratio })
  }
  const summary = [ratio === 'adaptive' ? '自适应' : ratio, modality === 'image' ? imageClarity : resolution,
    durationEnabled ? `${duration}s` : '', `${count}${modality === 'image' ? '张' : '个'}`].filter(Boolean).join(' · ')
  return <Popover opened={opened} onChange={setOpened} position="top-start" offset={8} width={modality === 'image' ? 'min(320px, calc(100vw - 24px))' : 360} withinPortal
    middlewares={floatingMiddlewares} zIndex={220} trapFocus returnFocus preventPositionChangeWhenVisible={false}
    classNames={{ dropdown: `pc-generation-parameters-popover${modality === 'image' ? ' pc-generation-image-parameters' : ''}` }}>
    <Popover.Target>
      <button type="button" className="pc-generation-control pc-generation-parameters-trigger nodrag nowheel" data-canvas-overlay
        aria-label={`生成参数：${summary}${audioEnabled ? generateAudio ? '，声音开启' : '，声音关闭' : ''}`}
        aria-expanded={opened} aria-haspopup="dialog" {...overlayEvents} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') setOpened(false) }} onClick={event => { event.stopPropagation(); setOpened(value => !value) }}>
        <SlidersHorizontal size={15} /><span>{summary}</span>
        {audioEnabled && (generateAudio ? <Volume2 size={15} /> : <VolumeX size={15} />)}<ChevronDown size={13} />
      </button>
    </Popover.Target>
    <Popover.Dropdown className="nodrag nowheel" data-canvas-overlay role="dialog" aria-label="生成参数" {...overlayEvents}
      onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') setOpened(false) }}>
      {modality === 'video' && <div className="pc-generation-parameters-heading">生成参数</div>}
      {modality === 'image' && qualities.length > 0 && <section className="pc-generation-parameter-section">
        <div className="pc-generation-parameter-heading"><span>画质</span></div>
        <div className="pc-generation-options pc-generation-image-quality-options" role="group" aria-label="画质">
          {[...new Set(qualities)].map(option => <button type="button" key={option} aria-pressed={quality === option}
            onClick={() => onChange({ quality: option })}>{imageQualityLabel(option)}</button>)}
        </div>
      </section>}
      {modality === 'image' && supportedClarities.length > 0 && <section className="pc-generation-parameter-section">
        <div className="pc-generation-parameter-heading"><span>清晰度</span></div>
        <div className="pc-generation-options pc-generation-image-clarity-options" role="group" aria-label="清晰度">
          {supportedClarities.map(option => <button type="button" key={option} aria-pressed={imageClarity === option}
            title={!clarities.length ? fixedSizes.filter(size => size.clarity === option).map(size => size.resolution).join(' / ') || option : option}
            onClick={() => clarities.length ? onChange({ clarity: option }) : fixedSizes.length ? changeImageSize({ clarity: option }) : onChange({ resolution: option })}>{option}</button>)}
        </div>
      </section>}
      {modality === 'video' && resolutions.length > 0 && <section className="pc-generation-parameter-section">
        <div className="pc-generation-parameter-heading"><span>清晰度</span><small>{resolution}</small></div>
        <div className="pc-generation-options" role="group" aria-label="清晰度">
          {[...new Set(resolutions)].map(option => <button type="button" key={option} aria-pressed={resolution === option}
            onClick={() => onChange({ resolution: option })}>{option}</button>)}
        </div>
      </section>}
      {modality === 'image' && backgrounds.length > 0 && <section className="pc-generation-parameter-section">
        <div className="pc-generation-parameter-heading"><span>背景</span></div>
        <div className="pc-generation-options pc-generation-image-background-options" role="group" aria-label="背景">
          {[...new Set(backgrounds)].map(option => <button type="button" key={option} aria-pressed={background === option}
            onClick={() => onChange({ background: option })}>{imageBackgroundLabel(option)}</button>)}
        </div>
      </section>}
      {displayRatios.length > 0 && <section className="pc-generation-parameter-section">
        <div className="pc-generation-parameter-heading"><span>比例</span>{modality === 'video' && <small>{ratio === 'adaptive' ? '自适应' : ratio}</small>}</div>
        <div className={`pc-generation-ratios ${modality === 'image' ? 'pc-generation-image-ratios' : ''}`} role="group" aria-label="比例"
          style={modality === 'image' ? { gridTemplateColumns: `repeat(${Math.min(5, displayRatios.length)}, minmax(0, 1fr))` } : undefined}>
          {displayRatios.map(option => <button type="button" key={option} className="pc-generation-ratio" aria-pressed={ratio === option}
            title={option}
            onClick={() => fixedSizes.length ? changeImageSize({ ratio: option }) : onChange({ ratio: option })}>
            <span className="pc-generation-ratio-preview">{option === 'adaptive' ? <Scan size={26} /> : <i style={ratioShape(option, modality === 'image' ? 22 : 29)} />}</span>
            <span>{option === 'adaptive' ? '自适应' : option}</span>
          </button>)}
        </div>
      </section>}
      {durationEnabled && <section className="pc-generation-parameter-section">
        <div className="pc-generation-parameter-heading"><span>视频时长</span><small>秒</small></div>
        <div className="pc-generation-duration">
          <Slider aria-label="视频时长" min={min} max={max === min ? min + 1 : max} step={1} value={selectedDuration}
            disabled={min === max || options.length === 1} label={value => `${snapDuration(value)} 秒`}
            marks={options.length > 1 && options.length <= 6 ? options.map(value => ({ value })) : undefined}
            onChange={value => onChange({ duration: snapDuration(value) })}
            classNames={{ root: 'pc-generation-duration-slider', track: 'pc-generation-duration-track', bar: 'pc-generation-duration-bar', thumb: 'pc-generation-duration-thumb' }} />
          <NumberInput aria-label="输入视频时长" value={durationDraft} min={min} max={max} step={1} allowDecimal={false} allowNegative={false}
            styles={{ input: { background: '#313131', borderColor: '#4a4a4a', color: '#e5e5e5', minHeight: 32, height: 32 } }}
            clampBehavior="none" disabled={min === max || options.length === 1} hideControls
            onChange={value => {
              setDurationDraft(value)
              if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max && (!options.length || options.includes(value))) {
                onChange({ duration: value })
              }
            }}
            onBlur={commitDurationDraft}
            onKeyDown={event => {
              event.stopPropagation()
              if (event.key === 'Enter') { event.preventDefault(); commitDurationDraft() }
              if (event.key === 'Escape') setOpened(false)
            }}
            classNames={{ root: 'pc-generation-duration-input', input: 'pc-generation-number-input' }} />
        </div>
        <div className="pc-generation-duration-range"><span>{options[0] ?? min}s</span><span>{options[options.length - 1] ?? max}s</span></div>
      </section>}
      {audioEnabled && <section className="pc-generation-parameter-section pc-generation-audio">
        <div><Volume2 size={17} /><span>生成声音</span></div>
        <Switch aria-label="生成声音" checked={generateAudio} onChange={event => onChange({ generate_audio: event.currentTarget.checked })}
          color="gray" classNames={{ track: 'pc-generation-audio-track', thumb: 'pc-generation-audio-thumb' }} />
      </section>}
      <section className="pc-generation-parameter-section">
        <div className="pc-generation-parameter-heading"><span>生成数量</span>{modality === 'video' && <small>候选</small>}</div>
        <div className="pc-generation-options" role="group" aria-label="生成候选数量">
          {[1, 2, 4].map(option => <button type="button" key={option} aria-pressed={count === option} onClick={() => onCountChange(option)}>
            {option}{modality === 'image' ? '张' : ' 个'}{modality === 'video' && option === count && <Check size={14} />}
          </button>)}
        </div>
      </section>
    </Popover.Dropdown>
  </Popover>
}
