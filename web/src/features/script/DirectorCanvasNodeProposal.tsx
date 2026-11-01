import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Group, Modal, Stack, Table, Text, Textarea } from '@mantine/core'
import { canvasNodeProposalSourceKey, type CanvasNodeProposal, type CanvasNodeProposalSource } from '@video-studio/shared/canvas/canvas-node-proposal'
import { api, json } from '../../shared/api/api'

export type CanvasNodeProposalApplyResult = { nodeId: string; referenceNodeCount: number; alreadyApplied: boolean }
export type DirectorCanvasNodeProposalProps = {
  source: CanvasNodeProposalSource
  modelId: string
  modelName?: string
  composerInput: string
  initialContext?: string
  disabled?: boolean
  hidden?: boolean
  onApply: (proposal: CanvasNodeProposal) => Promise<CanvasNodeProposalApplyResult>
}

const parameterLabels = { ratio: '画面比例', resolution: '分辨率', duration: '时长（秒）', generate_audio: '生成声音' } as const
const valueLabel = (value: unknown) => value === true ? '开启' : value === false ? '关闭' : value === null || value === undefined ? '默认' : String(value)

export default function DirectorCanvasNodeProposal({ source, modelId, modelName, composerInput, initialContext, disabled, hidden, onApply }: DirectorCanvasNodeProposalProps) {
  const sourceKey = canvasNodeProposalSourceKey(source)
  const scopeKey = `${sourceKey}:${modelId}`
  const scope = useRef(scopeKey)
  scope.current = scopeKey
  const sourceScope = useRef(sourceKey)
  sourceScope.current = sourceKey
  const request = useRef<AbortController | null>(null)
  const requestEpoch = useRef(0)
  const generatingLock = useRef(false)
  const applyingLock = useRef(false)
  const [opened, setOpened] = useState(false)
  const [instructions, setInstructions] = useState('')
  const [proposal, setProposal] = useState<CanvasNodeProposal | null>(null)
  const [result, setResult] = useState<CanvasNodeProposalApplyResult | null>(null)
  const [generating, setGenerating] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const initializedInstructions = useRef(false)

  useEffect(() => {
    ++requestEpoch.current
    request.current?.abort()
    request.current = null
    generatingLock.current = false
    applyingLock.current = false
    initializedInstructions.current = false
    setGenerating(false); setApplying(false); setOpened(false)
    setInstructions(''); setProposal(null); setResult(null); setError(null)
    return () => { ++requestEpoch.current; request.current?.abort() }
  }, [sourceKey])
  useEffect(() => {
    if (!generatingLock.current) return
    ++requestEpoch.current
    request.current?.abort()
    request.current = null
    generatingLock.current = false
    setGenerating(false)
  }, [modelId])
  useEffect(() => { if (hidden) close() }, [hidden])

  function open() {
    if (!initializedInstructions.current) {
      // Remove only the exact context inserted by this handoff. Edited user
      // prose is never parsed as a source or silently truncated.
      setInstructions((initialContext ? composerInput.replace(initialContext, '') : composerInput).trim())
      initializedInstructions.current = true
    }
    setOpened(true)
  }

  function close() {
    if (applyingLock.current) return
    ++requestEpoch.current
    request.current?.abort()
    request.current = null
    generatingLock.current = false
    setGenerating(false); setOpened(false)
  }

  async function generate() {
    if (disabled || !modelId || generatingLock.current || applyingLock.current || result || !instructions.trim() || instructions.length > 4000) return
    generatingLock.current = true
    const epoch = ++requestEpoch.current, capturedScope = scopeKey
    const controller = new AbortController()
    request.current = controller
    setGenerating(true); setProposal(null); setError(null)
    const current = () => requestEpoch.current === epoch && scope.current === capturedScope && !controller.signal.aborted
    try {
      const next = await api<CanvasNodeProposal>(`/projects/${encodeURIComponent(source.project_id)}/canvases/${encodeURIComponent(source.canvas_id)}/node-proposals`, {
        ...json('POST', { text_model_id: modelId, instructions: instructions.trim(), source }), signal: controller.signal,
      })
      if (!current()) return
      if (canvasNodeProposalSourceKey(next.source) !== sourceKey) throw new Error('返回的方案来源与当前节点不一致，请重新读取节点')
      setProposal(next)
    } catch (issue) {
      if (current()) setError(issue instanceof Error ? issue.message : String(issue))
    } finally {
      if (current()) { generatingLock.current = false; request.current = null; setGenerating(false) }
    }
  }

  async function apply() {
    if (!proposal || disabled || generatingLock.current || applyingLock.current || result) return
    applyingLock.current = true
    const epoch = requestEpoch.current, capturedSource = sourceKey
    setApplying(true); setError(null)
    try {
      const applied = await onApply(proposal)
      if (requestEpoch.current === epoch && sourceScope.current === capturedSource) setResult(applied)
    } catch (issue) {
      if (requestEpoch.current === epoch && sourceScope.current === capturedSource) setError(issue instanceof Error ? issue.message : String(issue))
    } finally {
      if (requestEpoch.current === epoch && sourceScope.current === capturedSource) { applyingLock.current = false; setApplying(false) }
    }
  }

  const changedParameters = proposal ? (Object.keys(parameterLabels) as Array<keyof typeof parameterLabels>)
    .filter(key => proposal.before.parameters[key] !== proposal.after.parameters[key]) : []
  return <>
    <Group justify="space-between" gap="xs" aria-label="画布节点修改方案">
      <Text size="xs" c="dimmed">已载入{source.modality === 'video' ? '视频' : '图片'}节点配置</Text>
      <Button size="compact-xs" variant="light" onClick={open} disabled={disabled}>调整节点配置</Button>
    </Group>
    <Modal opened={opened && !hidden} onClose={close} title="节点修改方案" size="xl" centered
      closeOnClickOutside={!applying} closeOnEscape={!applying} withCloseButton={!applying}>
      <Stack gap="md">
        <Text size="sm">先由文本模型提出方案，查看完整差异后再确认创建草稿。</Text>
        <Textarea label="希望如何调整这个节点" placeholder="例如：保留角色参考，把动作压缩到 5 秒，镜头改为跟拍。"
          value={instructions} onChange={event => { setInstructions(event.currentTarget.value); setProposal(null); setError(null) }}
          minRows={3} maxRows={8} autosize maxLength={4000} disabled={generating || applying || !!result} />
        {instructions.length > 4000 && <Alert color="orange">调整要求超过 4000 字符，请在这里精简；导演原草稿仍然保留。</Alert>}
        <Group justify="space-between">
          <Text size="xs" c="dimmed">{modelId ? `使用文本模型：${modelName || '当前所选模型'}` : '请先在导演输入区选择文本模型'}</Text>
          <Button onClick={() => void generate()} loading={generating}
            disabled={disabled || !modelId || !instructions.trim() || instructions.length > 4000 || applying || !!result}>生成修改方案</Button>
        </Group>
        {error && <Alert color="red" title="方案尚未应用" role="alert">{error}</Alert>}
        {proposal && <Stack gap="sm" aria-label="节点修改差异">
          {proposal.changes.length > 0 && <Text size="sm">修改说明：{proposal.changes.join('；')}</Text>}
          <Textarea label="原提示词" value={proposal.before.prompt} readOnly minRows={4} maxRows={12} autosize />
          <Textarea label="修改后提示词" value={proposal.after.prompt} readOnly minRows={4} maxRows={12} autosize />
          {changedParameters.length > 0 && <Table captionSide="top">
            <Table.Caption>参数差异</Table.Caption>
            <Table.Thead><Table.Tr><Table.Th>参数</Table.Th><Table.Th>原值</Table.Th><Table.Th>修改后</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>{changedParameters.map(key => <Table.Tr key={key}>
              <Table.Td>{parameterLabels[key]}</Table.Td><Table.Td>{valueLabel(proposal.before.parameters[key])}</Table.Td><Table.Td>{valueLabel(proposal.after.parameters[key])}</Table.Td>
            </Table.Tr>)}</Table.Tbody>
          </Table>}
          <Text size="sm">确认后新建 1 个生成草稿及必要的固定参考图片节点，保留原节点；生成由你手动启动。</Text>
          <Text size="xs" c="dimmed">方案保留在本次导演窗口中，确认后保存到来源画布。来源配置变化时，需要重新读取节点。</Text>
          {result ? <Alert color="green" title="草稿已创建" role="status">
            已创建独立生成草稿{result.referenceNodeCount ? `和 ${result.referenceNodeCount} 个参考图片节点` : ''}。可回到画布检查，使用画布撤销可撤回本次新增。
          </Alert> : <Button onClick={() => void apply()} loading={applying} disabled={disabled || generating}>确认创建草稿</Button>}
        </Stack>}
        <Group justify="flex-end"><Button variant="default" onClick={close} disabled={applying}>关闭</Button></Group>
      </Stack>
    </Modal>
  </>
}
