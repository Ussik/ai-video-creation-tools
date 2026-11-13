import { useRef, useState } from 'react'
import { Badge, Button, Modal, Text } from '@mantine/core'
import { History } from 'lucide-react'
import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'
import type { PromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'
import type { CanvasPromptReference } from './CanvasPromptEditor'
import CanvasPromptSectionDiff from './CanvasPromptSectionDiff'
import { promptSectionDetails, promptSectionLabel } from './canvas-prompt-section-details'
import './canvas-prompt-document-status.css'

type Props = {
  document: PromptSectionDocument
  references: CanvasPromptReference[]
  disabled: boolean
  onResolve: (id: string, choice: 'keep_custom' | 'follow_source') => void
  presentation?: 'inline' | 'dialog'
}

export default function CanvasPromptDocumentStatus({ document, references, disabled, onResolve, presentation = 'inline' }: Props) {
  const [opened, setOpened] = useState(false)
  const [comparedId, setComparedId] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const blocks = document.blocks.filter(block => block.kind === 'managed')
  const changed = blocks.filter(block => !block.deleted && block.pendingSourceText !== undefined)
  const removed = blocks.filter(block => block.deleted)
  const ordered = [...changed, ...blocks.filter(block => !changed.includes(block))]
  const compared = blocks.find(block => block.id === comparedId)
  const inDialog = presentation === 'dialog'
  function closeHistory() { setOpened(false); trigger.current?.focus() }
  function compare(id: string) {
    setComparedId(id)
    if (inDialog) setOpened(false)
  }
  function closeComparison() {
    setComparedId(null)
    if (inDialog) setOpened(true)
  }
  if (!blocks.length) return null
  const removedNotice = removed.length > 0 && <div className="pc-prompt-removed-sections" role="status" aria-label="已移除的提示词区块">
      <Text size="xs">已移除 {removed.length} 项要求，生成时不会发送。</Text>
      {removed.map(block => <div className="pc-prompt-removed-row" key={block.id}>
        <Text size="xs">{promptSectionLabel(block.name)}</Text>
        {!!(block.pendingSourceText || block.sourceText) && <Button size="compact-xs" variant="subtle" disabled={disabled}
          aria-label={`恢复来源内容：${promptSectionLabel(block.name)}`} onClick={() => onResolve(block.id, 'follow_source')}>恢复来源内容</Button>}
      </div>)}
    </div>
  const records = <>
      <Text size="xs" c="dimmed" className="pc-prompt-source-record-note">修改仅影响当前节点，不会改写来源设定。</Text>
      {ordered.map(block => {
        const { pending, customized, source, state } = promptSectionDetails(block, references)
        return <div className={`pc-prompt-source-row${pending ? ' is-pending' : ''}`} key={block.id}>
          <div className="pc-prompt-source-details"><div className="pc-prompt-source-heading"><Text size="xs">{promptSectionLabel(block.name)}</Text><Badge size="xs" variant="light" color={pending ? 'orange' : customized ? 'blue' : 'gray'}>{state}</Badge></div>
            <Text size="xs" c="dimmed">来源：{source}</Text></div>
          <div className="pc-prompt-source-actions"><Button size="compact-xs" variant="subtle" onClick={() => compare(block.id)} aria-label={`查看区块差异：${promptSectionLabel(block.name)}`}>查看差异</Button>
            {pending && <Button size="compact-xs" variant="default" disabled={disabled} onClick={() => onResolve(block.id, 'keep_custom')}
              aria-label={`保留本节点修改：${promptSectionLabel(block.name)}`}>保留本节点修改</Button>}
            {!block.deleted && (customized || pending) && block.sourceText !== undefined && <Button size="compact-xs" variant="subtle" disabled={disabled}
              onClick={() => onResolve(block.id, 'follow_source')} aria-label={`沿用来源内容：${promptSectionLabel(block.name)}`}>{pending ? '使用来源更新' : '沿用来源'}</Button>}</div>
        </div>
      })}
    </>
  return <>
    {inDialog ? <>
      <Button ref={trigger} size="compact-xs" variant="subtle" color="gray" className="pc-prompt-source-trigger"
        leftSection={<History size={14} />} aria-label="查看来源与修改记录" onClick={() => setOpened(true)}>
        <span className="pc-prompt-source-trigger-label">来源记录
          {changed.length > 0 && <span className="pc-prompt-source-trigger-pending">{changed.length} 项待确认</span>}
          {removed.length > 0 && <span className="pc-prompt-source-trigger-removed">{removed.length} 项已移除</span>}
        </span>
      </Button>
      <Modal opened={opened} onClose={closeHistory} title="来源与修改记录" centered size="lg" zIndex={280} returnFocus={false}
        closeButtonProps={{ 'aria-label': '关闭来源与修改记录' }} className="pc-prompt-source-dialog"
        onKeyDown={event => { if (event.key !== 'Tab') event.stopPropagation() }}>
        {removedNotice}
        <section className="pc-prompt-source-dialog-records" aria-label="来源记录明细">{records}</section>
        <div className="pc-prompt-source-dialog-footer"><Button variant="default" size="xs" onClick={closeHistory}>返回正文</Button></div>
      </Modal>
    </> : <>
      {removedNotice}
      <WorkspaceDisclosure className="pc-prompt-document-status" label={<span className="pc-prompt-source-record-label">
        <span>来源与修改记录</span>{changed.length > 0 && <Badge size="xs" variant="light" color="orange">{changed.length} 项待确认</Badge>}
      </span>}>{records}</WorkspaceDisclosure>
    </>}
    <div className="pc-prompt-source-comparison" onKeyDown={event => { if (event.key !== 'Tab') event.stopPropagation() }}>
      <CanvasPromptSectionDiff block={compared} displayName={compared && promptSectionLabel(compared.name)} references={references} disabled={disabled} onClose={closeComparison} onResolve={onResolve} />
    </div>
  </>
}
