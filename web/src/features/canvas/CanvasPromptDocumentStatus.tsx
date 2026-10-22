import { useState } from 'react'
import { Badge, Button, Modal, Stack, Text, Textarea } from '@mantine/core'
import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'
import type { PromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'
import type { CanvasPromptReference } from './CanvasPromptEditor'
import './canvas-prompt-document-status.css'

type Props = {
  document: PromptSectionDocument
  references: CanvasPromptReference[]
  disabled: boolean
  onResolve: (id: string, choice: 'keep_custom' | 'follow_source') => void
}

export default function CanvasPromptDocumentStatus({ document, references, disabled, onResolve }: Props) {
  const [comparedId, setComparedId] = useState<string | null>(null)
  const blocks = document.blocks.filter(block => block.kind === 'managed')
  const changed = blocks.filter(block => block.pendingSourceText !== undefined)
  const compared = blocks.find(block => block.id === comparedId)
  const readable = (value: string) => value.replace(/\[\[ref:([^\]]+)\]\]/g, (_, id: string) =>
    `@${references.find(reference => reference.assetId === id)?.label || '原参考图片'}`)
  if (!blocks.length) return null
  return <>
    <WorkspaceDisclosure className="pc-prompt-document-status" label={`设定来源与同步${changed.length ? ` · ${changed.length} 项待确认` : ''}`}>
      <Text size="xs" c="dimmed">此处修改仅影响当前节点。未改的内容跟随项目更新，自定义内容保留。</Text>
      {blocks.map(block => {
        const pending = block.pendingSourceText !== undefined
        const customized = block.deleted || block.sourceText === undefined || block.text !== block.sourceText
        return <div className="pc-prompt-source-row" key={block.id}>
          <div><Text size="xs">{block.name}</Text><Badge size="xs" variant="light" color={pending ? 'orange' : customized ? 'blue' : 'gray'}>
            {pending ? '来源已更新' : block.deleted ? '已移除' : customized ? '本节点自定义' : '跟随项目'}</Badge></div>
          <div><Button size="compact-xs" variant="subtle" onClick={() => setComparedId(block.id)} aria-label={`查看区块差异：${block.name}`}>查看差异</Button>
            {pending && <Button size="compact-xs" variant="default" disabled={disabled} onClick={() => onResolve(block.id, 'keep_custom')}
              aria-label={`保留本节点修改：${block.name}`}>保留本节点修改</Button>}
            {(customized || pending) && block.sourceText !== undefined && <Button size="compact-xs" variant="subtle" disabled={disabled}
              onClick={() => onResolve(block.id, 'follow_source')} aria-label={`跟随项目设定：${block.name}`}>跟随项目</Button>}</div>
        </div>
      })}
    </WorkspaceDisclosure>
    <Modal opened={!!compared} onClose={() => setComparedId(null)} title={`${compared?.name || ''} · 内容对比`} centered size="lg" zIndex={235}>
      {compared && <Stack gap="sm">
        <Textarea label="当前节点内容" value={readable(compared.deleted ? '已移除此区块' : compared.text)} readOnly autosize minRows={3} maxRows={10} />
        <Textarea label="当前项目提供的内容" value={readable(compared.pendingSourceText ?? compared.sourceText ?? '此区块由当前节点创建')}
          readOnly autosize minRows={3} maxRows={10} />
        {compared.pendingSourceText !== undefined && <div className="pc-prompt-source-actions">
          <Button variant="default" disabled={disabled} onClick={() => { onResolve(compared.id, 'keep_custom'); setComparedId(null) }}>保留本节点修改</Button>
          <Button disabled={disabled} onClick={() => { onResolve(compared.id, 'follow_source'); setComparedId(null) }}>跟随项目设定</Button>
        </div>}
      </Stack>}
    </Modal>
  </>
}
