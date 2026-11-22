import type { BusinessTaskRecord } from '@video-studio/shared/jobs/business-tasks'
import { api } from '../../shared/api/api'
import BusinessTaskDetails from './BusinessTaskDetails'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ActionIcon, Alert, Badge, Button, Menu, Modal, Pagination, Select, Tabs, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core'
import { ArrowLeft, ArrowRight, Clapperboard, Clock3, Download, Eye, FileText, Film, History, Image as ImageIcon, LoaderCircle, Mic2, MoreHorizontal, RefreshCcw, Search, Sparkles } from 'lucide-react'
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
  headerControls?: ReactNode
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
  { value: 'all', label: '全部' }, { value: 'active', label: '进行中' }, { value: 'succeeded', label: '已完成' }, { value: 'failed', label: '失败' }, { value: 'interrupted', label: '待核对' },
]
const kindIcons = { image: ImageIcon, video: Film, speech: Mic2, export: Clapperboard, text: FileText, unknown: Sparkles, storyboard: Clapperboard, reference: ImageIcon, script: FileText, analysis: Search, prompt: Sparkles }
const statusColors = { active: 'blue', failed: 'red', succeeded: 'teal', interrupted: 'orange' }
const pageSize = 20
const exportStatuses = { active: '进行中', succeeded: '已完成', failed: '失败', interrupted: '待核对' }
const csvCell = (value: string) => {
  const cell = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/.test(value) ? "'" + value : value
  return '"' + cell.replaceAll('"', '""') + '"'
}
const shortDate = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未记录' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

export default function TaskRecords({ headerControls, detail, models, providers, busy, onRefresh, onPreview, onOpenCanvas, onOpenSpeech, onOpenBusinessTask, onRetry, onPromptOptimized }: Props) {
  const [businessTasks, setBusinessTasks] = useState<BusinessTaskRecord[]>([])
  const [legacyCount, setLegacyCount] = useState(0), [legacyOpen, setLegacyOpen] = useState(false), [historyError, setHistoryError] = useState('')
  const [operationRefresh, setOperationRefresh] = useState(0)
  const [optimizationJobId, setOptimizationJobId] = useState<string | null>(null)
  const optimizationJob = detail.jobs.find(job => job.id === optimizationJobId)
  const [status, setStatus] = useState<TaskStatusFilter>('all')
  const [kind, setKind] = useState<'all' | TaskKind>('all')
  const [query, setQuery] = useState(''), [page, setPage] = useState(1)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [taskSettingsOpen, setTaskSettingsOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportScope, setExportScope] = useState('filtered')
  const [exportFormat, setExportFormat] = useState('csv')
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
  const selectedRecord = pageRecords.find(record => (record.business?.id || record.job.id) === selectedTaskId) || pageRecords[0]
  const selectedState = selectedRecord ? taskRecordStatus(selectedRecord) : null

  const recentCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  const recentRecords = records.filter(record => Date.parse(record.job.created_at) >= recentCutoff)
  const recentFinishedCount = records.filter(record => taskRecordStatus(record) === 'succeeded' && Date.parse(record.business?.updated_at || record.result?.created_at || record.job.created_at) >= recentCutoff).length
  const exportRecords = exportScope === 'filtered' ? visible : exportScope === 'recent' ? recentRecords : records

  function downloadTaskRecords() {
    const rows = exportRecords.map(record => ({
      任务: record.label,
      类型: taskKindLabels[record.kind],
      状态: exportStatuses[taskRecordStatus(record)],
      模型: record.model?.name || '',
      错误摘要: record.job.error ? taskRecordSubtitle(record) : '',
      创建时间: record.job.created_at,
    }))
    if (!rows.length) return
    const csv = exportFormat === 'csv'
    const content = csv
      ? '\uFEFF' + [Object.keys(rows[0]!), ...rows.map(row => Object.values(row))].map(row => row.map(csvCell).join(',')).join('\r\n')
      : JSON.stringify(rows, null, 2)
    const url = URL.createObjectURL(new Blob([content], { type: csv ? 'text/csv;charset=utf-8' : 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `任务记录.${exportFormat}`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setExportOpen(false)
  }

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
        {headerControls}
        <Button variant="default" leftSection={<Download size={15} />} disabled={!records.length} onClick={() => setExportOpen(true)}>导出记录</Button>
        <Menu withinPortal position="bottom-end" width={180}>
          <Menu.Target><ActionIcon variant="subtle" aria-label="任务更多选项"><MoreHorizontal size={19} /></ActionIcon></Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<RefreshCcw size={15} />} disabled={refreshing} onClick={() => void refresh()}>刷新</Menu.Item>
            <Menu.Item onClick={() => setTaskSettingsOpen(true)}>并行设置</Menu.Item>
            {legacyCount > 0 && <Menu.Item leftSection={<History size={15} />} onClick={() => setLegacyOpen(true)}>历史诊断<Text component="span" c="dimmed" size="xs" ml="xs">{legacyCount}</Text></Menu.Item>}
          </Menu.Dropdown>
        </Menu>
      </div>
    </div>
    <Modal opened={exportOpen} onClose={() => setExportOpen(false)} title="导出任务记录" centered size="sm"
      classNames={{ content: 'v4-fixed-dialog', body: 'v4-fixed-dialog-body' }}>
      <div className="v4-dialog-scroll">
        <Select label="范围" value={exportScope} allowDeselect={false} onChange={value => value && setExportScope(value)}
          data={[{ value: 'filtered', label: '当前筛选结果' }, { value: 'recent', label: '最近 7 天' }, { value: 'all', label: '全部记录' }]} />
        <Select label="格式" value={exportFormat} allowDeselect={false} onChange={value => value && setExportFormat(value)}
          data={[{ value: 'csv', label: 'CSV' }, { value: 'json', label: 'JSON' }]} />
      </div>
      <footer className="v4-dialog-actions">
        <Button variant="default" onClick={() => setExportOpen(false)}>取消</Button>
        <Button leftSection={<Download size={15} />} disabled={!exportRecords.length} onClick={downloadTaskRecords}>准备导出</Button>
      </footer>
    </Modal>
    <Modal opened={taskSettingsOpen} onClose={() => setTaskSettingsOpen(false)} title="并行设置" centered>
      <JobQueueControls />
    </Modal>
    {refreshError && <Alert color="red" className="task-records-refresh-error" title="任务刷新失败" role="alert">{refreshError}</Alert>}
    {historyError && <Text size="xs" c="dimmed" role="status">业务任务记录暂不可用，请刷新重试</Text>}
    <div className="task-records-summary" aria-label="任务概览">
      <div><span>进行中</span><strong>{counts.active.toLocaleString('zh-CN')}</strong><small>需要等待结果</small></div>
      <div><span>最近完成</span><strong>{recentFinishedCount.toLocaleString('zh-CN')}</strong><small>过去 7 天</small></div>
      <div><span>需要处理</span><strong>{(counts.failed + counts.interrupted).toLocaleString('zh-CN')}</strong><small>失败或待核对</small></div>
    </div>
    <div className="task-records-toolbar">
      <Tabs value={status} onChange={value => { if (value) setStatus(value as TaskStatusFilter) }} className="task-records-tabs">
        <Tabs.List aria-label="任务状态筛选">{statuses.map(item => <Tabs.Tab key={item.value} value={item.value}>{item.label}<span>{counts[item.value]}</span></Tabs.Tab>)}</Tabs.List>
      </Tabs>
      <div className="task-records-filters">
        <TextInput aria-label="搜索任务" placeholder="搜索任务、镜头或模型" value={query} onChange={event => setQuery(event.currentTarget.value)} leftSection={<Search size={15} />} />
        <Select aria-label="任务类型" value={kind} onChange={value => { if (value) setKind(value as typeof kind) }} allowDeselect={false}
          data={[{ value: 'all', label: '全部类型' }, ...(['storyboard', 'reference', 'script', 'analysis', 'prompt', 'image', 'video', 'speech', 'export', 'text'] as const).map(value => ({ value, label: taskKindLabels[value] })),
            ...(records.some(record => record.kind === 'unknown') ? [{ value: 'unknown', label: '其他生成' }] : [])]} />
      </div>
    </div>
    {pageRecords.length > 0 ? <div className={`task-records-workspace${selectedTaskId && selectedRecord ? ' is-detail-open' : ''}`}>
      <div className="task-records-list-column">
      <div className="task-records-list" role="list" aria-label="任务列表">
        {pageRecords.map(record => {
          const { job, result, model, provider, shot, business: task, kind: taskKind, needsBillingCheck, recovery } = record
          const canOptimize = !task && canOptimizeImagePrompt(job, model?.modality)
          const Icon = kindIcons[taskKind], state = taskRecordStatus(record)
          const statusLabel = state === 'active' ? job.status === 'queued' ? '排队中' : '进行中' : state === 'failed' ? '失败' : state === 'succeeded' ? '已完成' : '待核对'
          const openBusiness = () => task && (onOpenBusinessTask ? onOpenBusinessTask(task) : task.entry === 'speech' ? onOpenSpeech() : onOpenCanvas(task.scope.shot_ids[0]))
          const selected = (selectedRecord?.business?.id || selectedRecord?.job.id) === (task?.id || job.id)
          return <article role="listitem" className={`task-records-row${selected ? ' is-selected' : ''}`} key={task?.id || job.id} data-task-id={task?.id || job.id} data-status={state}>
            <UnstyledButton className="task-records-select" aria-label={`查看任务：${record.label}`} aria-pressed={selected} onClick={() => setSelectedTaskId(task?.id || job.id)}>
            <span className="task-records-name"><span className="task-records-icon" aria-hidden="true"><Icon size={17} /></span><span className="task-records-copy">
              <strong>{record.label}</strong><small>{taskRecordSubtitle(record)}</small>
              <time className="task-records-mobile-time" dateTime={job.created_at}>{shortDate(job.created_at)}</time>
            </span></span>
            <span className="task-records-row-state"><Badge variant="light" color={statusColors[state]} className="task-records-status" leftSection={state === 'active' ? <LoaderCircle className="spin" size={11} /> : undefined}>{statusLabel}</Badge>
            <time className="task-records-date" dateTime={job.created_at} title={new Date(job.created_at).toLocaleString('zh-CN')}>{shortDate(job.created_at)}</time></span></UnstyledButton>
            <div className="task-records-actions">
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
            </div>
          </article>
        })}
      </div>
      <div className="task-records-pagination"><Text size="xs" c="dimmed">第 {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, visible.length)} 条，共 {visible.length} 条</Text>
        {pages > 1 && <Pagination value={currentPage} onChange={setPage} total={pages} size="sm" siblings={0} boundaries={1} aria-label="任务分页" />}
      </div>
      </div>
      {selectedRecord && <aside className="task-records-detail" aria-label="选中任务详情">
        <header><ActionIcon className="task-records-detail-back" variant="subtle" aria-label="返回任务列表" onClick={() => setSelectedTaskId(null)}><ArrowLeft size={17} /></ActionIcon><span>任务详情</span><h2>{selectedRecord.label}</h2><Badge variant="light" color={statusColors[selectedState!]}>{statuses.find(item => item.value === selectedState)?.label}</Badge></header>
        <div className="task-records-detail-scroll">
          {selectedRecord.business ? <BusinessTaskDetails key={selectedRecord.business.id} task={selectedRecord.business} embedded loadDetails={selectedTaskId === selectedRecord.business.id} /> : <JobInformationPopover key={selectedRecord.job.id} embedded loadDetails={selectedTaskId === selectedRecord.job.id} job={selectedRecord.job} model={selectedRecord.model} provider={selectedRecord.provider} shot={selectedRecord.shot} projectName={detail.name} assets={detail.assets} onOpenCanvas={() => onOpenCanvas(selectedRecord.job.shot_id || undefined)}>
            {businessTasks.filter(parent => parent.job_ids.includes(selectedRecord.job.id)).map(parent => <BusinessTaskDetails key={parent.id} task={parent} embedded />)}
          </JobInformationPopover>}
        </div>
      </aside>}
    </div> : records.length > 0 ? <div className="task-records-empty" role="status"><Search size={28} strokeWidth={1.4} /><strong>没有符合条件的任务</strong><p>试试其他关键词，或清除筛选查看全部记录。</p><Button variant="default" onClick={clearFilters}>清除筛选</Button></div>
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
