import { useEffect, useState } from 'react'
import { Button, Menu, Text } from '@mantine/core'
import { Check, ChevronDown, Copy } from 'lucide-react'
import { writePromptClipboard, type PromptClipboardContent, type PromptCopyScope } from './canvas-prompt-clipboard'

export default function CanvasPromptCopyMenu({ getContent, disabled, visualBoard }: {
  getContent: (scope: PromptCopyScope) => PromptClipboardContent | null
  disabled?: boolean
  visualBoard?: boolean
}) {
  const [state, setState] = useState<'idle' | 'copying' | 'body' | 'full' | 'failed'>('idle')
  const [opened, setOpened] = useState(false)
  const copied = state === 'body' || state === 'full'
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
  return <div className="pc-prompt-copy">
    <Menu withinPortal position="bottom-start" opened={opened} onChange={setOpened}>
      <Menu.Target><Button type="button" className="pc-composer-chip" variant="subtle" aria-label="复制提示词"
        title={state === 'failed' ? '复制失败，请选中文字后使用 Ctrl/Cmd+C' : '选择复制范围'}
        disabled={disabled || state === 'copying'} data-workspace-control=""
        leftSection={copied ? <Check size={14} /> : <Copy size={14} />} rightSection={<ChevronDown size={12} />}>
        {copied ? '已复制' : '复制'}</Button></Menu.Target>
      <Menu.Dropdown data-canvas-overlay>
        <Menu.Item aria-label="复制正文" disabled={opened && !getContent('body')?.text.trim()} leftSection={<Copy size={14} />} onClick={() => void copy('body')}>
          <Text size="xs">复制正文</Text><Text size="xs" c="dimmed">{visualBoard ? '复制设定图内容与已有正文，沿用目标节点要求' : '仅复制正文，沿用目标节点要求'}</Text>
        </Menu.Item>
        <Menu.Item aria-label="复制完整提示词" disabled={opened && !getContent('full')?.text.trim()} leftSection={<Copy size={14} />} onClick={() => void copy('full')}>
          <Text size="xs">复制完整提示词</Text><Text size="xs" c="dimmed">包含画风、参考与生成要求</Text>
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
    <span className="pc-prompt-copy-status" role="status">{state === 'body' ? '正文已复制' : state === 'full' ? '完整提示词已复制' : ''}</span>
    {state === 'failed' && <span className="pc-prompt-copy-error" role="alert">复制失败，请选中文字后使用 Ctrl/Cmd+C</span>}
  </div>
}
