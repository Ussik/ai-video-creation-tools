import { Button, Modal, Stack, Text } from '@mantine/core'
import type { PromptSectionBlock } from '@video-studio/shared/visuals/prompt-section-document'
import { WorkspaceDisclosure } from '../../shared/ui/WorkspaceDisclosure'
import { promptSectionDetails, promptSectionLineDiff, readablePromptSection } from './canvas-prompt-section-details'
import './canvas-prompt-document-status.css'

type Props = {
  block?: PromptSectionBlock
  displayName?: string
  references: Array<{ assetId: string; label: string }>
  disabled: boolean
  onClose: () => void
  onResolve?: (id: string, choice: 'keep_custom' | 'follow_source') => void
}

function Changes({ label, before, after }: { label: string; before: string; after: string }) {
  const lines = promptSectionLineDiff(before, after)
  return <section className="pc-prompt-diff-section" aria-label={label}>
    <Text size="sm" fw={600}>{label}</Text>
    {before === after ? <Text size="xs" c="dimmed">内容未变化</Text> : <ol className="pc-prompt-diff-lines">
      {lines.map((line, index) => <li key={index} data-change={line.kind}>
        <span className="pc-prompt-diff-mark" aria-label={line.kind === 'removed' ? '删除' : line.kind === 'added' ? '新增' : '未变'}>{line.kind === 'removed' ? '−' : line.kind === 'added' ? '+' : ' '}</span>
        <span>{line.text || '\u00a0'}</span>
      </li>)}
    </ol>}
    {!after && before && <Text size="xs" c="dimmed">此内容已移除。</Text>}
  </section>
}

export default function CanvasPromptSectionDiff({ block, displayName, references, disabled, onClose, onResolve }: Props) {
  const details = block ? promptSectionDetails(block, references) : undefined
  const baseline = readablePromptSection(block?.sourceText ?? '', references)
  const current = readablePromptSection(block?.deleted ? '' : block?.text ?? '', references)
  return <Modal opened={!!block} onClose={onClose} title={`${displayName || block?.name || ''} · 内容对比`} centered size="lg" zIndex={285}>
    {block && details && <Stack gap="sm">
      <Text size="xs" c="dimmed">{details.category} · 来源：{details.source} · {details.state}</Text>
      <Text size="xs" c="dimmed">− 表示删除，+ 表示新增。两组变化均与上次接受的来源内容比较。</Text>
      <WorkspaceDisclosure className="pc-prompt-diff-baseline" label="上次接受的来源内容"><pre>{baseline || '（无来源内容）'}</pre></WorkspaceDisclosure>
      <Changes label="本节点内容变化" before={baseline} after={current} />
      {block.pendingSourceText !== undefined && <Changes label="来源更新" before={baseline} after={readablePromptSection(block.pendingSourceText, references)} />}
      {details.parameters && <Text size="xs" c="dimmed">比例、清晰度等以底部生成参数为准；这里的文字仍会检查参数冲突。</Text>}
      {details.pending && onResolve && <div className="pc-prompt-source-actions">
        <Button variant="default" disabled={disabled} onClick={() => { onResolve(block.id, 'keep_custom'); onClose() }}>保留本节点修改</Button>
        <Button disabled={disabled} onClick={() => { onResolve(block.id, 'follow_source'); onClose() }}>使用来源更新</Button>
      </div>}
    </Stack>}
  </Modal>
}
