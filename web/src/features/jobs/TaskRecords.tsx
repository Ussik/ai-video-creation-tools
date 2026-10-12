import { useMemo, useRef, useState } from 'react'
import { Alert, Badge, Button, Select, Table, Tabs, TextInput } from '@mantine/core'
import { ArrowRight, Clapperboard, Clock3, Download, Eye, FileText, Film, Image as ImageIcon, LoaderCircle, Mic2, RefreshCcw, Search, Sparkles } from 'lucide-react'
import type { Asset, Job, Model, ProjectDetail, Provider } from '../../shared/api/api'
import JobInformationPopover from './JobInformationPopover'
import JobQueueControls from './JobQueueControls'
import { filterTaskRecords, isTaskActive, projectTaskRecords, taskKindLabels, type TaskKind, type TaskStatusFilter } from './task-records'
import './task-records.css'

type Props = {
  detail: ProjectDetail
  models: Model[]
  providers: Provider[]
  busy: boolean
  onRefresh: () => Promise<unknown>
  onPreview: (asset: Asset) => void
  onOpenCanvas: (shotId?: string) => void
  onOpenSpeech: () => void
  onRetry: (job: Job) => void
}
const statuses: Array<{ value: TaskStatusFilter; label: string }> = [
  { value: 'all', label: '全部' }, { value: 'active', label: '进行中' }, { value: 'failed', label: '失败' }, { value: 'succeeded', label: '已完成' },
]
const kindIcons = { image: ImageIcon, video: Film, speech: Mic2, export: Clapperboard, text: FileText, unknown: Sparkles }

export default function TaskRecords({ detail, models, providers, busy, onRefresh, onPreview, onOpenCanvas, onOpenSpeech, onRetry }: Props) {
  const [status, setStatus] = useState<TaskStatusFilter>('all')
  const [kind, setKind] = useState<'all' | TaskKind>('all')
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const refreshPending = useRef(false)
  const records = useMemo(() => projectTaskRecords(detail, models, providers), [detail, models, providers])
  const visible = useMemo(() => filterTaskRecords(records, status, kind, query), [records, status, kind, query])
  const activeCount = records.filter(record => isTaskActive(record.job)).length
  const counts = { all: records.length, active: activeCount,
    failed: records.filter(record => record.job.status === 'failed').length,
    succeeded: records.filter(record => record.job.status === 'succeeded').length }

  async function refresh() {
    if (refreshPending.current) return
    refreshPending.current = true
    setRefreshing(true)
    setRefreshError(null)
    try { await onRefresh() }
    catch (error) { setRefreshError(error instanceof Error ? error.message : '刷新失败，请稍后重试') }
    finally { refreshPending.current = false; setRefreshing(false) }
  }

  function clearFilters() { setStatus('all'); setKind('all'); setQuery('') }

  return <section className="page-section task-records" aria-label="任务记录">
    <div className="page-header task-records-header">
      <div><h1>任务记录</h1><p>查看当前项目的生成、配音和导出任务。</p></div>
      <div className="task-records-refresh">
        {activeCount > 0 && <span className="task-records-live"><span aria-hidden="true" />{activeCount} 个任务进行中 · 自动更新</span>}
        <JobQueueControls />
        <Button variant="default" onClick={() => void refresh()} loading={refreshing} leftSection={<RefreshCcw size={16} />}>刷新</Button>
      </div>
    </div>
    {refreshError && <Alert color="red" className="task-records-refresh-error" title="任务刷新失败" role="alert">{refreshError}</Alert>}
    {records.length > 0 ? <>
      <div className="task-records-toolbar">
        <Tabs value={status} onChange={value => { if (value) setStatus(value as TaskStatusFilter) }} variant="pills" radius="xl" className="task-records-tabs">
          <Tabs.List aria-label="任务状态筛选">{statuses.map(item => <Tabs.Tab key={item.value} value={item.value}>{item.label}<span>{counts[item.value]}</span></Tabs.Tab>)}</Tabs.List>
        </Tabs>
        <div className="task-records-filters">
          <TextInput aria-label="搜索任务" placeholder="搜索模型、镜头或任务 ID" value={query} onChange={event => setQuery(event.currentTarget.value)} leftSection={<Search size={15} />} />
          <Select aria-label="任务类型" value={kind} onChange={value => { if (value) setKind(value as typeof kind) }} allowDeselect={false}
            data={[{ value: 'all', label: '全部类型' }, ...(['image', 'video', 'speech', 'export', 'text'] as const).map(value => ({ value, label: taskKindLabels[value] })),
              ...(records.some(record => record.kind === 'unknown') ? [{ value: 'unknown', label: '其他生成' }] : [])]} />
        </div>
      </div>
      {visible.length > 0 ? <Table className="job-table task-records-table" aria-label="任务列表">
        <Table.Thead><Table.Tr className="job-row job-header"><Table.Th>任务</Table.Th><Table.Th>状态</Table.Th><Table.Th className="job-date">提交时间</Table.Th><Table.Th>结果与操作</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{visible.map(record => {
          const { job, result, model, provider, shot, kind: taskKind, needsBillingCheck } = record
          const Icon = kindIcons[taskKind]
          const statusLabel = job.status === 'queued' ? '排队中' : job.status === 'failed' ? '失败' : job.status === 'succeeded' ? '已完成'
            : taskKind === 'export' ? '导出中' : taskKind === 'speech' ? '合成中' : '生成中'
          return <Table.Tr className="job-row" key={job.id}>
            <Table.Td><div className="job-name"><div className="job-icon"><Icon size={18} /></div><div>
              <strong>{record.label}<span>{taskKind === 'speech' ? '豆包 TTS 2.0' : model?.name}</span></strong>
              <small title={record.context}>{record.context}{provider && ` · ${provider.name}`}</small>
              {job.error && <small className="task-records-error" title={job.error}>{job.error}</small>}
              {needsBillingCheck && <small className="task-records-guidance">{taskKind === 'image' ? '请先核对提供商账单，再回到画布重新生成。' : '原模型不可用，请先核对提供商记录。'}</small>}
            </div></div></Table.Td>
            <Table.Td><Badge className={`job-status status-${job.status}`} variant="light" color={job.status === 'failed' ? 'red' : job.status === 'succeeded' ? 'teal' : 'gray'}
              leftSection={job.status === 'running' ? <LoaderCircle className="spin" size={12} /> : undefined}>{statusLabel}</Badge></Table.Td>
            <Table.Td className="job-date"><time dateTime={job.created_at} title={new Date(job.created_at).toLocaleString('zh-CN')}>
              {new Date(job.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
            </time></Table.Td>
            <Table.Td><div className="job-result">
              <JobInformationPopover job={job} model={model} provider={provider} shot={shot} projectName={detail.name} assets={detail.assets} />
              {result ? <>
                <Button variant="default" size="xs" leftSection={<Eye size={14} />} onClick={() => onPreview(result)}>查看结果</Button>
                {taskKind === 'export' && <Button component="a" variant="subtle" size="xs" href={result.url} download leftSection={<Download size={14} />}>下载成片</Button>}
              </> : job.status === 'failed' ? taskKind === 'speech'
                ? <Button variant="default" size="xs" onClick={onOpenSpeech} leftSection={<Mic2 size={14} />}>返回配音</Button>
                : needsBillingCheck
                  ? <Button variant="default" size="xs" onClick={() => onOpenCanvas(job.shot_id || undefined)} leftSection={<ArrowRight size={14} />}>回到画布</Button>
                  : <Button variant="default" size="xs" disabled={busy} onClick={() => onRetry(job)} leftSection={job.recovery_available ? <Download size={14} /> : <RefreshCcw size={14} />}>
                    {job.recovery_available ? '恢复下载' : job.task_resume_available ? '继续查询' : '重试'}
                  </Button>
                : <span className="task-records-result-note">{job.status === 'succeeded' ? '结果不可用' : '等待结果'}</span>}
            </div></Table.Td>
          </Table.Tr>
        })}</Table.Tbody>
      </Table> : <div className="task-records-empty" role="status"><Search size={28} strokeWidth={1.4} /><strong>没有符合条件的任务</strong><p>试试其他关键词，或清除筛选查看全部记录。</p><Button variant="default" onClick={clearFilters}>清除筛选</Button></div>}
    </> : <div className="task-records-empty" role="status"><Clock3 size={34} strokeWidth={1.3} /><strong>还没有任务记录</strong><p>在项目画布中生成素材后，可以在这里查看进度和结果。</p><Button variant="default" leftSection={<ArrowRight size={15} />} onClick={() => onOpenCanvas()}>进入画布</Button></div>}
  </section>
}
