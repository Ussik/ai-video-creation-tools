import { useRef, useState, type ReactNode } from 'react'
import { Accordion, Button, Modal, Text } from '@mantine/core'
import { ChevronRight, FileText, SlidersHorizontal } from 'lucide-react'
import type { CanvasPromptReference } from './CanvasPromptEditor'
import type { PromptRequirementEntry } from './canvas-prompt-requirements'
import { promptSectionDetails, readablePromptSection } from './canvas-prompt-section-details'
import { promptPreviewText } from './canvas-prompt-preview'
import CanvasPromptSectionDiff from './CanvasPromptSectionDiff'

type Props = {
  entries: PromptRequirementEntry[]
  onEdit: (id: string) => void
  onResolve?: (id: string, choice: 'keep_custom' | 'follow_source') => void
  onEditParameters?: () => void
  disabled: boolean
  references: CanvasPromptReference[]
  parameterSummary?: string
  fullPrompt: string
  sourceRecord?: ReactNode
}

export default function CanvasPromptRequirements(props: Props) {
  const [opened, setOpened] = useState(false)
  const [preview, setPreview] = useState(false)
  const [comparingId, setComparingId] = useState<string>()
  const trigger = useRef<HTMLButtonElement>(null)
  function closeFixed() { setOpened(false); trigger.current?.focus() }
  const visible = props.entries.filter(entry => entry.status === 'active' && !entry.primary && entry.block)
  const comparing = visible.find(entry => entry.id === comparingId)?.block
  const pending = visible.filter(entry => entry.block?.pendingSourceText !== undefined).length
  const fullText = promptPreviewText(props.fullPrompt).replace(/\[\[ref:([^\]]+)\]\]/g,
    (_, id: string) => `@${props.references.find(reference => reference.assetId === id)?.label || '原参考图片'}`)
  return <>
    <footer className="pc-prompt-requirements-footer" contentEditable={false}>
      <section className="pc-prompt-fixed-summary" aria-label="固定设定摘要">
        <Button ref={trigger} size="compact-xs" variant="subtle" color="gray" leftSection={<SlidersHorizontal size={14} />} rightSection={<ChevronRight size={13} />} aria-label="查看固定设定" disabled={!visible.length}
          onClick={() => setOpened(true)}>设定与要求 · {visible.length} 项{pending > 0 && <span className="pc-prompt-fixed-pending">{pending} 项待确认</span>}</Button>
      </section>
      <div className="pc-prompt-requirements-tools">
        <Button size="compact-xs" variant="subtle" color="gray" leftSection={<FileText size={14} />} onClick={() => setPreview(true)}>预览完整提示词</Button>
        {props.sourceRecord}
      </div>
    </footer>
    <Modal opened={opened} onClose={closeFixed} title="固定设定" centered size="lg" zIndex={280} returnFocus={false}
      closeButtonProps={{ 'aria-label': '关闭固定设定' }} className="pc-prompt-fixed-dialog" onKeyDown={event => { if (event.key !== 'Tab') event.stopPropagation() }}>
      <Text size="xs" c="dimmed" mb="md">{visible.length} 项参与本次生成 · 整理正文时原样保留</Text>
      <Accordion multiple defaultValue={visible[0] ? [visible[0].id] : []} chevronPosition="right" className="pc-prompt-fixed-list">
        {visible.map(entry => {
          const block = entry.block!, details = promptSectionDetails(block, props.references)
          return <Accordion.Item key={entry.id} value={entry.id}>
            <Accordion.Control aria-label={`查看要求：${entry.name} · ${entry.id}`}><span>{entry.name}</span>{details.pending && <span className="pc-prompt-fixed-pending">待确认来源更新</span>}</Accordion.Control>
            <Accordion.Panel>
              <Text size="xs" c="dimmed">来源：{details.source} · {details.state}</Text>
              <pre className="pc-prompt-fixed-content" aria-label={`${entry.name}只读内容`}>{readablePromptSection(block.text, props.references)}</pre>
              <div className="pc-prompt-fixed-actions">
                <Button size="compact-xs" color="gray" variant="subtle" onClick={() => { setOpened(false); setComparingId(entry.id) }}>查看与来源的差异</Button>
                {entry.name === '生成参数约束' && props.onEditParameters
                  ? <Button size="compact-xs" variant="default" disabled={props.disabled} onClick={() => { setOpened(false); props.onEditParameters?.() }}>调整生成参数</Button>
                  : <Button size="compact-xs" variant="default" disabled={props.disabled} aria-label={`单独编辑要求：${entry.name} · ${entry.id}`}
                    onClick={() => { setOpened(false); props.onEdit(entry.id) }}>单独编辑此项</Button>}
              </div>
            </Accordion.Panel>
          </Accordion.Item>
        })}
      </Accordion>
      <div className="pc-prompt-fixed-dialog-footer"><Text size="xs" c="dimmed">只读查看，不参与整理草稿编辑</Text><Button variant="default" size="xs" onClick={closeFixed}>返回正文</Button></div>
    </Modal>
    <Modal opened={preview} onClose={() => setPreview(false)} title="完整提示词预览" centered size="lg" zIndex={280}
      closeButtonProps={{ 'aria-label': '关闭完整提示词预览' }} onKeyDown={event => { if (event.key !== 'Tab') event.stopPropagation() }}>
      <Text size="xs" c="dimmed" mb="md">当前正文与全部生效要求，按实际生成顺序组合。</Text>
      <pre className="pc-prompt-full-preview">{fullText}</pre>
    </Modal>
    <CanvasPromptSectionDiff block={comparing} references={props.references} disabled={props.disabled} onResolve={props.onResolve} onClose={() => setComparingId(undefined)} />
  </>
}
