import { useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { Alert, Badge, Button, FileButton, Loader, NumberInput, SimpleGrid, Textarea } from '@mantine/core'
import { Check, Copy, Film, Play, ScanSearch, Settings2, Sparkles, TriangleAlert, Upload, X } from 'lucide-react'
import { videoAnalysisShotPrompt, videoAnalysisText, type VideoPromptAnalysisResult } from '@video-studio/shared/media/video-prompt-analysis'
import { StudioMediaPlayer } from '../../shared/ui/media/StudioMediaPlayer'
import CanvasSelect from './CanvasSelect'
import { videoAnalysisRangeIssue, videoAnalysisTime } from './canvas-video-analysis'
import './canvas-video-analysis-panel.css'

export type CanvasVideoAnalysisPanelProps = {
  asset?: { id: string; url: string; label?: string }
  models: { id: string; label: string }[]
  modelId: string
  instructions: string
  startMs: number
  endMs: number | null
  durationMs?: number
  fps: number
  result?: VideoPromptAnalysisResult
  pending?: boolean
  uploading?: boolean
  otherPending?: boolean
  error?: string
  elapsedSeconds?: number
  onUpload: (file: File) => void
  onClearSource?: () => void
  onModelChange: (modelId: string) => void
  onInstructionsChange: (value: string) => void
  onRangeChange: (startMs: number, endMs: number | null) => void
  onFpsChange: (fps: number) => void
  onDurationChange?: (durationMs: number) => void
  onResultChange: (result: VideoPromptAnalysisResult) => void
  onAnalyze: () => void
  onCancel?: () => void
  onOpenModels?: () => void
  onCreateGeneration: (shotIndex: number) => void
}

const stopPropagation = (event: SyntheticEvent) => event.stopPropagation()

export default function CanvasVideoAnalysisPanel({ asset, models, modelId, instructions, startMs, endMs, durationMs, fps, result,
  pending = false, uploading = false, otherPending = false, error, elapsedSeconds = 0,
  onUpload, onClearSource, onModelChange, onInstructionsChange, onRangeChange, onFpsChange, onDurationChange,
  onResultChange, onAnalyze, onCancel, onOpenModels, onCreateGeneration,
}: CanvasVideoAnalysisPanelProps) {
  const resetUpload = useRef<() => void>(null)
  const video = useRef<HTMLVideoElement>(null)
  const [shotIndex, setShotIndex] = useState(0)
  const [copied, setCopied] = useState<'shot' | 'all' | null>(null)
  const [copyError, setCopyError] = useState('')
  const processing = pending || uploading, busy = processing || otherPending
  const selectedModel = models.some(model => model.id === modelId)
  const rangeIssue = videoAnalysisRangeIssue(startMs, endMs, durationMs)
  const fpsIssue = !Number.isFinite(fps) || fps < .2 || fps > 5 ? '每秒采样帧数应为 0.2–5' : ''
  const selectedIndex = Math.min(shotIndex, Math.max(0, (result?.shots.length || 1) - 1))
  const shot = result?.shots[selectedIndex]
  const sourceChanged = !!result && result.asset_id !== asset?.id
  const seconds = Math.max(0, Math.floor(elapsedSeconds))
  const selectionDuration = (endMs ?? durationMs) !== undefined ? (endMs ?? durationMs)! - startMs : undefined
  useEffect(() => { setCopied(null); setCopyError('') }, [result])
  useEffect(() => setShotIndex(0), [result?.asset_id, result?.start_ms, result?.end_ms])
  const copy = async (kind: 'shot' | 'all') => {
    if (!result || !shot) return
    try {
      await navigator.clipboard.writeText(kind === 'all' ? videoAnalysisText(result) : videoAnalysisShotPrompt(shot, result.global_style))
      setCopied(kind); setCopyError('')
    } catch { setCopyError('复制失败，请选中下方提示词后复制。') }
  }
  const updateShot = (key: 'image_prompt' | 'video_prompt', value: string) => {
    if (!result) return
    onResultChange({ ...result, shots: result.shots.map((item, index) => index === selectedIndex ? { ...item, [key]: value } : item) })
  }
  const seekShot = () => {
    if (!video.current || !shot || sourceChanged) return
    video.current.currentTime = shot.start_ms / 1000
    video.current.dispatchEvent(new Event('timeupdate'))
    void video.current.play().catch(() => setCopyError('视频暂时无法播放，可使用播放器定位查看。'))
  }
  return <section className="pc-video-analysis-panel nodrag nowheel" aria-label="视频反推提示词" data-canvas-overlay
    onPointerDown={stopPropagation} onClick={stopPropagation} onKeyDown={stopPropagation} onWheel={stopPropagation}>
    <header className="pc-video-analysis-heading"><ScanSearch size={18} /><div><h2>视频反推提示词</h2>
      <p>上传视频，或连接画布中的视频节点，分析画风、动作与运镜，整理为逐镜头提示词。</p></div></header>
    <div className={`pc-video-analysis-source${asset ? ' has-video' : ''}`}>
      {asset ? <><StudioMediaPlayer key={`${asset.id}:${asset.url}`} ref={video} src={asset.url} controls playsInline preload="metadata"
        onLoadedMetadata={(event: SyntheticEvent<HTMLVideoElement>) => { const duration = event.currentTarget.duration; if (Number.isFinite(duration) && duration > 0) onDurationChange?.(Math.round(duration * 1000)) }} />
        <span className="pc-video-analysis-source-label">{asset.label || '待反推视频'}{durationMs ? ` · ${(durationMs / 1000).toFixed(2)} 秒` : ''}</span></>
        : <div className="pc-video-analysis-placeholder"><Film size={30} /><strong>添加待分析视频</strong><span>支持 MP4、MOV，单次分析范围不超过 180 秒</span></div>}
      <div className="pc-video-analysis-actions"><FileButton resetRef={resetUpload} accept="video/mp4,video/quicktime,.mp4,.mov" disabled={busy}
        onChange={file => { if (file) onUpload(file); resetUpload.current?.() }}>
        {props => <Button {...props} type="button" size="xs" variant="default" disabled={busy} loading={uploading} leftSection={<Upload size={14} />}>
          {uploading ? '正在上传' : asset ? '替换视频' : '上传视频'}</Button>}
      </FileButton>
        {asset && onClearSource && <Button type="button" size="xs" variant="subtle" color="gray" disabled={busy} leftSection={<X size={14} />} onClick={onClearSource}>清空来源视频</Button>}
      </div>
    </div>
    <div className="pc-video-analysis-settings">
      <CanvasSelect label="视频理解模型" placeholder="选择已配置的豆包模型" data={models.map(model => ({ value: model.id, label: model.label }))}
        value={selectedModel ? modelId : null} onChange={value => { if (value) onModelChange(value) }} disabled={busy || !models.length} searchable size="sm" />
      {!models.length && <Alert className="pc-video-analysis-model-notice" color="gray" variant="light" icon={<Settings2 size={16} />}
        title="暂无可用的豆包视频理解模型">
        <div className="pc-video-analysis-model-guidance">
          <span>为豆包文本模型开启“支持视频理解”，视频输入格式设为“豆包视频理解”。</span>
          {onOpenModels && <Button type="button" size="compact-xs" variant="default" disabled={busy} onClick={onOpenModels}>去模型设置</Button>}
        </div>
      </Alert>}
      <SimpleGrid className="pc-video-analysis-parameters" cols={{ base: 1, sm: 3 }} spacing="sm">
        <NumberInput label="开始时间（秒）" value={startMs / 1000} min={0} decimalScale={2} step={1} disabled={busy || !asset}
          inputWrapperOrder={['label', 'input', 'description', 'error']}
          onChange={value => onRangeChange(typeof value === 'number' ? Math.round(value * 1000) : 0, endMs)} />
        <NumberInput label="结束时间（秒）" description="留空使用视频结尾" placeholder="视频结尾" value={endMs === null ? '' : endMs / 1000} min={0} decimalScale={2} step={1} disabled={busy || !asset}
          inputWrapperOrder={['label', 'input', 'description', 'error']}
          onChange={value => onRangeChange(startMs, typeof value === 'number' ? Math.round(value * 1000) : null)} />
        <NumberInput label="每秒采样帧数" description="动作快可调高，可能增加用量" value={fps} min={.2} max={5} step={.2} decimalScale={1} clampBehavior="strict" disabled={busy}
          inputWrapperOrder={['label', 'input', 'description', 'error']}
          onChange={value => { if (typeof value === 'number') onFpsChange(value) }} />
      </SimpleGrid>
      {asset && <p className="pc-video-analysis-hint">
        {selectionDuration !== undefined && selectionDuration > 0 && <span>本次选取 {(selectionDuration / 1000).toFixed(2)} 秒</span>}
        <span>仅分析画面，不转写声音与对白。</span>
      </p>}
    </div>
    {(rangeIssue || fpsIssue) && <Alert color="yellow" icon={<TriangleAlert size={16} />}>{rangeIssue || fpsIssue}</Alert>}
    {otherPending && <Alert color="blue" icon={<ScanSearch size={16} />}>另一个反推节点正在处理，请完成或取消后再操作。</Alert>}
    <Textarea label="反推要求" description="选填，说明要重点分析的内容" placeholder="例如：重点拆解剑招、碰撞后的受力反应、环境反馈和摄影机移动"
      value={instructions} onChange={event => onInstructionsChange(event.currentTarget.value)} disabled={busy} maxLength={4000} autosize minRows={2} maxRows={5} size="sm" />
    <div className="pc-video-analysis-actions pc-video-analysis-run"><Button type="button" size="sm" leftSection={<ScanSearch size={15} />} loading={pending}
      disabled={busy || !asset || !selectedModel || !!rangeIssue || !!fpsIssue} onClick={onAnalyze}>{result ? '重新反推' : '开始反推'}</Button>
      {processing && onCancel && <Button type="button" size="sm" variant="subtle" onClick={onCancel}>{uploading ? '取消上传' : '取消反推'}</Button>}
    </div>
    {pending && <div className="pc-video-analysis-status" role="status" aria-live="polite"><Loader size={14} /><span>正在分析视频{seconds > 0 ? `，已等待 ${seconds} 秒` : '…'}{seconds >= 60 ? '，可取消后重试' : ''}</span></div>}
    {error && <Alert color="red" icon={<TriangleAlert size={16} />} title="反推未完成">{error}</Alert>}
    {result && <div className="pc-video-analysis-result">
      {sourceChanged && <Alert color="yellow" icon={<TriangleAlert size={16} />}>来源视频已变化，下方保留上次结果；请重新反推后创建生成节点。</Alert>}
      <Textarea label="整体画风" value={result.global_style} disabled={busy} maxLength={4000} autosize minRows={3} maxRows={7}
        onChange={event => onResultChange({ ...result, global_style: event.currentTarget.value })} />
      <CanvasSelect label={`镜头拆解 · ${result.shots.length} 个镜头`} value={String(selectedIndex)} disabled={busy || !result.shots.length}
        data={result.shots.map((item, index) => ({ value: String(index), label: `${index + 1}. ${item.title} · ${videoAnalysisTime(item.start_ms)}–${videoAnalysisTime(item.end_ms)}` }))}
        onChange={value => { if (value !== null) setShotIndex(Number(value)) }} searchable size="sm" />
      {shot && <>
        <div className="pc-video-analysis-shot-time"><Badge variant="light">原片 {(shot.end_ms - shot.start_ms) / 1000} 秒</Badge>
          <Button type="button" size="compact-xs" variant="subtle" leftSection={<Play size={13} />} disabled={!asset || sourceChanged} onClick={seekShot}>
            查看 {videoAnalysisTime(shot.start_ms)}–{videoAnalysisTime(shot.end_ms)}</Button></div>
        <dl className="pc-video-analysis-observations">{([
          ['起始状态', shot.start_state], ['主动作', shot.action], ['结束状态', shot.end_state], ['摄影机', shot.camera], ['特效与环境反馈', shot.vfx],
        ] as const).filter(([, value]) => !!value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <Textarea label="视频提示词" description="可编辑后复制，或创建当前镜头的视频生成节点" value={shot.video_prompt} disabled={busy} maxLength={12000} autosize minRows={6} maxRows={16}
          onChange={event => updateShot('video_prompt', event.currentTarget.value)} />
        <Textarea label="首帧图片提示词" value={shot.image_prompt} disabled={busy} maxLength={12000} autosize minRows={3} maxRows={9}
          onChange={event => updateShot('image_prompt', event.currentTarget.value)} />
        <div className="pc-video-analysis-actions"><Button type="button" size="xs" variant="default" disabled={!shot.video_prompt.trim() || pending} onClick={() => void copy('shot')}
          leftSection={copied === 'shot' ? <Check size={14} /> : <Copy size={14} />}>{copied === 'shot' ? '已复制当前镜头' : '复制当前镜头'}</Button>
          <Button type="button" size="xs" variant="default" disabled={!result.shots.length || pending} onClick={() => void copy('all')}
            leftSection={copied === 'all' ? <Check size={14} /> : <Copy size={14} />}>{copied === 'all' ? '已复制全部镜头' : '复制全部镜头'}</Button>
          <Button type="button" size="xs" variant="light" disabled={!shot.video_prompt.trim() || busy || sourceChanged} onClick={() => onCreateGeneration(selectedIndex)} leftSection={<Sparkles size={14} />}>创建当前镜头视频节点</Button>
        </div>
      </>}
      {copyError && <Alert color="red" icon={<TriangleAlert size={16} />}>{copyError}</Alert>}
      {!![...result.uncertainties, ...(shot?.uncertainties || [])].length && <Alert color="gray" title="待确认内容">
        {[...new Set([...result.uncertainties, ...(shot?.uncertainties || [])])].map((item, index) => <p key={`${index}:${item}`}>{item}</p>)}
      </Alert>}
    </div>}
  </section>
}
