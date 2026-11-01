import { useEffect, useState } from 'react'
import { Button, Group, Loader, Modal, ScrollArea, Select, Stack, Text } from '@mantine/core'
import type { ScriptDraftResolution } from '@video-studio/shared/script/script-draft-resolution'
import type { ScriptSourceUpdate } from '@video-studio/shared/script/script-source-document'
import type { WorkflowDraft } from './script-workflow'
import { DirectorDocumentBody, DirectorSceneList } from './DirectorDocuments'
import './director-draft-resolution.css'

type CandidatePreview = { id: string; version: string; draft: WorkflowDraft; source_update?: ScriptSourceUpdate }

export default function DirectorCandidatePreview({ projectId, resolution, opened, onClose, onRefresh }: {
  projectId: string; resolution: ScriptDraftResolution | null; opened: boolean; onClose: () => void; onRefresh: () => Promise<unknown>;
}) {
  const [preview, setPreview] = useState<CandidatePreview | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [retry, setRetry] = useState(0)
  const [selection, setSelection] = useState('')
  const id = resolution?.id, version = resolution?.version
  useEffect(() => {
    if (!opened || !id || !version) return
    const controller = new AbortController()
    setLoading(true); setPreview(null); setError(''); setSelection('')
    void (async () => {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/script/director/resolutions/${encodeURIComponent(id)}?version=${encodeURIComponent(version)}`, { signal: controller.signal })
        const body = await response.json()
        if (controller.signal.aborted) return
        if (!response.ok) throw new Error(response.status === 409 || response.status === 404
          ? '候选稿状态已变化，请刷新候选状态后查看。' : typeof body?.detail === 'string' ? body.detail : '候选稿读取失败，请刷新后重试。')
        if (body.id !== id || body.version !== version) throw new Error('候选稿版本已变化，请刷新候选状态后查看。')
        setPreview(body)
      } catch (issue) {
        if (!controller.signal.aborted) setError(issue instanceof Error ? issue.message : '候选稿读取失败，请稍后重试。')
      } finally { if (!controller.signal.aborted) setLoading(false) }
    })()
    return () => controller.abort()
  }, [projectId, id, version, opened, retry])
  const visible = preview && preview.id === id && preview.version === version ? preview : null
  const documents = visible ? [...visible.draft.artifacts.map((artifact, index) => ({ key: `artifact:${index}`, title: artifact.title, content: artifact.content })),
    ...(visible.source_update ? [{ key: 'source-update', title: '拟修订的有效稿', content: visible.source_update.content }] : [])] : []
  const entries = [...documents.map(document => ({ value: document.key, label: document.title })),
    ...(visible?.draft.scenes.length ? [{ value: 'scenes', label: `分场信息 · ${visible.draft.scenes.length} 场` }] : [])]
  const active = entries.some(entry => entry.value === selection) ? selection : entries[0]?.value
  const document = documents.find(item => item.key === active)
  const refresh = async () => {
    setRefreshing(true); setError('')
    try { await onRefresh(); setRetry(value => value + 1) }
    catch { setError('候选状态刷新失败，请稍后重试。') }
    finally { setRefreshing(false) }
  }
  return <Modal opened={opened && Boolean(resolution)} onClose={onClose} title="已保留的候选稿" size="xl" centered zIndex={450} className="sd-draft-resolution-modal">
    <Stack gap="sm">
      <Text size="sm" c="dimmed">以下为已保留版本，可在处理期间阅读。候选稿尚未通过最终复核，也未正式保存。</Text>
      {loading && <Group gap="xs" role="status"><Loader size="sm" /><Text size="sm">正在读取候选稿…</Text></Group>}
      {error && <Text size="sm" c="red" role="alert">{error}</Text>}
      {visible && <>
        <Select label="选择候选文档" data={entries} value={active || null} onChange={value => setSelection(value || '')} allowDeselect={false}
          comboboxProps={{ withinPortal: true, zIndex: 500 }} />
        <Text size="xs" c="dimmed">{visible.draft.artifacts.length} 份候选文档{visible.draft.scenes.length ? ` · ${visible.draft.scenes.length} 场` : ''} · 只读预览</Text>
        <ScrollArea.Autosize className="sd-candidate-preview-scroll" mah="min(60vh, calc(90dvh - 250px))" type="auto" offsetScrollbars>
          {document ? <div className="sd-document-page"><Text component="h2" fw={600} size="lg" mb="md">{document.title}</Text><DirectorDocumentBody text={document.content} title={document.title} /></div>
            : active === 'scenes' ? <DirectorSceneList scenes={visible.draft.scenes} /> : <Text size="sm" c="dimmed">当前候选稿暂无正文。</Text>}
        </ScrollArea.Autosize>
      </>}
      <Group justify="space-between" gap="xs"><Button variant="subtle" size="sm" loading={refreshing} disabled={loading} onClick={() => void refresh()}>刷新候选状态</Button><Button variant="default" onClick={onClose}>关闭预览</Button></Group>
    </Stack>
  </Modal>
}
