import { NumberInput, Text } from '@mantine/core'

type Props = { value: string; onChange: (settings: Record<string, unknown>) => void; onError: (message: string) => void }

export default function TextModelContextSettings({ value, onChange, onError }: Props) {
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
      else updated[key] = typeof next === 'number' ? next : Number(next)
      onChange(updated)
    } catch { onError('请先修正请求配置 JSON，再调整模型容量') }
  }
  return <>
    <div className="ms-field-pair">
      <NumberInput label="上下文容量（tokens）" description="按厂商确认的输入与输出合计容量填写；未知时留空" placeholder="未配置" min={1} max={Number.MAX_SAFE_INTEGER} allowDecimal={false} allowNegative={false} thousandSeparator="," hideControls
        value={typeof settings.context_window_tokens === 'number' ? settings.context_window_tokens : ''} onChange={next => change('context_window_tokens', next)} />
      <NumberInput label="输出预留（tokens）" description="请求模板没有输出上限时，用此值为输出预留容量；不改变实际输出参数" placeholder="按厂商输出限制填写" min={1} max={Number.MAX_SAFE_INTEGER} allowDecimal={false} allowNegative={false} thousandSeparator="," hideControls
        value={typeof settings.output_reserve_tokens === 'number' ? settings.output_reserve_tokens : ''} onChange={next => change('output_reserve_tokens', next)} />
    </div>
    <Text size="xs" c="dimmed">{settings.context_window_tokens === undefined
      ? '当前未配置模型容量，无法在发送前判断是否超限。长篇剧本建议先填写厂商提供的限制。'
      : '发送前会估算完整输入（含工具和历史），并优先按请求模板的实际输出上限预留。估算不等于厂商精确分词；超限时保留内容并停止请求。'}</Text>
  </>
}
