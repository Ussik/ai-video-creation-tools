import { useEffect, useState } from 'react'
import { Accordion, Alert, Badge, Button, Group, Paper, Progress, Stack, Table, Text } from '@mantine/core'
import { api, json, type ModelRequestTask } from '../../shared/api/api'
const states = { running: '处理中', succeeded: '已完成', failed: '未完成', cancelled: '已停止', interrupted: '已中断' }
const purposes: Record<string, string> = { generation: '创作生成', review: '审读核对', classification: '意图判断', prompt: '提示词整理', tool_decision: '工具决策', text: '文本处理', media_generation: '素材生成', image_analysis: '图片分析' }
const reasons: Record<string,string> = { output_limit:'单次输出达到额度', context_overflow:'输入超过模型容量', disconnected:'连接中断', refusal:'提供商拒绝返回', invalid_tool:'工具参数不完整', invalid_response:'返回格式异常', upstream_error:'提供商请求失败', cancelled:'本地停止' }
const quantity = (value: unknown) => typeof value === 'number' ? value.toLocaleString('zh-CN') : '未知'
/** Business-specific resume/apply stays on its original screen. This ledger
 * shows only real dispatches and distinguishes actual from unsettled usage. */
export default function ModelTaskProgress({ projectId }: { projectId: string }) {
  const [tasks, setTasks] = useState<ModelRequestTask[]>([]), [error,setError] = useState('')
  useEffect(() => {
    let disposed = false, pending: AbortController | undefined
    const refresh = async () => {
      if (pending) return
      const controller = new AbortController(); pending = controller
      try { const rows = await api<ModelRequestTask[]>(`/projects/${projectId}/model-requests`, { signal: controller.signal }); if (!Array.isArray(rows)) throw new Error('模型记录暂不可用'); if (!disposed) { setTasks(rows); setError('') } }
      catch (issue) { if (!disposed && !controller.signal.aborted) setError(issue instanceof Error ? issue.message : '读取模型任务失败') }
      finally { if (pending === controller) pending = undefined }
    }
    void refresh(); const timer = setInterval(() => { void refresh() }, 5000)
    return () => { disposed = true; clearInterval(timer); pending?.abort() }
  },[projectId])
  async function stop(id: string) {
    try { await api(`/projects/${projectId}/model-requests/${id}/stop`,json('POST',{})); setTasks(await api<ModelRequestTask[]>(`/projects/${projectId}/model-requests`)) }
    catch (issue) { setError(issue instanceof Error ? issue.message : '停止失败') }
  }
  if (!tasks.length) return error ? <Text size="xs" c="dimmed">模型记录暂不可用：{error}</Text> : null
  return <Paper withBorder p="md" mb="lg" aria-label="模型处理记录"><Stack gap="sm">
    <div><Text fw={600}>模型处理记录</Text><Text size="xs" c="dimmed">查看实际请求与用量。未完成任务可回到原功能继续；本地停止后，远端计费以提供商记录为准。</Text></div>
    {error && <Alert color="red">{error}</Alert>}
    <Accordion variant="separated">{tasks.map(task => <Accordion.Item key={task.id} value={task.id}>
      <Accordion.Control><Group justify="space-between"><Text size="sm">{task.label} · {new Date(task.created_at).toLocaleString('zh-CN')}</Text>
        <Badge color={task.state === 'succeeded' ? 'teal' : task.state === 'running' ? 'blue' : 'orange'}>{states[task.state]}</Badge></Group></Accordion.Control>
      <Accordion.Panel><Stack gap="xs">
        {task.progress?.map(progress => <div key={progress.phase_id}>
          <Text size="sm">{progress.label}：已保留 {progress.completed_units} 个完整单元{progress.total_units === null ? '；剩余范围待核对' : `，剩余 ${progress.total_units - progress.completed_units} 个`}。</Text>
          {progress.total_units !== null && progress.total_units > 0 && <Progress value={100 * progress.completed_units / progress.total_units} aria-label={`${progress.label}完成进度`} />}
        </div>)}
        <Text size="sm">已派发 {task.usage.requests} 次；实际输入 {quantity(task.usage.input_tokens)} / 输出 {quantity(task.usage.output_tokens)} tokens。</Text>
        {task.usage.uncertain_requests > 0 && <Text size="xs" c="orange">{task.usage.uncertain_requests} 次用量待核对，输入估算 {quantity(task.usage.estimated_input_tokens)} / 输出预留 {quantity(task.usage.estimated_output_tokens)}，不计作实际零用量。</Text>}
        {task.usage.cache_read_reported_requests > 0 && <Text size="xs" c="dimmed">提供商报告缓存读取 {quantity(task.usage.cache_read_tokens)} tokens。</Text>}
        {task.state === 'running' && task.can_cancel && task.owner !== 'director' && <Button variant="default" size="xs" onClick={() => void stop(task.id)}>停止本地处理</Button>}
        <Table.ScrollContainer minWidth={600}><Table><Table.Thead><Table.Tr><Table.Th>请求</Table.Th><Table.Th>用途</Table.Th><Table.Th>输出额度</Table.Th><Table.Th>结束情况</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>{task.attempts.map(attempt => <Table.Tr key={attempt.id}>
            <Table.Td><Text size="xs" title={attempt.id}>{attempt.id.slice(0,16)}</Text></Table.Td>
            <Table.Td>{purposes[String(attempt.metrics.request_purpose)] || '其他处理'}</Table.Td>
            <Table.Td>{quantity(attempt.metrics.output_limit)}</Table.Td>
            <Table.Td>{reasons[String(attempt.metrics.failure_reason)] || (attempt.metrics.delivery === 'completed' ? '完整接收' : attempt.state === 'dispatched' ? '已派发，结果待核对' : '已接收')}<Text size="xs" c="dimmed">{String(attempt.metrics.raw_reason || '')}</Text></Table.Td>
          </Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>
      </Stack></Accordion.Panel>
    </Accordion.Item>)}</Accordion>
  </Stack></Paper>
}
