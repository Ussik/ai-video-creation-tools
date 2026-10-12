import { useEffect, useRef, useState } from 'react'
import { Alert, Button, NumberInput, Popover } from '@mantine/core'
import { SlidersHorizontal } from 'lucide-react'
import { api, json } from '../../shared/api/api'
import './job-queue-controls.css'

type QueueStatus = { concurrency: number; max_concurrency: number; running: number; queued: number }

export default function JobQueueControls() {
  const [queue, setQueue] = useState<QueueStatus | null>(null)
  const [opened, setOpened] = useState(false)
  const [draft, setDraft] = useState<string | number>(3)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const mounted = useRef(false)
  const mutating = useRef(false)
  const version = useRef(0)
  const pollRequest = useRef<AbortController | null>(null)
  const saveRequest = useRef<AbortController | null>(null)

  useEffect(() => {
    mounted.current = true
    const refresh = async () => {
      if (mutating.current || pollRequest.current) return
      const controller = new AbortController()
      pollRequest.current = controller
      const requestVersion = ++version.current
      try {
        const status = await api<QueueStatus>('/job-queue', { signal: controller.signal })
        if (mounted.current && requestVersion === version.current) {
          setQueue(status)
          setLoadError(null)
        }
      } catch (issue) {
        if (mounted.current && !controller.signal.aborted && requestVersion === version.current) {
          setLoadError(issue instanceof Error ? issue.message : '队列信息加载失败')
        }
      } finally {
        if (pollRequest.current === controller) pollRequest.current = null
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 4000)
    return () => {
      mounted.current = false
      ++version.current
      clearInterval(timer)
      pollRequest.current?.abort()
      pollRequest.current = null
      saveRequest.current?.abort()
    }
  }, [])

  const limit = queue?.max_concurrency ?? 10
  const valid = typeof draft === 'number' && Number.isInteger(draft) && draft >= 1 && draft <= limit

  function changeOpened(value: boolean) {
    if (mutating.current) return
    if (value) { setDraft(queue?.concurrency ?? 3); setSaveError(null) }
    setOpened(value)
  }

  async function save() {
    if (!valid || mutating.current) return
    mutating.current = true
    setSaving(true)
    setSaveError(null)
    pollRequest.current?.abort()
    const requestVersion = ++version.current
    const controller = new AbortController()
    saveRequest.current = controller
    try {
      const status = await api<QueueStatus>('/job-queue', { ...json('PUT', { concurrency: draft }), signal: controller.signal })
      if (mounted.current && requestVersion === version.current) {
        setQueue(status)
        setOpened(false)
      }
    } catch (issue) {
      if (mounted.current && !controller.signal.aborted) setSaveError(issue instanceof Error ? issue.message : '并行设置保存失败')
    } finally {
      mutating.current = false
      saveRequest.current = null
      if (mounted.current) setSaving(false)
    }
  }

  return <div className="job-queue-controls">
    {queue && <span className="job-queue-counts" title="所有项目的任务队列">全局 · 执行 {queue.running}/{queue.concurrency} · 排队 {queue.queued}</span>}
    <Popover opened={opened} onChange={changeOpened} position="bottom-end" width={320} shadow="md" withinPortal>
      <Popover.Target><Button variant="default" onClick={() => changeOpened(!opened)} disabled={saving} leftSection={<SlidersHorizontal size={16} />}>并行设置</Button></Popover.Target>
      <Popover.Dropdown className="job-queue-settings">
        <strong>任务并行设置</strong>
        <NumberInput label="同时执行上限" description={`可设置 1–${limit} 条，应用于所有项目的队列任务`} value={draft} onChange={setDraft}
          min={1} max={limit} step={1} allowDecimal={false} allowNegative={false} disabled={!queue || saving} />
        <p>成片导出每次执行 1 条。降低上限时，已运行的任务会继续完成。</p>
        {(saveError || loadError) && <Alert color="red" role="alert">{saveError || loadError}</Alert>}
        <Button fullWidth onClick={() => void save()} loading={saving} disabled={!queue || !valid}>保存设置</Button>
      </Popover.Dropdown>
    </Popover>
    {loadError && !opened && <span className="job-queue-load-error" role="status">队列设置暂不可用</span>}
  </div>
}
