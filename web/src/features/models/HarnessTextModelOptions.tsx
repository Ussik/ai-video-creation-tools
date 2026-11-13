import { useState } from 'react'
import { ActionIcon, Alert, Badge, Button, Checkbox, Select, Switch, Text, TextInput, Tooltip } from '@mantine/core'
import { CircleHelp, Plus, Trash2 } from 'lucide-react'
import {
  migrateStandardTextSettings, standardTextSettings, textApiConfigError, textApiManagedFields, textOutputMode,
  type TextApiProtocol,
} from '@video-studio/shared/models/text-api-settings'
import { resolveTextCapabilities, scopeTextCapabilities, textCapabilitiesConfigError, type TextCapabilityScope, type TextModelLimits } from '@video-studio/shared/models/text-capabilities'
import { formatTokenQuantity, parseTokenQuantity } from './token-quantity'
import './harness-text-model-options.css'

type Settings = Record<string, unknown>
type Props = { settings: Settings; protocol: TextApiProtocol; onChange: (settings: Settings) => void; disabled?: boolean; scope?: TextCapabilityScope }
type Level = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type ReasoningRow = Settings & { level: string; api_value: string }
const levels: Level[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
function record(value: unknown): value is Settings { return !!value && typeof value === 'object' && !Array.isArray(value) }
function visibleCapabilities(settings: Settings) {
  try { return resolveTextCapabilities(settings) }
  catch {
    const config = record(settings.text_capabilities) ? settings.text_capabilities : {}
    const override = record(config.override) ? { ...config.override } : {}
    for (const key of ['context_tokens', 'input_tokens', 'output_tokens']) {
      if (override[key] !== undefined && (typeof override[key] !== 'number' || !Number.isSafeInteger(override[key]) || override[key] <= 0)) delete override[key]
    }
    try { return resolveTextCapabilities({ ...settings, text_capabilities: { ...config, override } }) }
    catch { return resolveTextCapabilities({}) }
  }
}

function QuantityInput({ value, onChange, label, placeholder, description, disabled, required = false }: {
  value: unknown; onChange: (value: string | number | undefined) => void; label: string; placeholder: string; description?: string; disabled?: boolean; required?: boolean
}) {
  const [draft, setDraft] = useState<{ source: unknown; text: string } | null>(null)
  const text = draft && Object.is(draft.source, value) ? draft.text
    : typeof value === 'number' ? formatTokenQuantity(value) || String(value) : typeof value === 'string' ? value : ''
  const invalid = text.trim() !== '' && parseTokenQuantity(text) === null
  return <TextInput label={label} placeholder={placeholder} description={description} inputWrapperOrder={['label', 'input', 'description', 'error']} value={text} disabled={disabled} required={required}
    autoComplete="off" spellCheck={false} inputMode="text"
    error={invalid ? '请输入正整数或 K / M 单位' : required && !text.trim() ? '请填写最大输出 token 数' : undefined}
    onChange={event => {
      const raw = event.currentTarget.value
      const next = raw.trim() === '' ? undefined : parseTokenQuantity(raw) ?? raw
      setDraft({ source: next, text: raw }); onChange(next)
    }} onBlur={() => setDraft(null)} />
}

function reasoningView(api: Settings) {
  const existing = record(api.reasoning) ? api.reasoning : undefined
  if (existing) return {
    source: existing, enabled: existing.enabled === true,
    defaultLevel: typeof existing.default_level === 'string' ? existing.default_level : 'medium',
    rows: Array.isArray(existing.levels) ? existing.levels.map(value => {
      const row = record(value) ? value : {}
      return { ...row, level: typeof row.level === 'string' ? row.level : '', api_value: typeof row.api_value === 'string' ? row.api_value : '' }
    }) : [],
  }
  const rows: ReasoningRow[] = [{ level: 'off', api_value: '' }, { level: 'low', api_value: 'low' },
    { level: 'medium', api_value: 'medium' }, { level: 'high', api_value: 'high' },
    { level: 'xhigh', api_value: 'xhigh' }, { level: 'max', api_value: 'max' }]
  const effort = typeof api.reasoning_effort === 'string' ? api.reasoning_effort : ''
  const defaultLevel = api.thinking === 'disabled' ? 'off' : levels.includes(effort as Level) ? effort : effort ? 'high' : 'medium'
  if (effort && !rows.some(row => row.level === defaultLevel)) rows.push({ level: defaultLevel, api_value: effort })
  else if (effort && defaultLevel !== 'off') rows.find(row => row.level === defaultLevel)!.api_value = effort
  return { source: {}, enabled: !!effort || api.thinking !== undefined, defaultLevel, rows }
}

/** The familiar provider form edits managed options. Unknown request contracts
 * stay read-only here and retain their complete advanced configuration. */
export default function HarnessTextModelOptions({ settings, protocol, onChange, disabled = false, scope }: Props) {
  const scopedSettings = scope ? scopeTextCapabilities(settings, scope) : settings
  const migrated = migrateStandardTextSettings(scopedSettings, protocol)
  const pristine = settings.text_api === undefined && textApiManagedFields.every(key => settings[key] === undefined)
  const managed = migrated || (pristine ? { ...settings, ...standardTextSettings(protocol) } : null)
  const api = managed && record(managed.text_api) ? managed.text_api : {}
  const custom = !managed
  const template = record(settings.request_template) ? settings.request_template : {}
  const output = custom ? template.max_output_tokens ?? template.max_completion_tokens ?? template.max_tokens : api.max_output_tokens
  const validOutput = typeof output === 'number' && Number.isSafeInteger(output) && output > 0
  const outputField = protocol === 'responses' ? 'max_output_tokens' : protocol === 'anthropic_messages' ? 'max_tokens' : api.chat_output_field ?? 'max_completion_tokens'
  const outputMode = custom ? validOutput ? 'fixed' : 'upstream' : textOutputMode(managed || settings)
  const visibleOutputMode = protocol === 'anthropic_messages' && outputMode === 'upstream' && !custom ? 'fixed' : outputMode
  const capabilities = visibleCapabilities(scopedSettings)
  const capabilityIssue = textCapabilitiesConfigError(scopedSettings)
  const capabilityConfig = record(scopedSettings.text_capabilities) ? scopedSettings.text_capabilities : {}
  const discovered = record(capabilityConfig.discovered) ? capabilityConfig.discovered : {}
  const overrides = record(capabilityConfig.override) ? capabilityConfig.override : {}
  const sources = { override: '手动覆盖', provider: '提供商目录', legacy: '历史手工配置', unknown: '未知' }
  const budgetMode = capabilities.limits.budget_mode
  const capacityKey = budgetMode === 'shared' ? 'context_tokens' : 'input_tokens'
  const capabilityValue = (key: keyof TextModelLimits) => Object.hasOwn(overrides, key) ? overrides[key] : capabilities.limits[key]
  const sourceLabel = (key: keyof TextModelLimits) => `来源：${sources[Object.hasOwn(overrides, key) ? 'override' : capabilities.sources[key] || 'unknown']}`
  const reasoning = reasoningView(api)
  const nextLevel = levels.find(level => !reasoning.rows.some(row => row.level === level))
  const requestIssue = !custom ? textApiConfigError(scope ? scopeTextCapabilities(managed || settings, scope) : managed || settings, protocol) : null

  function changeShared(key: string, value: unknown) {
    const next = { ...settings }
    if (value === undefined) delete next[key]
    else next[key] = value
    onChange(next)
  }
  function changeApi(key: string, value: unknown) {
    if (!managed) return
    const next = { ...api }
    if (value === undefined) delete next[key]
    else next[key] = value
    onChange({ ...managed, text_api: next })
  }
  function changeCapability(key: keyof TextModelLimits, value: unknown) {
    const nextOverride: Settings = { ...(!capabilities.configured && capabilities.source === 'legacy' ? capabilities.limits : {}), ...overrides }
    if (value === undefined) delete nextOverride[key]
    else nextOverride[key] = value
    onChange({ ...settings, text_capabilities: { ...capabilityConfig, version: 1, override: nextOverride } })
  }
  function changeReasoning(changes: { enabled?: boolean; default_level?: string; levels?: ReasoningRow[] }) {
    changeApi('reasoning', { ...reasoning.source, enabled: reasoning.enabled, default_level: reasoning.defaultLevel,
      levels: reasoning.rows, ...changes })
  }
  function changeRow(index: number, changes: Partial<ReasoningRow>) {
    const previous = reasoning.rows[index]!
    const next = { ...previous, ...changes }
    if (next.level === 'off') next.api_value = ''
    changeReasoning({ levels: reasoning.rows.map((row, position) => position === index ? next : row),
      ...(reasoning.defaultLevel === previous.level && next.level !== previous.level ? { default_level: next.level } : {}) })
  }

  return <section className="harness-text-options" aria-label="文本模型能力">
    <div className="harness-text-capability-section">
      <div className="harness-text-section-heading"><Text component="span" className="harness-text-field-label">模型与渠道能力</Text>
        <div className="harness-text-capability-actions"><Badge variant="light" color="gray" size="sm">{sources[capabilities.source]}</Badge>
          {Object.keys(overrides).length > 0 && <Button variant="subtle" color="gray" size="compact-xs" disabled={disabled}
            onClick={() => { const next = { ...capabilityConfig }; delete next.override; const restored = { ...settings }; if (next.discovered) restored.text_capabilities = next; else delete restored.text_capabilities; onChange(restored) }}>{capabilityConfig.discovered ? '恢复发现值' : '清除手动覆盖'}</Button>}</div>
      </div>
      {typeof discovered.fetched_at === 'string' && <Text size="xs" c="dimmed">目录获取时间：{new Date(discovered.fetched_at).toLocaleString('zh-CN')}。目录信息仅适用于当前地址、协议和模型。</Text>}
      <Select label="容量计算方式" value={budgetMode} allowDeselect={false} disabled={disabled}
        description={sourceLabel('budget_mode')} inputWrapperOrder={['label', 'input', 'description', 'error']}
        data={[{ value: 'unknown', label: '未知 · 仅检查已知限制' }, { value: 'shared', label: '输入与输出共享上下文' }, { value: 'separate', label: '输入与输出独立限制' }]}
        onChange={value => value && changeCapability('budget_mode', value)} />
      <div className="harness-text-capacities">
        <QuantityInput label={budgetMode === 'shared' ? '上下文窗口' : '最大输入 token 数'}
          placeholder="未知时留空" value={capabilityValue(capacityKey)}
          description={sourceLabel(capacityKey) + (budgetMode === 'unknown' ? '；预算关系未知' : '')} disabled={disabled}
          onChange={value => changeCapability(capacityKey, value)} />
        <QuantityInput label="模型最大输出 token 数" placeholder="渠道未提供时留空" value={capabilityValue('output_tokens')}
          description={sourceLabel('output_tokens')} disabled={disabled} onChange={value => changeCapability('output_tokens', value)} />
      </div>
      {budgetMode === 'unknown' && typeof capabilities.limits.context_tokens === 'number' && <Text size="xs" c="dimmed">渠道报告上下文窗口 {capabilities.limits.context_tokens.toLocaleString('en-US')} tokens；输入与输出的预算关系尚未确认。</Text>}
      <Select label="输出额度是否包含推理 token" value={capabilityValue('output_includes_reasoning') === true ? 'yes' : capabilityValue('output_includes_reasoning') === false ? 'no' : 'unknown'}
        data={[{ value: 'unknown', label: '未知' }, { value: 'yes', label: '包含 · 正文与推理共同消耗' }, { value: 'no', label: '不包含' }]} allowDeselect={false} disabled={disabled}
        description={sourceLabel('output_includes_reasoning')} inputWrapperOrder={['label', 'input', 'description', 'error']}
        onChange={value => changeCapability('output_includes_reasoning', value === 'unknown' ? undefined : value === 'yes')} />
      <Select label="渠道输入计数" value={typeof settings.text_token_counter === 'string' ? settings.text_token_counter : 'disabled'} allowDeselect={false} disabled={disabled}
        data={[{ value: 'disabled', label: '不启用' }, { value: 'responses', label: 'Responses 输入计数', disabled: protocol !== 'responses' }, { value: 'anthropic_messages', label: 'Messages 输入计数', disabled: protocol !== 'anthropic_messages' }]}
        description="接近容量边界时向当前渠道计数；渠道不支持时回退到本地估算。" inputWrapperOrder={['label', 'input', 'description', 'error']}
        onChange={value => changeShared('text_token_counter', value === 'disabled' ? undefined : value)} />
      {scope && record(settings.text_capabilities) && !!settings.text_capabilities.discovered && !capabilityConfig.discovered && <Text size="xs" c="orange">地址、协议或模型已改变，原目录能力暂不适用，请重新获取可用模型。</Text>}
      {capabilityIssue && <Alert color="red">{capabilityIssue}</Alert>}
    </div>
    <div className="harness-text-request-section">
      <Text component="span" className="harness-text-field-label">单次请求输出</Text>
      <div className="harness-text-capacities">
        <Select label="输出模式" value={visibleOutputMode} allowDeselect={false} disabled={disabled || custom}
          data={[{ value: 'auto', label: '自动安排' }, { value: 'fixed', label: '固定额度' }, ...(protocol === 'anthropic_messages' && !custom ? [] : [{ value: 'upstream', label: '沿用服务默认' }])]}
          onChange={value => value && changeApi('output_mode', value)} />
        <QuantityInput label="最大输出 token 数" placeholder={visibleOutputMode === 'fixed' ? '填写本次请求额度' : visibleOutputMode === 'auto' ? '由请求计划计算' : '不发送输出参数'} value={visibleOutputMode === 'fixed' || custom ? output : undefined}
          disabled={disabled || custom || visibleOutputMode !== 'fixed'} required={visibleOutputMode === 'fixed' && !custom}
          onChange={value => { if (!managed) return; const next: Settings = { ...api, output_mode: 'fixed' }; if (value === undefined) delete next.max_output_tokens; else next.max_output_tokens = value; onChange({ ...managed, text_api: next }) }} />
      </div>
      {!custom && <div className="harness-text-output-summary" aria-live="polite">
        <Text size="xs" c={visibleOutputMode === 'fixed' && !validOutput ? 'orange' : 'dimmed'}>{visibleOutputMode === 'auto'
          ? '自动安排会结合已知能力和本次输入计算并发送输出额度；能力未知时需补充配置或提供任务额度。'
          : visibleOutputMode === 'upstream' ? '不发送输出参数，由服务决定默认额度；默认值未知时无法保证长文完整输出。'
            : validOutput ? <>实际请求最大输出：{output.toLocaleString('en-US')} tokens（{String(outputField)}），固定额度不会静默调低。</>
              : '最大输出尚未有效填写，请修正后保存。'}</Text>
        {outputMode === 'upstream' && typeof settings.output_reserve_tokens === 'number' && <Text size="xs" c="dimmed">历史容量预留 {settings.output_reserve_tokens.toLocaleString('en-US')} tokens 仅用于估算，不会提高实际输出长度。</Text>}
      </div>}
      {requestIssue && <Alert color="red">{requestIssue}</Alert>}
    </div>
    <div className="harness-text-input-types">
      <Text component="span" className="harness-text-field-label">输入类型</Text>
      <div className="harness-text-input-choices">
        <Checkbox label="文本" checked disabled size="sm" />
        <Checkbox label="图片" checked={settings.supports_vision === true} disabled={disabled} size="sm"
          onChange={event => changeShared('supports_vision', event.currentTarget.checked)} />
      </div>
    </div>
    <div className="harness-text-reasoning">
      <div className="harness-text-reasoning-heading">
        <div className="harness-text-reasoning-title">
          <Text component="span" className="harness-text-field-label">推理等级</Text>
          <Tooltip label="默认档位用于模型请求。off 发送协议的关闭参数：OpenAI effort=none，Anthropic thinking=disabled；其他档位使用填写的 API 值。" multiline w={260}>
            <ActionIcon variant="transparent" color="gray" size="xs" aria-label="推理等级说明"><CircleHelp size={14} /></ActionIcon>
          </Tooltip>
        </div>
        <Switch aria-label="启用推理等级" checked={reasoning.enabled} disabled={disabled || custom}
          onChange={event => changeReasoning({ enabled: event.currentTarget.checked })} size="sm" />
      </div>
      {reasoning.enabled && <div className="harness-text-reasoning-fields">
        <div className="harness-text-reasoning-columns" aria-hidden="true"><span>档位</span><span>API 参数值</span><span /></div>
        {reasoning.rows.map((row, index) => <div className="harness-text-reasoning-row" key={index}>
          <Select aria-label={`推理档位 ${index + 1}`} value={row.level || null} placeholder="选择档位" allowDeselect={false}
            data={[...levels, ...(row.level && !levels.includes(row.level as Level) ? [row.level] : [])].map(level => ({ value: level, label: level,
              disabled: reasoning.rows.some((other, position) => position !== index && other.level === level) }))}
            disabled={disabled || custom} onChange={value => value && changeRow(index, { level: value })} />
          <TextInput aria-label={`API 参数值 ${index + 1}`} value={row.level === 'off' ? '' : row.api_value}
            placeholder={row.level === 'off' ? '关闭思考' : row.level || '参数值'} disabled={disabled || custom || row.level === 'off'}
            error={row.level !== 'off' && !row.api_value.trim() ? '请输入 API 参数值' : undefined}
            onChange={event => changeRow(index, { api_value: event.currentTarget.value })} />
          <ActionIcon aria-label={`删除推理档位 ${index + 1}`} variant="subtle" color="gray" disabled={disabled || custom}
            onClick={() => {
              const rows = reasoning.rows.filter((_, position) => position !== index)
              changeReasoning({ levels: rows, ...(reasoning.defaultLevel === row.level ? { default_level: rows[0]?.level || 'off' } : {}) })
            }}><Trash2 size={15} /></ActionIcon>
        </div>)}
        <Button className="harness-text-add-level" variant="default" leftSection={<Plus size={14} />} disabled={disabled || custom || !nextLevel}
          onClick={() => nextLevel && changeReasoning({ levels: [...reasoning.rows, { level: nextLevel, api_value: nextLevel === 'off' ? '' : nextLevel }] })}>添加档位</Button>
        <Select label="默认档位" value={reasoning.defaultLevel} allowDeselect={false} disabled={disabled || custom || !reasoning.rows.length}
          data={[...new Set(reasoning.rows.map(row => row.level).filter(Boolean))]}
          onChange={value => value && changeReasoning({ default_level: value })} />
      </div>}
    </div>
    {custom && <Text size="xs" c="dimmed" className="harness-text-custom-note">自定义请求参数请在高级设置中修改。</Text>}
  </section>
}
