import { useState } from 'react'
import { Badge, Button, Text } from '@mantine/core'
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
}

export default function CanvasPromptDocumentStatus({ document, references, disabled, onResolve }: Props) {
  const [comparedId, setComparedId] = useState<string | null>(null)
  const blocks = document.blocks.filter(block => block.kind === 'managed')
  const changed = blocks.filter(block => !block.deleted && block.pendingSourceText !== undefined)
  const removed = blocks.filter(block => block.deleted)
  const ordered = [...changed, ...blocks.filter(block => !changed.includes(block))]
  const compared = blocks.find(block => block.id === comparedId)
  if (!blocks.length) return null
  return <>
    {removed.length > 0 && <div className="pc-prompt-removed-sections" role="status" aria-label="已移除的提示词区块">
      <Text size="xs">已移除 {removed.length} 项要求，生成时不会发送。</Text>
      {removed.map(block => <div className="pc-prompt-removed-row" key={block.id}>
        <Text size="xs">{promptSectionLabel(block.name)}</Text>
        {!!(block.pendingSourceText || block.sourceText) && <Button size="compact-xs" variant="subtle" disabled={disabled}
          aria-label={`恢复来源内容：${promptSectionLabel(block.name)}`} onClick={() => onResolve(block.id, 'follow_source')}>恢复来源内容</Button>}
      </div>)}
    </div>}
    <WorkspaceDisclosure className="pc-prompt-document-status" label={<span className="pc-prompt-source-record-label">
      <span>来源与修改记录</span>{changed.length > 0 && <Badge size="xs" variant="light" color="orange">{changed.length} 项待确认</Badge>}
    </span>}>
      <Text size="xs" c="dimmed" className="pc-prompt-source-record-note">修改仅影响当前节点，不会改写来源设定。</Text>
      {ordered.map(block => {
        const { pending, customized, source, state } = promptSectionDetails(block, references)
        return <div className={`pc-prompt-source-row${pending ? ' is-pending' : ''}`} key={block.id}>
          <div className="pc-prompt-source-details"><div className="pc-prompt-source-heading"><Text size="xs">{promptSectionLabel(block.name)}</Text><Badge size="xs" variant="light" color={pending ? 'orange' : customized ? 'blue' : 'gray'}>{state}</Badge></div>
            <Text size="xs" c="dimmed">来源：{source}</Text></div>
          <div className="pc-prompt-source-actions"><Button size="compact-xs" variant="subtle" onClick={() => setComparedId(block.id)} aria-label={`查看区块差异：${promptSectionLabel(block.name)}`}>查看差异</Button>
            {pending && <Button size="compact-xs" variant="default" disabled={disabled} onClick={() => onResolve(block.id, 'keep_custom')}
              aria-label={`保留本节点修改：${promptSectionLabel(block.name)}`}>保留本节点修改</Button>}
            {!block.deleted && (customized || pending) && block.sourceText !== undefined && <Button size="compact-xs" variant="subtle" disabled={disabled}
              onClick={() => onResolve(block.id, 'follow_source')} aria-label={`沿用来源内容：${promptSectionLabel(block.name)}`}>{pending ? '使用来源更新' : '沿用来源'}</Button>}</div>
        </div>
      })}
    </WorkspaceDisclosure>
    <CanvasPromptSectionDiff block={compared} displayName={compared && promptSectionLabel(compared.name)} references={references} disabled={disabled} onClose={() => setComparedId(null)} onResolve={onResolve} />
  </>
}
