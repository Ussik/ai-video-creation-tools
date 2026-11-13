import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Group, Modal, Select, Stack, Text, Textarea } from '@mantine/core'
import { Sparkles } from 'lucide-react'
import { jobPromptRequest, type PromptOptimizationResult } from '@video-studio/shared/jobs/prompt-optimization'
import type { Job, Model, Provider } from '../../shared/api/api'
import { api, json } from '../../shared/api/api'
import { useSharedModelSelection } from '../models/useSharedModelSelection'
import './prompt-optimization.css'

type Props = {
  job: Job; models: Model[]; providers: Provider[]; prompt?: string; sourceKey?: string;
  disabled?: boolean; newDraft?: boolean; maxLength?: number; onClose: () => void;
  onApply: (prompt: string) => void | Promise<void>;
}
const maxAdjustmentLength = 4_000

export default function PromptOptimizationModal(props: Props) {
  const available = props.models.filter(model => model.modality === 'text' && model.enabled &&
    props.providers.some(provider => provider.id === model.provider_id && provider.enabled && provider.adapter !== 'demo'))
  const original = String(jobPromptRequest(props.job.request).prompt || '')
  const source = props.prompt ?? original
  const [result, setResult] = useState(''), [changes, setChanges] = useState<string[]>([])
  const [adjustment, setAdjustment] = useState(''), [resultAdjustment, setResultAdjustment] = useState('')
  const [pending, setPending] = useState(false), [applying, setApplying] = useState(false), [error, setError] = useState('')
  const { modelId, selectModel } = useSharedModelSelection('text', available, { locked: pending || applying })
  const [elapsed, setElapsed] = useState(0), [resultKey, setResultKey] = useState('')
  const [resultSourceKey, setResultSourceKey] = useState('')
  const serial = useRef(0), abort = useRef<AbortController | null>(null), locked = useRef(false)
  const sourceKey = JSON.stringify([props.job.project_id, props.job.id, props.job.request, props.job.error, source, props.sourceKey])
  const currentKey = JSON.stringify([sourceKey, modelId])
  const maxLength = props.maxLength || 80_000
  useEffect(() => () => { serial.current++; abort.current?.abort() }, [])
  useEffect(() => {
    if (!pending) return
    const start = Date.now(), timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [pending])
  const modelAvailable = available.some(model => model.id === modelId)
  const sourceChanged = !!resultKey && resultSourceKey !== sourceKey
  const stale = !!resultKey && resultKey !== currentKey
  const adjustmentChanged = !!resultKey && adjustment.trim() !== resultAdjustment
  const continueFromResult = !!result.trim() && !sourceChanged
  const optimizationPrompt = continueFromResult ? result.trim() : source.trim()
  const optimizeLabel = resultKey ? sourceChanged ? '重新优化' : '继续调整' : '生成优化建议'
  async function optimize() {
    if (locked.current || !modelAvailable || props.disabled || !optimizationPrompt || optimizationPrompt.length > 80_000 || adjustment.length > maxAdjustmentLength) return
    locked.current = true
    const turn = ++serial.current, captured = currentKey, capturedSource = sourceKey, capturedAdjustment = adjustment.trim()
    abort.current = new AbortController(); setPending(true); setElapsed(0); setError('')
    try {
      const response = await api<PromptOptimizationResult>(`/projects/${props.job.project_id}/jobs/${props.job.id}/optimize-prompt`, {
        ...json('POST', { model_id: modelId, prompt: optimizationPrompt, adjustment_request: capturedAdjustment }), signal: abort.current.signal,
      })
      if (turn === serial.current) {
        setResult(response.prompt); setChanges(response.changes); setResultKey(captured)
        setResultSourceKey(capturedSource); setResultAdjustment(capturedAdjustment)
      }
    } catch (issue) { if (turn === serial.current) setError(issue instanceof Error ? issue.message : '优化失败，请重试') }
    finally { if (turn === serial.current) { locked.current = false; setPending(false) } }
  }
  async function apply() {
    if (locked.current || stale || adjustmentChanged || props.disabled || !resultKey || !result.trim() || result.length > maxLength) return
    locked.current = true; setApplying(true); setError('')
    try { await props.onApply(result.trim()); props.onClose() }
    catch (issue) { setError(issue instanceof Error ? issue.message : '应用失败，请重试') }
    finally { locked.current = false; setApplying(false) }
  }
  function close() { if (applying) return; serial.current++; abort.current?.abort(); props.onClose() }
  return <Modal opened onClose={close} title="优化提示词" centered size="xl" zIndex={260}
    closeOnEscape={!applying} closeOnClickOutside={!applying} closeButtonProps={{ 'aria-label': '关闭优化提示词', disabled: applying }}
    classNames={{ content: 'prompt-optimization-modal', header: 'prompt-optimization-header', body: 'prompt-optimization-body' }}>
    <Stack gap="md" className="prompt-optimization-content">
      <Alert color="orange" title="内容审核拒绝">{props.job.error}</Alert>
      <Text size="sm" c="dimmed">调整不合适的描述，保留合理的画面信息。改写后仍需由图片服务审核，参考图也可能影响审核结果。</Text>
      <Select label="用于优化的文本模型" aria-label="优化提示词的文本模型" placeholder="请选择文本模型"
        data={available.map(model => ({ value: model.id, label: model.name }))} value={modelId || null}
        onChange={value => selectModel(value || '')} searchable allowDeselect={false} disabled={pending || applying}
        comboboxProps={{ zIndex: 320 }} />
      {!available.length && <Alert color="orange">请先在模型设置中启用一个文本模型及其提供商。</Alert>}
      <section className="prompt-optimization-adjustment" aria-label="提示词调整方向">
        <Textarea label="本次调整要求" aria-label="本次调整要求" value={adjustment}
          onChange={event => setAdjustment(event.currentTarget.value)} disabled={pending || applying}
          autosize minRows={3} maxRows={5} maxLength={maxAdjustmentLength}
          placeholder="例如：保留主体、画风和参考图编号，将不合适的细节改为克制的画面表达。"
          description="填写希望保留或修改的内容，优化时会结合审核拒绝信息一起处理。" />
        <Group justify="space-between" gap="xs" className="prompt-optimization-adjustment-hint">
          <Text size="xs" c="dimmed">{continueFromResult ? '继续调整将以当前编辑结果为基础。' : '未填写时，按现有规则优化。'}</Text>
          <Text size="xs" c="dimmed">{adjustment.length.toLocaleString()} / 4,000</Text>
        </Group>
      </section>
      <div className="prompt-optimization-comparison">
        <Textarea label={source === original ? '原始提示词' : '当前提示词草稿'} aria-label="优化前的提示词" value={source} readOnly rows={12} />
        <Textarea label="优化建议 · 可编辑" aria-label="优化后的提示词" placeholder="点击生成优化建议，在这里对比和编辑" value={result}
          onChange={event => setResult(event.currentTarget.value)} rows={12} maxLength={maxLength} disabled={!resultKey || pending || applying} />
      </div>
      {source !== original && <Text size="xs" c="dimmed">你已编辑过提示词，本次优化以当前草稿为准。历史任务中的原文仍保留。</Text>}
      {changes.length > 0 && <div><Text size="sm" fw={600}>改动说明</Text><ul className="prompt-optimization-changes">{changes.map((change, i) => <li key={i}>{change}</li>)}</ul></div>}
      {sourceChanged && <Alert color="orange">提示词或生成配置已变化，请重新生成优化建议。</Alert>}
      {stale && !sourceChanged && <Alert color="orange">文本模型已变化，请点击「继续调整」后应用，当前结果将保留为调整基稿。</Alert>}
      {adjustmentChanged && !stale && <Alert color="orange">调整要求已变化，请点击「继续调整」生成新结果后应用。</Alert>}
      {error && <Alert color="red" role="alert">{error}</Alert>}
      <Text size="xs" c="dimmed">{props.newDraft ? '应用后会在画布创建新草稿，保留原任务的参数和参考图。' : '应用后更新当前节点的提示词。'}重新生成需要你手动发起。</Text>
    </Stack>
      <Group justify="space-between" className="prompt-optimization-footer">
        <Text size="xs" c="dimmed" role="status">{pending ? `正在优化 · ${elapsed} 秒` : '生成建议会调用所选文本模型'}</Text>
        <Group gap="xs"><Button variant="default" onClick={close} disabled={applying}>取消</Button>
          <Button variant="light" leftSection={<Sparkles size={15} />} loading={pending} disabled={applying || props.disabled || !modelAvailable || !optimizationPrompt || optimizationPrompt.length > 80_000 || adjustment.length > maxAdjustmentLength}
            onClick={() => void optimize()}>{optimizeLabel}</Button>
          <Button loading={applying} disabled={pending || props.disabled || stale || adjustmentChanged || !resultKey || !result.trim() || result.length > maxLength} onClick={() => void apply()}>应用到画布</Button></Group>
      </Group>
  </Modal>
}
