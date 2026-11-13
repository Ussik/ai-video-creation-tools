import { useState } from 'react'
import { Text, TextInput } from '@mantine/core'
import { formatTokenQuantity, parseTokenQuantity } from './token-quantity'

type Props = { value: string; onChange: (settings: Record<string, unknown>) => void; onError: (message: string) => void; section?: 'capacity' | 'reserve' | 'all' }

export function TokenQuantityInput({ value, onChange, label, description, placeholder }: {
  value: unknown; onChange: (value: string | number) => void; label: string; description: string; placeholder: string
}) {
  const [draft, setDraft] = useState<{ source: unknown; text: string } | null>(null)
  const text = draft && Object.is(draft.source, value) ? draft.text
    : typeof value === 'number' ? formatTokenQuantity(value) || String(value) : typeof value === 'string' ? value : ''
  const invalid = text.trim() !== '' && parseTokenQuantity(text) === null
  return <TextInput className="ms-context-field" label={label} description={description} placeholder={placeholder}
    inputWrapperOrder={['label', 'input', 'description', 'error']} autoComplete="off" spellCheck={false}
    rightSection={<Text component="span" className="ms-context-unit">tokens</Text>} rightSectionWidth={62}
    error={invalid ? '请输入正整数或 K / M 单位，如 128K、1M' : undefined} value={text}
    onChange={event => {
      const raw = event.currentTarget.value
      // Retain invalid input in the settings draft so save validation cannot
      // silently submit the last valid capacity instead of the visible value.
      const next = raw.trim() === '' ? '' : parseTokenQuantity(raw) ?? raw
      setDraft({ source: next === '' ? undefined : next, text: raw })
      onChange(next)
    }} onBlur={() => setDraft(null)} />
}

export default function TextModelContextSettings({ value, onChange, onError, section = 'all' }: Props) {
  let settings: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>
  } catch { /* Keep the advanced JSON editable; changes below explain invalid JSON. */ }
  function change(key: 'context_window_tokens' | 'output_reserve_tokens', next: string | number) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid settings')
      const updated = { ...parsed as Record<string, unknown> }
      if (next === '') delete updated[key]
      else updated[key] = next
      onChange(updated)
    } catch { onError('请先修正请求配置 JSON，再调整模型容量') }
  }
  return <div className="ms-context-settings">
    <div className="ms-field-pair ms-context-fields">
      {section !== 'reserve' && <TokenQuantityInput label="上下文容量" description="历史共享窗口配置；新模型请在模型与渠道能力中设置。" placeholder="未知时留空"
        value={settings.context_window_tokens} onChange={next => change('context_window_tokens', next)} />}
      {section !== 'capacity' && <TokenQuantityInput label="输出预留" description="历史兼容：仅在未设置实际最大输出时用于本地容量估算，不发送给接口。" placeholder="未配置时不预设额度"
        value={settings.output_reserve_tokens} onChange={next => change('output_reserve_tokens', next)} />}
    </div>
    <Text className="ms-context-help" size="xs" c="dimmed">支持 K / M 单位，1K = 1,000 tokens，1M = 1,000,000 tokens。</Text>
    {section !== 'reserve' && <Text className="ms-context-status" size="xs" c="dimmed">{settings.context_window_tokens === undefined
      ? '当前未配置模型容量，无法在发送前判断是否超限。长篇剧本建议先填写厂商提供的限制。'
      : '发送前会估算完整输入（含工具和历史），并优先按实际输出上限预留。估算不等于厂商精确分词；超限时保留内容并停止请求。'}</Text>}
  </div>
}
