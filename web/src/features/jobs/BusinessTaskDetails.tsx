import { useEffect, useState } from 'react'
import { ActionIcon, Alert, Loader, Popover, Text } from '@mantine/core'
import { Info } from 'lucide-react'
import type { BusinessTaskRecord } from '@video-studio/shared/jobs/business-tasks'
import { api } from '../../shared/api/api'
import AiOperationRecords from './AiOperationRecords'
import ModelTaskProgress from './ModelTaskProgress'

/** Retain existing child ledgers; fetch only when their detail entry is opened. */
export default function BusinessTaskDetails({ task, embedded = false }: { task: BusinessTaskRecord; embedded?: boolean }) {
  const [opened, setOpened] = useState(false), [record, setRecord] = useState<BusinessTaskRecord>(), [error, setError] = useState('')
  const active = opened || embedded
  useEffect(() => {
    if (!active) return
    const controller = new AbortController(); setRecord(undefined); setError('')
    void api<BusinessTaskRecord>(`/projects/${task.project_id}/task-history/${encodeURIComponent(task.id)}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setRecord(value) }).catch(issue => { if (!controller.signal.aborted) setError(issue.message) })
    return () => controller.abort()
  }, [active, task.project_id, task.id])
  const content = <div className="task-business-details" aria-label="任务内部步骤">
    <Text fw={600} size="sm">{task.title}</Text>
    <Text size="sm" c="dimmed">{task.summary}</Text>
    {error && <Alert color="red">{error}</Alert>}
    {!record && !error && <Loader size="xs" aria-label="正在读取任务详情" />}
    {record?.details?.models.map(model => <Text key={model.id} size="sm">{model.label}：{model.requests} 次请求{model.uncertain_requests ? `，${model.uncertain_requests} 次待核对` : ''}</Text>)}
    {record && <><AiOperationRecords projectId={task.project_id} operationIds={record.operation_ids} />
      <ModelTaskProgress projectId={task.project_id} taskIds={record.model_task_ids} /></>}
  </div>
  if (embedded) return content
  return <Popover opened={opened} onChange={setOpened} position="bottom-end" withinPortal zIndex={220} width="min(560px, calc(100vw - 24px))" trapFocus returnFocus>
    <Popover.Target><ActionIcon variant="subtle" aria-label="查看任务步骤与诊断" title="任务详情" aria-expanded={opened} onClick={() => setOpened(value => !value)}><Info size={18} /></ActionIcon></Popover.Target>
    <Popover.Dropdown role="dialog" aria-label="业务任务详情">{opened && content}</Popover.Dropdown>
  </Popover>
}
