import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Loader, Select, Textarea } from '@mantine/core'
import { GitCompare, Play, X } from 'lucide-react'
import type { VideoComparison } from '@video-studio/shared/media/video-comparison'
import { api, json, type Asset } from '../../shared/api/api'
import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'
import { StudioMediaPlayer } from '../../shared/ui/media/StudioMediaPlayer'
import './canvas-video-comparison.css'

type Props = { projectId: string; asset: Asset; onClose: () => void; onReviewCandidate?: (asset: Asset) => void }
const seconds = (milliseconds: number) => `${Number((milliseconds / 1000).toFixed(2))} 秒`
const labels: Record<VideoComparison['status'], string> = {
  prepared: '已准备', starting: '正在提交', queued: '等待生成', running: '正在生成', succeeded: '生成完成', failed: '生成失败',
}

export default function CanvasVideoComparisonPanel({ projectId, asset, onClose, onReviewCandidate }: Props) {
  const [records, setRecords] = useState<VideoComparison[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [candidate, setCandidate] = useState(asset.prompt || '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const controller = useRef<AbortController | null>(null)
  const selected = records.find(record => record.id === selectedId)
  const base = `/projects/${encodeURIComponent(projectId)}/video-comparisons`
  const generated = asset.source === 'generated' && !!asset.shot_id
  const remember = (record: VideoComparison) => {
    setRecords(current => [record, ...current.filter(item => item.id !== record.id)])
    setSelectedId(record.id)
  }
  useEffect(() => {
    const abort = new AbortController()
    setLoading(true); setError(''); setRecords([]); setSelectedId(''); setCandidate(asset.prompt || '')
    void api<{ comparisons: VideoComparison[] }>(`${base}?asset_id=${encodeURIComponent(asset.id)}`, { signal: abort.signal })
      .then(response => {
        setRecords(response.comparisons)
        const first = response.comparisons[0]
        if (first) { setSelectedId(first.id); setCandidate(first.candidate_prompt) }
      }).catch(issue => { if (!abort.signal.aborted) setError(issue instanceof Error ? issue.message : String(issue)) })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => { abort.abort(); controller.current?.abort() }
  }, [base, asset.id, asset.prompt])
  useEffect(() => {
    if (!selected || !['starting', 'queued', 'running'].includes(selected.status)) return
    const abort = new AbortController()
    const timer = window.setInterval(() => {
      void api<{ comparisons: VideoComparison[] }>(`${base}?asset_id=${encodeURIComponent(asset.id)}`, { signal: abort.signal })
        .then(response => setRecords(response.comparisons))
        .catch(issue => { if (!abort.signal.aborted) setError(issue instanceof Error ? issue.message : String(issue)) })
    }, 4000)
    return () => { window.clearInterval(timer); abort.abort() }
  }, [base, asset.id, selected?.id, selected?.status])
  async function prepare() {
    setPending(true); setError(''); controller.current = new AbortController()
    try {
      const record = await api<VideoComparison>(base, { ...json('POST', {
        baseline_asset_id: asset.id, candidate_prompt: candidate, label: '动作提示词对照',
      }), signal: controller.current.signal })
      remember(record)
    } catch (issue) { if (!controller.current?.signal.aborted) setError(issue instanceof Error ? issue.message : String(issue)) }
    finally { setPending(false) }
  }
  async function start() {
    if (!selected || selected.candidate_prompt !== candidate || selected.stale) return
    const id = selected.id
    setPending(true); setError(''); controller.current = new AbortController()
    try {
      const record = await api<VideoComparison>(`${base}/${encodeURIComponent(id)}/start`, { ...json('POST', {}), signal: controller.current.signal })
      setRecords(current => [record, ...current.filter(item => item.id !== record.id)])
    } catch (issue) { if (!controller.current?.signal.aborted) setError(issue instanceof Error ? issue.message : String(issue)) }
    finally { setPending(false) }
  }
  return <aside className="pc-video-comparison" aria-label="动作对照">
    <header><div><GitCompare size={18} /><h2>动作对照</h2></div><Button variant="subtle" color="gray" size="compact-xs" aria-label="收起动作对照" onClick={onClose}><X size={17} /></Button></header>
    <p>保留原片，以相同模型、参考图和参数生成一份修改提示词后的候选。</p>
    {!generated && <Alert color="yellow">请选择关联分镜的生成视频。上传视频缺少可冻结的生成条件。</Alert>}
    {loading && <div role="status"><Loader size="sm" />正在读取对照记录</div>}
    {records.length > 0 && <Select label="对照记录" value={selectedId || null} data={records.map(record => ({ value: record.id,
      label: `${new Date(record.created_at).toLocaleString()} · ${labels[record.status]}` }))} allowDeselect={false}
      disabled={pending} comboboxProps={{ zIndex: 350 }} onChange={value => {
        const record = records.find(item => item.id === value)
        if (record) { setSelectedId(record.id); setCandidate(record.candidate_prompt) }
      }} />}
    {selected && <section className="pc-video-comparison-conditions" aria-label="固定条件与剪辑目标">
      <strong>{selected.model_name}</strong>
      <dl><div><dt>生成请求时长</dt><dd>{seconds(selected.generation_duration_ms)}</dd></div>
        <div><dt>计划入片时长</dt><dd>{seconds(selected.edit_duration_ms)}</dd></div>
        <div><dt>参考图</dt><dd>{Array.isArray(selected.parameters.reference_asset_ids) ? selected.parameters.reference_asset_ids.length : 0} 张，顺序固定</dd></div>
        <div><dt>画幅 / 清晰度</dt><dd>{String(selected.parameters.ratio || '原配置')} / {String(selected.parameters.resolution || '原配置')}</dd></div></dl>
      {selected.generation_duration_ms > selected.edit_duration_ms && <p>生成后选择有效的 {seconds(selected.trim_target_ms)} 入片。此处不会自动裁剪或修改时间线。</p>}
      {selected.generation_duration_ms < selected.edit_duration_ms && <p>生成时长不足计划入片时长，需要检查剪辑安排。</p>}
      <small>{selected.seed_locked ? '沿用原任务随机种子。' : '原任务未固定随机种子，生成波动会影响对照。'}单组结果用于判断本镜头，不代表模型排名。</small>
    </section>}
    {selected?.stale && <Alert color="yellow" title="固定输入已变化">{selected.stale_reasons.join('；')}。请重新准备对照。</Alert>}
    <WorkspaceDisclosure label="原片提示词"><p className="pc-video-comparison-prompt">{selected?.baseline_prompt || asset.prompt || '没有保存提示词'}</p></WorkspaceDisclosure>
    <Textarea label="候选提示词" description="保留剧情、逐字对白、人物和画风，集中修改本次要验证的动作表达。" value={candidate}
      aria-label="动作对照候选提示词" onChange={event => setCandidate(event.currentTarget.value)} autosize minRows={7} maxRows={16}
      maxLength={80_000} disabled={pending || !generated} />
    <div className="pc-video-comparison-actions"><Button variant="default" loading={pending} disabled={!generated || loading || !candidate.trim()}
      onClick={() => void prepare()}>准备对照</Button>
      <Button leftSection={<Play size={15} />} disabled={pending || !selected || selected.stale || selected.status !== 'prepared' || candidate !== selected.candidate_prompt}
        onClick={() => void start()}>开始对照生成</Button></div>
    <small>准备对照只保存条件；开始生成会调用当前视频服务，产生一份新候选，原片和入片选择保留。</small>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {selected && ['starting', 'queued', 'running'].includes(selected.status) && <div role="status" className="pc-video-comparison-progress"><Loader size="sm" />{labels[selected.status]}</div>}
    {selected?.error && <Alert color="red" title="对照未完成">{selected.error}</Alert>}
    {selected?.candidate_url && <section aria-label="对照候选视频"><h3>候选视频</h3><StudioMediaPlayer kind="video" controls preload="metadata" src={selected.candidate_url} /><p>与左侧原片比较位移、动作完成、接触关系和表情变化。可分别进行成片复核。</p>
      {selected.candidate_asset && onReviewCandidate && <Button variant="default" mt="sm" onClick={() => onReviewCandidate(selected.candidate_asset!)}>复核对照候选</Button>}
    </section>}
  </aside>
}
