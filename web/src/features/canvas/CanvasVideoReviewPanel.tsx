import { useEffect, useRef, useState } from 'react'
import { Alert, Badge, Button, Loader, Select, Textarea } from '@mantine/core'
import { Clock3, Play, RefreshCw, ScanEye, TriangleAlert, X } from 'lucide-react'
import type { VideoReviewReport } from '@video-studio/shared/media/video-review'
import { api, json } from '../../shared/api/api'
import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'
import { videoReviewTime, type VideoReviewModelOption } from './canvas-video-review'
import { useSharedModelSelection } from '../models/useSharedModelSelection'
import './canvas-video-review.css'

export interface CanvasVideoReviewPanelProps {
  projectId: string
  assetId: string
  shotId?: string | null
  models: VideoReviewModelOption[]
  onSeek: (timeMs: number) => void
  onClose: () => void
}

const categories = { action: '动作与表演', continuity: '人物与道具', composition: '构图与运镜', style: '画面风格', dialogue_audio: '对白与声音' }
const verdicts = { usable: '可用', needs_work: '需要修改', uncertain: '待人工确认' }
const checkLabels = { pass: '通过', issue: '有问题', uncertain: '未确认' }
const colors = { usable: 'teal', needs_work: 'orange', uncertain: 'gray' }

export default function CanvasVideoReviewPanel({ projectId, assetId, shotId, models, onSeek, onClose }: CanvasVideoReviewPanelProps) {
  const [instructions, setInstructions] = useState('')
  const [reviews, setReviews] = useState<VideoReviewReport[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const { modelId, selectModel } = useSharedModelSelection('text', models, { locked: pending })
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const serial = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const selected = reviews.find(report => report.id === selectedId) || reviews[0]
  const model = models.find(item => item.id === modelId)
  const path = `/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/video-reviews`

  useEffect(() => {
    const request = new AbortController()
    serial.current++
    controller.current?.abort()
    setReviews([]); setSelectedId(''); setInstructions(''); setError(''); setNotice(''); setPending(false); setLoading(true)
    void api<{ reviews: VideoReviewReport[] }>(path, { signal: request.signal }).then(result => {
      if (request.signal.aborted) return
      setReviews(current => [...current, ...result.reviews.filter(report => !current.some(item => item.id === report.id))])
    }).catch(issue => { if (!request.signal.aborted) setError(`读取复核记录失败：${issue instanceof Error ? issue.message : String(issue)}`) })
      .finally(() => { if (!request.signal.aborted) setLoading(false) })
    return () => { request.abort(); serial.current++; controller.current?.abort() }
  }, [path])
  useEffect(() => {
    if (!pending) return
    const started = Date.now()
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [pending])

  async function review() {
    if (pending || controller.current && !controller.current.signal.aborted || !model) return
    const turn = ++serial.current
    const request = new AbortController()
    controller.current = request
    setPending(true); setElapsed(0); setError(''); setNotice('')
    try {
      const report = await api<VideoReviewReport>(path, { ...json('POST', { model_id: model.id, ...(shotId ? { shot_id: shotId } : {}), instructions: instructions.trim() }), signal: request.signal })
      if (turn !== serial.current || request.signal.aborted) return
      setReviews(current => [report, ...current.filter(item => item.id !== report.id)])
      setSelectedId(report.id)
    } catch (issue) {
      if (turn === serial.current && !request.signal.aborted) setError(issue instanceof Error ? issue.message : String(issue))
    } finally { if (turn === serial.current) { setPending(false); controller.current = null } }
  }
  function cancel() {
    serial.current++; controller.current?.abort(); controller.current = null
    setPending(false); setNotice('已取消本次复核，已有报告保留。')
  }

  return <aside className="pc-video-review" aria-label="成片复核">
    <header className="pc-video-review-heading"><ScanEye size={18} /><div><h2>成片复核</h2><p>对照镜头意图检查实际画面，定位问题与可用片段。</p></div>
      <Button variant="subtle" color="gray" size="compact-xs" aria-label="关闭成片复核面板" onClick={onClose}><X size={16} /></Button></header>
    <div className="pc-video-review-form">
      <Select label="复核模型" aria-label="成片复核模型" placeholder="选择视频或图片理解模型" value={model?.id || null}
        data={models.map(item => ({ value: item.id, label: item.label }))} onChange={value => selectModel(value || '')}
        searchable allowDeselect={false} disabled={pending || !models.length} comboboxProps={{ zIndex: 350 }} />
      {!models.length && <Alert color="yellow" title="暂无可用的复核模型" icon={<TriangleAlert size={16} />}>请在模型设置中为已确认支持的文本模型开启图片理解或视频理解。</Alert>}
      {model?.inputMode === 'sampled_frames' && <p className="pc-video-review-hint">此模型检查按时间排列的抽样画面；连续运动、滑步速度及声音仍需播放确认。</p>}
      {model?.inputMode === 'native_video' && <p className="pc-video-review-hint">将视频交给所选模型理解；模型无法确认的动作或声音会保留为待确认项。</p>}
      <Textarea label="复核重点" aria-label="成片复核重点" placeholder="例如：确认跑入后站稳；背景居民按剧情保持静止。" value={instructions}
        onChange={event => setInstructions(event.currentTarget.value)} maxLength={4000} minRows={2} autosize maxRows={5} disabled={pending} />
      <div className="pc-video-review-actions"><Button size="sm" leftSection={<ScanEye size={15} />} disabled={pending || !model} onClick={() => void review()}>{reviews.length ? '重新复核' : '开始复核'}</Button>
        {pending && <Button variant="default" size="sm" onClick={cancel}>取消复核</Button>}</div>
      {pending && <div className="pc-video-review-progress" role="status"><Loader size={14} /><span>正在分析画面 · 已等待 {elapsed} 秒，可取消后重试</span></div>}
      {!!notice && <p className="pc-video-review-hint" role="status">{notice}</p>}
      {!!error && <Alert color="red" title="复核未完成" icon={<TriangleAlert size={16} />}>{error}</Alert>}
    </div>
    {loading && <div className="pc-video-review-progress" role="status"><Loader size={14} />正在读取复核记录</div>}
    {selected && <div className="pc-video-review-report">
      {reviews.length > 1 && <Select label="复核记录" aria-label="复核记录" value={selected.id} onChange={value => setSelectedId(value || '')}
        data={reviews.map(report => ({ value: report.id, label: `${new Date(report.created_at).toLocaleString()} · ${report.model_name}` }))} allowDeselect={false} comboboxProps={{ zIndex: 350 }} />}
      <div className="pc-video-review-verdict"><Badge color={colors[selected.verdict]} variant="light">{verdicts[selected.verdict]}</Badge>
        <span>{selected.input_mode === 'native_video' ? '视频理解' : '画面抽样'} · {selected.model_name}</span></div>
      {selected.stale && <Alert color="yellow" title="报告依据已变化" icon={<RefreshCw size={15} />}>镜头意图或素材已更新，请重新复核后判断。</Alert>}
      <p className="pc-video-review-summary">{selected.summary}</p>
      <div className="pc-video-review-duration"><Clock3 size={14} /><span>素材 {videoReviewTime(selected.duration_ms)}{selected.target_duration_ms !== null ? ` · 计划入片 ${(selected.target_duration_ms / 1000).toFixed(1)} 秒` : ''}</span></div>
      <div className="pc-video-review-checks" aria-label="各项复核结果">{selected.checks.map((check, index) => <div key={`${check.category}-${index}`}><Badge size="xs" color={check.status === 'pass' ? 'teal' : check.status === 'issue' ? 'orange' : 'gray'}>{checkLabels[check.status]}</Badge><span><strong>{categories[check.category]}</strong>{check.detail}</span></div>)}</div>
      {!!selected.limitations.length && <Alert color="gray" title="仍需确认" icon={<TriangleAlert size={15} />}><ul>{selected.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></Alert>}
      <section aria-label="问题片段"><h3>问题片段 · {selected.findings.length}</h3>
        {!selected.findings.length && <p className="pc-video-review-hint">未报告明确问题，仍需结合待确认项播放检查。</p>}
        {selected.findings.map(finding => <article className="pc-video-review-finding" key={finding.id}>
          <div className="pc-video-review-finding-heading"><Badge size="xs" color={finding.severity === 'error' ? 'red' : finding.severity === 'warning' ? 'orange' : 'gray'}>{categories[finding.category]}</Badge>
            <Button variant="subtle" size="compact-xs" leftSection={<Play size={12} />} onClick={() => onSeek(finding.start_ms)} aria-label={`播放问题片段 ${videoReviewTime(finding.start_ms)}`}>{videoReviewTime(finding.start_ms)}–{videoReviewTime(finding.end_ms)}</Button></div>
          <p>{finding.observation}</p><dl><dt>镜头要求</dt><dd>{finding.expected}</dd><dt>修改建议</dt><dd>{finding.suggestion}</dd></dl>
          {!!finding.evidence_times_ms.length && <div className="pc-video-review-evidence-links">{finding.evidence_times_ms.map(time => <Button key={time} variant="default" size="compact-xs" onClick={() => onSeek(time)}>查看 {videoReviewTime(time)}</Button>)}</div>}
        </article>)}
      </section>
      {!!selected.usable_ranges.length && <section aria-label="可用片段建议"><h3>可用片段建议</h3><p className="pc-video-review-hint">供剪辑判断，尚未修改入片范围。</p>{selected.usable_ranges.map((range, index) => <div className="pc-video-review-range" key={index}>
        <Button variant="default" size="compact-xs" leftSection={<Play size={12} />} onClick={() => onSeek(range.start_ms)}>{videoReviewTime(range.start_ms)}–{videoReviewTime(range.end_ms)}</Button><p>{range.reason}</p></div>)}</section>}
      {!!selected.evidence_frames.length && <WorkspaceDisclosure label={`画面证据 · ${selected.evidence_frames.length} 帧`}><div className="pc-video-review-frames">{selected.evidence_frames.map(frame => <Button key={frame.time_ms} variant="subtle" className="pc-video-review-frame" onClick={() => onSeek(frame.time_ms)} aria-label={`查看证据画面 ${videoReviewTime(frame.time_ms)}`}>
        <img src={frame.url} alt={`${videoReviewTime(frame.time_ms)} 的视频画面`} loading="lazy" /><span>{videoReviewTime(frame.time_ms)}</span></Button>)}</div></WorkspaceDisclosure>}
    </div>}
  </aside>
}
