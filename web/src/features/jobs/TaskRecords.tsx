import type { BusinessTaskRecord } from '@video-studio/shared/jobs/business-tasks'
import { api } from '../../shared/api/api'
import BusinessTaskDetails from './BusinessTaskDetails'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ActionIcon, Alert, Badge, Button, Menu, Modal, Pagination, Select, Table, Tabs, Text, TextInput, Tooltip } from '@mantine/core'
import { ArrowRight, Clapperboard, Clock3, Download, Eye, FileText, Film, History, Image as ImageIcon, LoaderCircle, Mic2, MoreHorizontal, RefreshCcw, Search, Sparkles } from 'lucide-react'
import type { Asset, Job, Model, ProjectDetail, Provider } from '../../shared/api/api'
import JobInformationPopover from './JobInformationPopover'
import JobQueueControls from './JobQueueControls'
import PromptOptimizationModal from './PromptOptimizationModal'
import { canOptimizeImagePrompt } from '@video-studio/shared/jobs/prompt-optimization'
import { filterTaskRecords, projectTaskRecords, businessTaskRecords, taskKindLabels, taskRecordCounts, taskRecordStatus, taskRecordSubtitle, type TaskKind, type TaskStatusFilter } from './task-records'
import './task-records.css'
import ModelTaskProgress from './ModelTaskProgress'
import AiOperationRecords from './AiOperationRecords'

type Props = {
  detail: ProjectDetail
  models: Model[]
  providers: Provider[]
  busy: boolean
  onRefresh: () => Promise<unknown>
  onPreview: (asset: Asset) => void
  onOpenCanvas: (shotId?: string) => void
  onOpenSpeech: () => void
  onOpenBusinessTask?: (task: BusinessTaskRecord) => void
  onRetry: (job: Job) => void
  onPromptOptimized?: (job: Job, prompt: string) => void | Promise<void>
}
const statuses: Array<{ value: TaskStatusFilter; label: string }> = [
  { value: 'all', label: '全部' }, { value: 'active', label: '进行中' }, { value: 'failed', label: '失败' }, { value: 'succeeded', label: '已完成' }, { value: 'interrupted', label: '待核对' },
]
const kindIcons = { image: ImageIcon, video: Film, speech: Mic2, export: Clapperboard, text: FileText, unknown: Sparkles, storyboard: Clapperboard, reference: ImageIcon, script: FileText, analysis: Search, prompt: Sparkles }
const statusColors = { active: 'blue', failed: 'red', succeeded: 'teal', interrupted: 'orange' }
const pageSize = 20
const shortDate = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未记录' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

export default function TaskRecords({ detail, models, providers, busy, onRefresh, onPreview, onOpenCanvas, onOpenSpeech, onOpenBusinessTask, onRetry, onPromptOptimized }: Props) {
  const [businessTasks, setBusinessTasks] = useState<BusinessTaskRecord[]>([])
  const [legacyCount, setLegacyCount] = useState(0), [legacyOpen, setLegacyOpen] = useState(false), [historyError, setHistoryError] = useState('')
  const [operationRefresh, setOperationRefresh] = useState(0)
  const [optimizationJobId, setOptimizationJobId] = useState<string | null>(null)
  const optimizationJob = detail.jobs.find(job => job.id === optimizationJobId)
  const [status, setStatus] = useState<TaskStatusFilter>('all')
  const [kind, setKind] = useState<'all' | TaskKind>('all')
  const [query, setQuery] = useState(''), [page, setPage] = useState(1)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const refreshPending = useRef(false)
  useEffect(() => { setPage(1) }, [detail.id, status, kind, query])
  useEffect(() => {
    let disposed = false, pending: AbortController | undefined
    setBusinessTasks([]); setLegacyCount(0); setLegacyOpen(false)
    async function refreshHistory() {
      if (pending) return
      const controller = new AbortController(); pending = controller
      try {
        const value = await api<{tasks:BusinessTaskRecord[];legacy_unlinked_count:number}>(`/projects/${detail.id}/task-history`, { signal: controller.signal })
        if (!Array.isArray(value.tasks)) throw new Error('业务任务记录暂不可用')
        if (!disposed) { setBusinessTasks(value.tasks); setLegacyCount(value.legacy_unlinked_count || 0); setHistoryError('') }
      } catch (issue) { if (!disposed && !controller.signal.aborted) setHistoryError(issue instanceof Error ? issue.message : '任务记录暂不可用') }
      finally { if (pending === controller) pending = undefined }
    }
    void refreshHistory(); const timer = setInterval(() => void refreshHistory(), 5000)
    return () => { disposed = true; clearInterval(timer); pending?.abort() }
  }, [detail.id, operationRefresh])
  const records = useMemo(() => [...projectTaskRecords(detail, models, providers), ...businessTaskRecords(businessTasks, detail.jobs)]
    .sort((a,b) => b.job.created_at.localeCompare(a.job.created_at)), [detail, models, providers, businessTasks])
  const visible = useMemo(() => filterTaskRecords(records, status, kind, query), [records, status, kind, query])
  const counts = useMemo(() => taskRecordCounts(records), [records])
  const pages = Math.max(1, Math.ceil(visible.length / pageSize)), currentPage = Math.min(page, pages)
  const pageRecords = visible.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  async function refresh() {
    if (refreshPending.current) return
    refreshPending.current = true; setRefreshing(true); setRefreshError(null)
    try { await onRefresh(); setOperationRefresh(value => value + 1) }
    catch (error) { setRefreshError(error instanceof Error ? error.message : '刷新失败，请稍后重试') }
    finally { refreshPending.current = false; setRefreshing(false) }
  }
  function clearFilters() { setStatus('all'); setKind('all'); setQuery('') }

  return <section className="page-section task-records" aria-label="任务记录">
    <div className="page-header task-records-header">
      <h1>任务记录</h1>
      <div className="task-records-refresh">
        {counts.active > 0 && <span className="task-records-live"><span aria-hidden="true" />{counts.active} 个任务进行中 · 自动更新</span>}
        <JobQueueControls />
        <Button variant="default" onClick={() => void refresh()} loading={refreshing} leftSection={<RefreshCcw size={15} />}>刷新</Button>
        {legacyCount > 0 && <Menu withinPortal position="bottom-end" width={215}>
          <Menu.Target><ActionIcon variant="subtle" aria-label="任务更多选项"><MoreHorizontal size={19} /></ActionIcon></Menu.Target>
          <Menu.Dropdown><Menu.Item leftSection={<History size={15} />} onClick={() => setLegacyOpen(true)}>历史诊断<Text component="span" c="dimmed" size="xs" ml="xs">{legacyCount}</Text></Menu.Item></Menu.Dropdown>
        </Menu>}
      </div>
    </div>
    {refreshError && <Alert color="red" className="task-records-refresh-error" title="任务刷新失败" role="alert">{refreshError}</Alert>}
    {historyError && <Text size="xs" c="dimmed" role="status">业务任务记录暂不可用，请刷新重试</Text>}
    <div className="task-records-toolbar">
      <Tabs value={status} onChange={value => { if (value) setStatus(value as TaskStatusFilter) }} variant="pills" radius="sm" className="task-records-tabs">
        <Tabs.List aria-label="任务状态筛选">{statuses.map(item => <Tabs.Tab key={item.value} value={item.value}>{item.label}<span>{counts[item.value]}</span></Tabs.Tab>)}</Tabs.List>
      </Tabs>
      <div className="task-records-filters">
        <TextInput aria-label="搜索任务" placeholder="搜索任务、镜头或模型" value={query} onChange={event => setQuery(event.currentTarget.value)} leftSection={<Search size={15} />} />
        <Select aria-label="任务类型" value={kind} onChange={value => { if (value) setKind(value as typeof kind) }} allowDeselect={false}
          data={[{ value: 'all', label: '全部类型' }, ...(['storyboard', 'reference', 'script', 'analysis', 'prompt', 'image', 'video', 'speech', 'export', 'text'] as const).map(value => ({ value, label: taskKindLabels[value] })),
            ...(records.some(record => record.kind === 'unknown') ? [{ value: 'unknown', label: '其他生成' }] : [])]} />
      </div>
    </div>
    {pageRecords.length > 0 ? <>
      <Table className="task-records-table" aria-label="任务列表">
        <Table.Thead><Table.Tr><Table.Th>任务</Table.Th><Table.Th>状态</Table.Th><Table.Th>提交时间</Table.Th><Table.Th>操作</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{pageRecords.map(record => {
          const { job, result, model, provider, shot, business: task, kind: taskKind, needsBillingCheck, recovery } = record
          const canOptimize = !task && canOptimizeImagePrompt(job, model?.modality)
          const Icon = kindIcons[taskKind], state = taskRecordStatus(record)
          const statusLabel = state === 'active' ? job.status === 'queued' ? '排队中' : '进行中' : state === 'failed' ? '失败' : state === 'succeeded' ? '已完成' : '待核对'
          const openBusiness = () => task && (onOpenBusinessTask ? onOpenBusinessTask(task) : task.entry === 'speech' ? onOpenSpeech() : onOpenCanvas(task.scope.shot_ids[0]))
          return <Table.Tr key={task?.id || job.id} data-task-id={task?.id || job.id} data-status={state}>
            <Table.Td><div className="task-records-name"><span className="task-records-icon" aria-hidden="true"><Icon size={17} /></span><div className="task-records-copy">
              <strong>{record.label}</strong><small>{taskRecordSubtitle(record)}</small>
              <time className="task-records-mobile-time" dateTime={job.created_at}>{shortDate(job.created_at)}</time>
            </div></div></Table.Td>
            <Table.Td><Badge variant="light" color={statusColors[state]} className="task-records-status" leftSection={state === 'active' ? <LoaderCircle className="spin" size={11} /> : undefined}>{statusLabel}</Badge></Table.Td>
            <Table.Td className="task-records-date"><time dateTime={job.created_at} title={new Date(job.created_at).toLocaleString('zh-CN')}>{shortDate(job.created_at)}</time></Table.Td>
            <Table.Td><div className="task-records-actions">
              {task ? <><Button variant="default" size="compact-xs" onClick={openBusiness}>回原任务</Button><BusinessTaskDetails task={task} /></> : <>
                {canOptimize && onPromptOptimized && <Tooltip label="调整被拒绝的提示词"><ActionIcon variant="subtle" aria-label="优化提示词" disabled={busy} onClick={() => setOptimizationJobId(job.id)}><Sparkles size={16} /></ActionIcon></Tooltip>}
                {result ? <>
                  <Button variant="default" size="compact-xs" leftSection={<Eye size={13} />} onClick={() => onPreview(result)}>查看结果</Button>
                  {taskKind === 'export' && <Tooltip label="下载成片"><ActionIcon component="a" variant="subtle" href={result.url} download aria-label="下载成片"><Download size={16} /></ActionIcon></Tooltip>}
                </> : job.status === 'failed' ? taskKind === 'speech' && recovery?.action !== 'local' && recovery?.action !== 'prepare'
                  ? <Button variant="default" size="compact-xs" onClick={onOpenSpeech}>返回配音</Button>
                  : needsBillingCheck || canOptimize
                    ? <Button variant="default" size="compact-xs" onClick={() => onOpenCanvas(job.shot_id || undefined)}>回到画布</Button>
                    : <Button variant="default" size="compact-xs" disabled={busy} onClick={() => onRetry(job)}>{recovery?.label || '重试'}</Button>
                  : <span className="task-records-result-note">{job.status === 'succeeded' ? '结果不可用' : '等待结果'}</span>}
                <JobInformationPopover job={job} model={model} provider={provider} shot={shot} projectName={detail.name} assets={detail.assets} onOpenCanvas={() => onOpenCanvas(job.shot_id || undefined)}>
                  {businessTasks.filter(parent => parent.job_ids.includes(job.id)).map(parent => <BusinessTaskDetails key={parent.id} task={parent} embedded />)}
                </JobInformationPopover>
              </>}
            </div></Table.Td>
          </Table.Tr>
        })}</Table.Tbody>
      </Table>
      <div className="task-records-pagination"><Text size="xs" c="dimmed">第 {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, visible.length)} 条，共 {visible.length} 条</Text>
        {pages > 1 && <Pagination value={currentPage} onChange={setPage} total={pages} size="sm" siblings={0} boundaries={1} aria-label="任务分页" />}
      </div>
    </> : records.length > 0 ? <div className="task-records-empty" role="status"><Search size={28} strokeWidth={1.4} /><strong>没有符合条件的任务</strong><p>试试其他关键词，或清除筛选查看全部记录。</p><Button variant="default" onClick={clearFilters}>清除筛选</Button></div>
      : <div className="task-records-empty" role="status"><Clock3 size={34} strokeWidth={1.3} /><strong>还没有任务记录</strong><p>在项目中创作或生成素材后，可以在这里查看进度和结果。</p><Button variant="default" leftSection={<ArrowRight size={15} />} onClick={() => onOpenCanvas()}>进入画布</Button></div>}
    <Modal opened={legacyOpen} onClose={() => setLegacyOpen(false)} title="历史诊断" size="lg" centered>
      {legacyOpen && <div aria-label="未关联历史诊断"><Text size="sm" c="dimmed" mb="md">旧记录未关联业务任务，可在这里核对保留成果与恢复状态。</Text>
        <AiOperationRecords projectId={detail.id} refreshKey={operationRefresh} excludedIds={businessTasks.flatMap(task => task.operation_ids)} />
        <ModelTaskProgress projectId={detail.id} excludedIds={businessTasks.flatMap(task => task.model_task_ids)} />
      </div>}
    </Modal>
    {optimizationJob && onPromptOptimized && canOptimizeImagePrompt(optimizationJob, models.find(model => model.id === optimizationJob.model_id)?.modality) &&
      <PromptOptimizationModal key={optimizationJob.id} job={optimizationJob} models={models} providers={providers} newDraft disabled={busy}
        onClose={() => setOptimizationJobId(null)} onApply={prompt => onPromptOptimized(optimizationJob, prompt)} />}
  </section>
}
