import { useEffect, useRef, useState } from 'react'
import { Accordion, Alert, Badge, Button, Group, Paper, Stack, Text, Textarea } from '@mantine/core'
import type { AiOperationRecord } from '@video-studio/shared/api/ai-operations'
import { api, json } from '../../shared/api/api'

const stateLabels = { running: '处理中', completed: '处理完成', failed: '处理失败', interrupted: '结果待核对' }
export function operationLabel(route: string): string {
  if (/refine-prompt/.test(route)) return '提示词整理与复查'
  if (/storyboard/.test(route)) return '分镜规划与复查'
  if (/speech/.test(route)) return '配音处理'
  if (/visual-profiles/.test(route)) return '视觉设定处理'
  if (/continuity/.test(route)) return '连续性核对'
  if (/script/.test(route)) return '剧本创作处理'
  if (/canvas|node-proposals/.test(route)) return '画布创作处理'
  if (/review/.test(route)) return '素材核对'
  return 'AI 创作处理'
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function shotCandidate(value: unknown, index: number): string {
  const draft = object(value)
  return draft ? [`第 ${index + 1} 镜 · ${draft.title || ''}`, draft.prompt, draft.image_prompt, draft.video_prompt,
    draft.start_state, draft.end_state, draft.cut_note].filter(part => typeof part === 'string' && part).join('\n') : ''
}
/** Render creative content, without exposing request payloads or provider internals. */
export function operationCandidate(value: unknown): string {
  const row = object(value)
  if (!row) return typeof value === 'string' ? value : ''
  for (const key of ['prompt_body', 'prompt', 'content', 'text', 'answer']) if (typeof row[key] === 'string' && row[key]) return row[key]
  if (Array.isArray(row.scenes)) return row.scenes.map(scene => {
    const item = object(scene)
    if (!item) return ''
    const heading = typeof item.scene_heading === 'string' ? item.scene_heading : '场次'
    return [heading, ...(Array.isArray(item.shots) ? item.shots.map(shotCandidate) : [])].join('\n\n')
  }).filter(Boolean).join('\n\n')
  if (Array.isArray(row.shots)) return row.shots.map(shotCandidate).filter(Boolean).join('\n\n')
  return ''
}
function qualityLabel(value: unknown): string {
  const row = object(value), quality = object(row?.quality) || object(row?.directing_review)
  const status = quality?.status
  return status === 'passed' ? '当前候选已通过复查' : status === 'warnings' ? '当前候选存在提示，请回原功能确认'
    : status === 'needs_work' ? '完整候选已保留，仍需修改并复查' : status === 'inconclusive' ? '完整候选已保留，复查尚无结论'
      : status === 'edited' || status === 'pending_review' ? '完整候选已保留，等待当前版本复查' : ''
}
export default function AiOperationRecords({ projectId, refreshKey = 0 }: { projectId: string; refreshKey?: number }) {
  const [records, setRecords] = useState<AiOperationRecord[]>([]), [error, setError] = useState('')
  const [notice, setNotice] = useState(''), [stopping, setStopping] = useState<string>()
  const [expanded, setExpanded] = useState<string[]>([])
  const project = useRef(projectId); project.current = projectId
  useEffect(() => {
    let disposed = false, pending: AbortController | undefined
    setRecords([]); setError(''); setNotice(''); setStopping(undefined)
    async function refresh() {
      if (pending) return
      const controller = new AbortController(); pending = controller
      try {
        const rows = await api<AiOperationRecord[]>(`/projects/${projectId}/ai-operations`, { signal: controller.signal })
        if (!Array.isArray(rows)) throw new Error('创作处理记录暂不可用')
        if (!disposed) { setRecords(rows); setError('') }
      } catch (issue) { if (!disposed && !controller.signal.aborted) setError(issue instanceof Error ? issue.message : '读取创作处理记录失败') }
      finally { if (pending === controller) pending = undefined }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 5000)
    return () => { disposed = true; clearInterval(timer); pending?.abort() }
  }, [projectId, refreshKey])
  async function stop(id: string) {
    const capturedProject = projectId
    setStopping(id); setError('')
    try {
      const response = await api<{ detail: string }>(`/ai-operations/${id}/stop`, json('POST', {}))
      if (project.current === capturedProject) setNotice(response.detail)
    } catch (issue) { if (project.current === capturedProject) setError(issue instanceof Error ? issue.message : '停止本地处理失败') }
    finally { if (project.current === capturedProject) setStopping(undefined) }
  }
  if (!records.length) return error ? <Text size="xs" c="dimmed">创作处理记录暂不可用：{error}</Text> : null
  return <Paper withBorder p="md" mb="lg" aria-label="AI 创作处理记录"><Stack gap="sm">
    <div><Text fw={600}>AI 创作处理记录</Text><Text size="xs" c="dimmed">请求中断后可核对原结果，回到原功能继续编辑与应用。本地停止后的远端任务与计费以提供商记录为准。</Text></div>
    {error && <Alert color="red">{error}</Alert>}{notice && <Alert color="blue">{notice}</Alert>}
    <Accordion multiple value={expanded} onChange={setExpanded}>{records.map(record => {
      const retained = record.result ?? record.candidate
      const candidate = operationCandidate(retained), quality = qualityLabel(retained)
      return <Accordion.Item key={record.id} value={record.id}>
        <Accordion.Control><Group justify="space-between"><Text size="sm">{operationLabel(record.route)} · {new Date(record.created_at).toLocaleString('zh-CN')}</Text><Badge color={record.state === 'completed' ? 'teal' : record.state === 'running' ? 'blue' : 'orange'}>{stateLabels[record.state]}</Badge></Group></Accordion.Control>
        <Accordion.Panel><Stack gap="xs">
          {quality && <Text size="sm">{quality}</Text>}
          {record.error && <Text size="sm" c="orange">{record.error.message}</Text>}
          {record.state === 'interrupted' && <Text size="sm">{candidate ? '完整草稿已保留，请回到原功能编辑与复查后应用。' : '原请求结果尚未确认，请在原功能继续查询并核对已有成果。'}</Text>}
          {candidate && <Textarea label="已保留的创作内容" value={candidate} readOnly autosize minRows={3} maxRows={12} />}
          {!candidate && record.state === 'completed' && <Text size="sm">本次处理已完成，可返回原功能查看结果。</Text>}
          {record.state === 'running' && <Button variant="default" size="xs" loading={stopping === record.id} disabled={!!stopping} onClick={() => void stop(record.id)}>停止本地处理</Button>}
        </Stack></Accordion.Panel>
      </Accordion.Item>
    })}</Accordion>
  </Stack></Paper>
}
