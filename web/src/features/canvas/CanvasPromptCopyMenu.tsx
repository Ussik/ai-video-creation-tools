import { useEffect, useState } from 'react'
import { ActionIcon, Button, Menu, Text } from '@mantine/core'
import { Check, ChevronDown, Copy } from 'lucide-react'
import { writePromptClipboard, type PromptClipboardContent, type PromptCopyScope } from './canvas-prompt-clipboard'

export default function CanvasPromptCopyMenu({ getContent, disabled, visualBoard, onCopyNode }: {
  getContent: (scope: PromptCopyScope) => PromptClipboardContent | null
  disabled?: boolean
  visualBoard?: boolean
  onCopyNode?: () => Promise<void>
}) {
  const [state, setState] = useState<'idle' | 'copying' | 'node' | 'body' | 'full' | 'failed'>('idle')
  const [opened, setOpened] = useState(false)
  const copied = state === 'node' || state === 'body' || state === 'full'
  useEffect(() => {
    if (!copied) return
    const timeout = window.setTimeout(() => setState('idle'), 2400)
    return () => window.clearTimeout(timeout)
  }, [state, copied])
  async function copy(scope: PromptCopyScope) {
    const content = getContent(scope)
    if (!content?.text) return
    setState('copying')
    try { await writePromptClipboard(content); setState(scope) }
    catch { setState('failed') }
  }
  async function copyNode() {
    if (!onCopyNode) return
    setState('copying')
    try { await onCopyNode(); setState('node') }
    catch { setState('failed') }
  }
  return <div className="pc-prompt-copy">
    {onCopyNode && <Button type="button" className="pc-composer-chip" variant="subtle" aria-label="复制节点"
      title="复制整个节点，可在本项目的其他画布粘贴" disabled={disabled || state === 'copying'} data-workspace-control=""
      leftSection={state === 'node' ? <Check size={14} /> : <Copy size={14} />} onClick={() => void copyNode()}>
      {state === 'node' ? '已复制节点' : '复制节点'}</Button>}
    <Menu withinPortal position="bottom-start" opened={opened} onChange={setOpened}>
      <Menu.Target>{onCopyNode ? <ActionIcon type="button" variant="subtle" aria-label="更多复制选项" title="复制正文或完整提示词"
        disabled={disabled || state === 'copying'} data-workspace-control=""><ChevronDown size={12} /></ActionIcon> : <Button type="button" className="pc-composer-chip" variant="subtle" aria-label="复制提示词"
        title={state === 'failed' ? '复制失败，请选中文字后使用 Ctrl/Cmd+C' : '选择复制范围'}
        disabled={disabled || state === 'copying'} data-workspace-control=""
        leftSection={copied ? <Check size={14} /> : <Copy size={14} />} rightSection={<ChevronDown size={12} />}>
        {copied ? '已复制' : '复制'}</Button>}</Menu.Target>
      <Menu.Dropdown data-canvas-overlay>
        <Menu.Item aria-label="复制正文" disabled={opened && !getContent('body')?.text.trim()} leftSection={<Copy size={14} />} onClick={() => void copy('body')}>
          <Text size="xs">复制正文</Text><Text size="xs" c="dimmed">{visualBoard ? '复制设定图内容与已有正文，沿用目标节点要求' : '仅复制正文，沿用目标节点要求'}</Text>
        </Menu.Item>
        <Menu.Item aria-label="复制完整提示词" disabled={opened && !getContent('full')?.text.trim()} leftSection={<Copy size={14} />} onClick={() => void copy('full')}>
          <Text size="xs">复制完整提示词</Text><Text size="xs" c="dimmed">包含画风、参考与生成要求</Text>
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
    <span className="pc-prompt-copy-status" role="status">{state === 'node' ? '节点已复制，切换画布后按 Ctrl/Cmd+V 粘贴' : state === 'body' ? '正文已复制' : state === 'full' ? '完整提示词已复制' : ''}</span>
    {state === 'failed' && <span className="pc-prompt-copy-error" role="alert">{onCopyNode
      ? '复制失败，请在画布选中节点后使用 Ctrl/Cmd+C' : '复制失败，请选中文字后使用 Ctrl/Cmd+C'}</span>}
  </div>
}
