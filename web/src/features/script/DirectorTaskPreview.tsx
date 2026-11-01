import { useState } from 'react'
import { Button, Group, Modal, ScrollArea, Select, Stack, Text } from '@mantine/core'
import type { ScriptActivity } from '@video-studio/shared/script/script-activity-types'
import { DirectorDocumentBody, DirectorSceneList } from './DirectorDocuments'
import './director-draft-resolution.css'

/** An activity owns its full candidate snapshot. Reading it never starts work
 * or writes a formal document, and an updated activity replaces the snapshot. */
export default function DirectorTaskPreview({ activity, onClose }: { activity?: ScriptActivity; onClose: () => void }) {
  const [selection, setSelection] = useState('')
  const preview = activity?.artifact_preview
  const documents = preview?.artifacts.map((artifact, index) => ({ key: `artifact:${index}`, ...artifact })) || []
  const entries = [...documents.map(document => ({ value: document.key, label: document.title })),
    ...(preview?.scenes.length ? [{ value: 'scenes', label: `分场信息 · ${preview.scenes.length} 场` }] : [])]
  const active = entries.some(entry => entry.value === selection) ? selection : entries[0]?.value
  const document = documents.find(item => item.key === active)
  return <Modal opened={Boolean(preview)} onClose={onClose} title={activity?.label || '任务成果'} size="xl" centered zIndex={450} className="sd-draft-resolution-modal">
    <Stack gap="sm">
      <Text size="sm" c="dimmed">这是该步骤保留的候选成果，可在后续任务处理期间阅读。整体核验与最终确认以本轮任务状态为准，此预览不会正式保存文档。</Text>
      {entries.length > 1 && <Select label="选择成果文档" data={entries} value={active || null} onChange={value => setSelection(value || '')}
        allowDeselect={false} comboboxProps={{ withinPortal: true, zIndex: 500 }} />}
      <Text size="xs" c="dimmed">候选成果 · 只读预览</Text>
      <ScrollArea.Autosize className="sd-candidate-preview-scroll" mah="min(60vh, calc(90dvh - 250px))" type="auto" offsetScrollbars>
        {document ? <div className="sd-document-page"><Text component="h2" fw={600} size="lg" mb="md">{document.title}</Text><DirectorDocumentBody text={document.content} title={document.title} /></div>
          : active === 'scenes' && preview ? <DirectorSceneList scenes={preview.scenes} /> : <Text size="sm" c="dimmed">当前步骤暂无可预览正文。</Text>}
      </ScrollArea.Autosize>
      <Group justify="flex-end"><Button variant="default" onClick={onClose}>关闭预览</Button></Group>
    </Stack>
  </Modal>
}
