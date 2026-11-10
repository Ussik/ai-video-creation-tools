import { useRef, useState } from 'react'
import { Alert, Button, Select, Text } from '@mantine/core'
import {
  applyStandardTextSettings, migrateStandardTextSettings, resolveTextApiSettings, textApiConfigError, textApiMode, textApiManagedFields, textOutputMode,
  type TextApiProtocol,
} from '@video-studio/shared/models/text-api-settings'
import { TokenQuantityInput } from './TextModelContextSettings'

type Settings = Record<string, unknown>
type Props = {
  value: string; protocol: TextApiProtocol
  onChange: (settings: Settings) => void; onError: (message: string) => void; onAdvanced: () => void
  hideManagedFields?: boolean
}

function record(value: unknown): value is Settings { return !!value && typeof value === 'object' && !Array.isArray(value) }

function restoreInterface(current: Settings, backup: Settings): Settings {
  const next = { ...current }
  for (const key of ['text_api', ...textApiManagedFields]) {
    if (Object.hasOwn(backup, key)) next[key] = backup[key]
    else delete next[key]
  }
  return next
}

function outputSummary(template: Settings, protocol: TextApiProtocol): string {
  const field = protocol === 'responses' ? 'max_output_tokens'
    : protocol === 'anthropic_messages' ? 'max_tokens' : template.max_completion_tokens !== undefined ? 'max_completion_tokens' : template.max_tokens !== undefined ? 'max_tokens' : 'max_completion_tokens'
  const cap = template[field]
  return typeof cap === 'number' && Number.isSafeInteger(cap) && cap > 0
    ? `${field} = ${cap.toLocaleString('en-US')} tokens` : '未设置最大输出，沿用接口默认（额度未知）'
}

export default function TextModelApiSettings({ value, protocol, onChange, onError, onAdvanced, hideManagedFields = false }: Props) {
  const backups = useRef<{ standard?: Settings; custom?: Settings }>({})
  const [rebuildPending, setRebuildPending] = useState(false)
  let settings: Settings
  try {
    const parsed: unknown = JSON.parse(value)
    if (!record(parsed)) throw new Error('invalid settings')
    settings = parsed
  } catch {
    return <Alert color="yellow" title="请求配置需要修正"><Text size="sm">高级配置不是有效对象，请先修正后再调整接口表单。</Text><Button variant="subtle" size="compact-sm" onClick={onAdvanced}>打开高级配置</Button></Alert>
  }
  const mode = textApiMode(settings, protocol)
  const managed = migrateStandardTextSettings(settings, protocol)
  const options = managed && record(managed.text_api) ? managed.text_api : {}
  const outputMode = textOutputMode(managed || settings)
  const issue = textApiConfigError(settings, protocol)
  let effective: Settings = settings
  try { effective = resolveTextApiSettings(managed || settings, protocol) } catch { /* Invalid visible drafts remain editable. */ }
  const template = record(effective.request_template) ? effective.request_template : {}
  const streamTemplate = record(effective.stream_request_template) ? effective.stream_request_template : template
  const outputField = protocol === 'responses' ? 'max_output_tokens'
    : protocol === 'anthropic_messages' ? 'max_tokens' : template.max_completion_tokens !== undefined ? 'max_completion_tokens'
      : template.max_tokens !== undefined ? 'max_tokens'
        : options.chat_output_field === 'max_tokens' ? 'max_tokens' : 'max_completion_tokens'
  const cap = template[outputField]
  const hasCap = typeof cap === 'number' && Number.isSafeInteger(cap) && cap > 0
  const source = mode === 'custom' ? '自定义请求模板' : record(settings.text_api) ? '模型表单' : '旧请求模板（保存时转为表单配置）'

  function change(key: string, next: unknown) {
    if (!managed) { onError('当前为自定义接口，请先明确改用标准接口'); return }
    const updated = { ...options }
    if (next === undefined || next === '') delete updated[key]
    else updated[key] = next
    if (key === 'max_output_tokens') updated.output_mode = 'fixed'
    onChange({ ...managed, text_api: updated })
  }

  function chooseMode(next: string | null) {
    if (!next || next === mode) return
    setRebuildPending(false)
    if (next === 'custom') {
      backups.current.standard = managed || settings
      const saved = backups.current.custom
      if (saved) onChange(restoreInterface(settings, saved))
      else {
        try { onChange({ ...resolveTextApiSettings(managed || settings, protocol), text_api: { mode: 'custom' } }) }
        catch (error) { onError(error instanceof Error ? error.message : String(error)); return }
      }
      onAdvanced()
    } else if (backups.current.standard) {
      backups.current.custom = settings
      onChange(restoreInterface(settings, backups.current.standard))
    } else setRebuildPending(true)
  }

  const effort = typeof options.reasoning_effort === 'string' ? options.reasoning_effort : ''
  const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  if (effort && !efforts.includes(effort)) efforts.push(effort)
  return <section className="ms-text-api-settings" aria-label="文本接口选项">
    <Select label="接口配置方式" description="标准接口由程序构造请求；特殊网关可保留自定义模板。" allowDeselect={false}
      value={mode} data={[{ value: 'standard', label: '标准接口 · 表单配置' }, { value: 'custom', label: '自定义接口 · 高级配置' }]} onChange={chooseMode} />
    {rebuildPending && <Alert color="yellow" title="改用标准接口">
      <Text size="sm">这会重新构造请求路径、输入和响应解析。上下文、能力与费用设置会保留；本次编辑中可切回原自定义配置。</Text>
      <div className="ms-text-api-actions"><Button size="compact-sm" onClick={() => {
        backups.current.custom = settings
        onChange(applyStandardTextSettings(settings, protocol))
        setRebuildPending(false)
      }}>重新构造标准接口</Button><Button variant="subtle" size="compact-sm" onClick={() => setRebuildPending(false)}>继续使用自定义接口</Button></div>
    </Alert>}
    {mode === 'standard' ? <>
      <div className="ms-field-pair">
        {!hideManagedFields && <Select label="输出模式" value={protocol === 'anthropic_messages' && outputMode === 'upstream' ? 'fixed' : outputMode} allowDeselect={false}
          data={[{ value: 'auto', label: '自动安排' }, { value: 'fixed', label: '固定额度' }, ...(protocol === 'anthropic_messages' ? [] : [{ value: 'upstream', label: '沿用服务默认' }])]}
          onChange={next => next && change('output_mode', next)} />}
        {!hideManagedFields && (outputMode === 'fixed' || protocol === 'anthropic_messages' && outputMode === 'upstream') && <TokenQuantityInput label="最大输出" description="固定额度随请求发送；不静默调低。" placeholder="填写本次请求额度"
          value={options.max_output_tokens} onChange={next => change('max_output_tokens', next)} />}
        {protocol === 'chat_completions' && <Select label="输出额度字段" description="按当前渠道支持选择兼容字段。" allowDeselect={false}
          value={options.chat_output_field === 'max_tokens' ? 'max_tokens' : 'max_completion_tokens'}
          data={[{ value: 'max_completion_tokens', label: 'max_completion_tokens' }, { value: 'max_tokens', label: 'max_tokens · 兼容接口' }]}
          onChange={next => next && change('chat_output_field', next)} />}
      </div>
      {!hideManagedFields && <div className="ms-field-pair">
        <Select label="推理强度" description="仅在渠道支持对应值时设置。" allowDeselect={false} value={effort || 'upstream'}
          data={[{ value: 'upstream', label: '沿用接口默认' }, ...efforts.map(item => ({ value: item, label: item }))]}
          onChange={next => change('reasoning_effort', next === 'upstream' ? undefined : next)} />
        <Select label="Thinking 兼容开关" description="仅为支持 thinking 参数的渠道设置。" allowDeselect={false}
          value={typeof options.thinking === 'string' ? options.thinking : 'upstream'}
          data={[{ value: 'upstream', label: '沿用接口默认' }, { value: 'enabled', label: '开启' }, { value: 'disabled', label: '关闭' }, { value: 'auto', label: '自动' }]}
          onChange={next => change('thinking', next === 'upstream' ? undefined : next)} />
      </div>}
    </> : <Text size="sm" c="dimmed">当前保留自定义请求模板。切换协议会保留模板，请在高级配置中核对该协议的路径、输入和输出字段。</Text>}
    <div className="ms-text-api-summary" aria-live="polite">
      <Text size="sm">{mode === 'standard' && outputMode === 'auto' ? '实际请求：自动安排，发送前依据已知能力和本次输入计算输出额度，不使用服务默认值。'
        : hasCap ? <>{mode === 'custom' && effective.stream_request_template !== undefined ? '非流式文本：' : '实际请求：'}<code>{outputField}</code> = {cap.toLocaleString('en-US')} tokens · 来源：{source}</>
        : mode === 'standard' && (outputMode === 'fixed' || protocol === 'anthropic_messages') ? '最大输出尚未有效填写，请修正后保存。'
          : '实际请求：未设置最大输出，沿用接口默认（额度未知）。'}</Text>
      {mode === 'custom' && effective.stream_request_template !== undefined && <Text size="sm">流式 / 工具调用：{outputSummary(streamTemplate, protocol)}。上方请求额度用于非流式文本。</Text>}
      <Text size="xs" c="dimmed">固定或自动额度会随请求发送；沿用服务默认时省略输出参数。渠道是否支持，需以渠道文档或实际响应为准。</Text>
      {settings.context_window_tokens !== undefined && !hasCap && outputMode === 'upstream' && settings.output_reserve_tokens === undefined && <Text size="xs" c="orange">已填写历史共享上下文。服务默认输出未知，无法完成共享窗口预留检查；可选固定额度或自动安排。</Text>}
    </div>
    {issue && <Alert color="red" title="接口参数需要修正">{issue}</Alert>}
  </section>
}
