import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Select, Stack, Text } from '@mantine/core'
import { ScanEye, TriangleAlert } from 'lucide-react'
import type { VideoContinuityReview } from '@video-studio/shared/media/video-continuity-review'
import { api, json, type Model, type ProjectDetail, type Provider } from '../../shared/api/api'
import type { GenerationRequest } from './ProjectCanvas'
import { canvasContinuitySource, type CanvasContinuityResult } from './canvas-continuity-review'
import { orderModelsByDefault } from '../models/model-defaults'

type Props = { detail: ProjectDetail; request: GenerationRequest; models: Model[]; providers: Provider[];
  result?: CanvasContinuityResult; modifyAudio: boolean; onModifyAudio: (value: boolean) => void;
  onResult: (result: CanvasContinuityResult) => void; disabled?: boolean }

export default function CanvasVideoContinuityCheck({ detail, request, models, providers, result, modifyAudio,
  onModifyAudio, onResult, disabled = false }: Props) {
  const available = orderModelsByDefault(models.filter(item => item.modality === 'text' && item.enabled
    && providers.some(provider => provider.id === item.provider_id && provider.enabled && provider.adapter !== 'demo')))
  const [modelId, setModelId] = useState(available[0]?.id || '')
  const selected = available.find(item => item.id === modelId)
  const defaultModelId = available[0]?.id || ''
  useEffect(() => { if (!selected) setModelId(defaultModelId) }, [selected?.id, defaultModelId])
  const [includeFrames, setIncludeFrames] = useState(false), [running, setRunning] = useState(false), [error, setError] = useState('')
  const source = canvasContinuitySource(detail, request, modifyAudio)
  const signature = useRef(source.signature); signature.current = source.signature
  const controller = useRef<AbortController | null>(null)
  const stale = !!result && result.report.source_signature !== source.signature
  useEffect(() => { controller.current?.abort(); setRunning(false); setError('') }, [source.signature])
  useEffect(() => () => controller.current?.abort(), [])
  const previous = source.context.previous?.media
  const previousFrame = previous?.asset && previous.tail_time_ms !== null
    ? previous.asset.kind === 'image' ? `/api/assets/${encodeURIComponent(previous.asset.id)}/file`
      : `/api/assets/${encodeURIComponent(previous.asset.id)}/frame?time_ms=${previous.tail_time_ms}` : null

  async function check() {
    if (running || !selected || disabled) return
    const current = new AbortController(); controller.current = current
    const sourceSignature = source.signature
    setRunning(true); setError('')
    try {
      const report = await api<VideoContinuityReview>(`/projects/${detail.id}/canvas/video-continuity-review`, {
        ...json('POST', { model_id: selected.id, shot_id: request.shot_id || null, target_model_id: request.model_id,
          prompt: request.prompt, generation_duration: request.duration, source_signature: sourceSignature,
          mode: request.mode, generate_audio: request.generate_audio,
          storyboard_asset_id: source.storyboardId, include_frames: includeFrames && selected.settings.supports_vision === true,
          modify_audio: modifyAudio }), signal: current.signal,
      })
      if (!current.signal.aborted && signature.current === sourceSignature && report.source_signature === sourceSignature) onResult({ report, acknowledged: false })
    } catch (issue) { if (!current.signal.aborted) setError(issue instanceof Error ? issue.message : String(issue)) }
    finally { if (controller.current === current) { controller.current = null; setRunning(false) } }
  }

  return <Stack gap="xs" aria-label="生成前接镜核对">
    <Text fw={600} size="sm">生成前接镜核对</Text>
    <Text size="xs" c="dimmed">检查实际提交提示词的开场、持物、动作交接和声音计划；由你主动发起文本模型核对。</Text>
    {previousFrame && <div><Text size="xs">前镜实际出点 · {source.context.previous?.title}</Text>
      <img src={previousFrame} alt="前镜选用素材的实际出点帧" style={{ width: '100%', maxHeight: 150, objectFit: 'contain' }} /></div>}
    {source.context.previous && !previousFrame && <Text size="xs" c="dimmed">前镜尚无有效选用素材与取段，本次可先核对文字设计。</Text>}
    <Select label="核对模型" data={available.map(item => ({ value: item.id, label: item.name }))} value={selected?.id || null}
      onChange={value => setModelId(value || '')} disabled={disabled || running} searchable size="xs" />
    <Checkbox size="xs" label="同时核对前镜实际尾帧与本镜参考图" checked={includeFrames}
      disabled={disabled || running || selected?.settings.supports_vision !== true}
      onChange={event => setIncludeFrames(event.currentTarget.checked)} />
    <Checkbox size="xs" label="允许按新设计修改已确认台词" checked={modifyAudio} disabled={disabled || running}
      onChange={event => onModifyAudio(event.currentTarget.checked)} />
    <Button size="compact-xs" variant="light" leftSection={<ScanEye size={14} />} loading={running}
      disabled={disabled || !selected} onClick={() => void check()}>{result ? '重新核对当前版本' : '核对当前版本'}</Button>
    {running && <Button size="compact-xs" variant="subtle" onClick={() => { controller.current?.abort(); setRunning(false) }}>取消核对</Button>}
    {error && <Alert color="red" title="接镜核对未完成">{error}</Alert>}
    {result && <>
      {stale && <Alert color="yellow">提示词、分镜、素材或取段已变化，以下结果待复查。</Alert>}
      <Text size="xs">{result.report.summary}</Text>
      {result.report.findings.map((item, index) => <Alert key={index} color={item.severity === 'error' ? 'orange' : 'gray'} icon={<TriangleAlert size={13} />}>
        <Text size="xs">{item.observation}</Text>
        {item.quotes.map((quote, i) => <Text key={i} size="xs" c="dimmed">“{quote}”</Text>)}
        <Text size="xs">建议：{item.suggestion}</Text>
      </Alert>)}
      {result.report.uncertainties.map((item, index) => <Text key={index} size="xs" c="dimmed">{item}</Text>)}
      {!stale && result.report.findings.some(item => item.severity === 'error') && <Checkbox size="xs"
        label="已查看问题，保留当前设计继续生成" checked={result.acknowledged} disabled={disabled || running}
        onChange={event => onResult({ ...result, acknowledged: event.currentTarget.checked })} />}
    </>}
  </Stack>
}
