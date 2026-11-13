import { useState } from 'react'
import { Accordion, ActionIcon, Alert, Button, Modal, SegmentedControl, Select, Switch, Textarea, TextInput, Tooltip } from '@mantine/core'
import { Braces, Plus, Save, Trash2 } from 'lucide-react'
import type { Model, Modality, Protocol, Provider } from '../../shared/api/api'
import { imageRatios } from '../canvas/canvas-model-parameters'
import { documentedImageConfigError, documentedImageProfile, documentedImageSettings } from '@video-studio/shared/models/documented-images-api'
import { videoRatios, videoResolutions } from '@video-studio/shared/media/video-parameters'
import { textContextConfigError } from '@video-studio/shared/models/text-context-settings'
import { scopeTextCapabilities, textCapabilitiesConfigError } from '@video-studio/shared/models/text-capabilities'
import { migrateStandardTextSettings, standardTextSettings, textApiConfigError, type TextApiProtocol } from '@video-studio/shared/models/text-api-settings'
import { videoModelConfigError } from '@video-studio/shared/models/video-model-settings'
import { imageAnalysisConfigError } from '@video-studio/shared/models/image-analysis-settings'
import { videoInputConfigError } from '@video-studio/shared/models/video-analysis-settings'
import ImageModelConfig from './ImageModelConfig'
import ImageAnalysisModelSettings from './ImageAnalysisModelSettings'
import TextModelContextSettings from './TextModelContextSettings'
import TextModelApiSettings from './TextModelApiSettings'
import HarnessTextModelOptions from './HarnessTextModelOptions'
import VideoModelConfig from './VideoModelConfig'

type ModelDraft = Pick<Model, 'provider_id' | 'name' | 'remote_id' | 'modality' | 'protocol'> & {settings:string}
type ResolutionPrice = { id: number; resolution: string; rate: string }
type PricingDraft = {
  enabled: boolean
  currency: string
  per_generation: string
  per_image: string
  per_second: string
  resolutions: ResolutionPrice[]
}



const protocolLabels: Record<Protocol, string> = {
  responses: 'Responses',
  anthropic_messages: 'Anthropic Messages',
  chat_completions: 'Chat Completions',
  image_generations: 'Images API',
  async_video: 'Async Video',
}

const protocolsFor: Record<Modality, Protocol[]> = {
  text: ['responses', 'chat_completions', 'anthropic_messages'],
  image: ['image_generations'],
  video: ['async_video'],
}

const modalityLabels: Record<Modality, string> = { text: '文本', image: '图片', video: '视频' }


const starterSettings: Record<Protocol, Record<string, unknown>> = {
  responses: standardTextSettings('responses'),
  anthropic_messages: standardTextSettings('anthropic_messages'),
  chat_completions: standardTextSettings('chat_completions'),
  image_generations: documentedImageSettings({
    ratios: imageRatios,
    default_ratio: '1:1',
  }),
  async_video: {
    create_path: 'contents/generations/tasks',
    get_path: 'contents/generations/tasks/{id}',
    request_template: { model: '{{model}}', content: '{{content}}', duration: '{{duration}}', ratio: '{{ratio}}', resolution: '{{resolution}}' },
    content_template: [{ type: 'text', text: '{{prompt}}' }],
    id_path: 'id', status_path: 'status', result_path: 'content.video_url',
    ratios: videoRatios, resolutions: videoResolutions, default_resolution: '480p',
  },
}

function formattedSettings(settings: Record<string, unknown>): string {
  return JSON.stringify(settings, null, 2)
}

function parsedSettings(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模型配置必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function priceString(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

function pricingFromSettings(settings: Record<string, unknown>): PricingDraft {
  const pricing = isRecord(settings.pricing) ? settings.pricing : null
  const configured = Array.isArray(settings.resolutions) ? settings.resolutions.filter((item): item is string => typeof item === 'string') : []
  const saved = isRecord(pricing?.per_second_by_resolution) ? pricing.per_second_by_resolution : {}
  const resolutionNames = [...new Set([...configured, ...Object.keys(saved)])]
  return {
    enabled: !!pricing,
    currency: typeof pricing?.currency === 'string' ? pricing.currency : '¥',
    per_generation: priceString(pricing?.per_generation),
    per_image: priceString(pricing?.per_image),
    per_second: priceString(pricing?.per_second),
    resolutions: resolutionNames.map((resolution, id) => ({ id, resolution, rate: priceString(saved[resolution]) })),
  }
}

function mergePricing(settings: Record<string, unknown>, draft: PricingDraft): Record<string, unknown> {
  const result = { ...settings }
  if (!draft.enabled) {
    delete result.pricing
    return result
  }
  const pricing = { ...(isRecord(settings.pricing) ? settings.pricing : {}) }
  pricing.currency = draft.currency.trim() || '¥'
  for (const field of ['per_generation', 'per_image', 'per_second'] as const) {
    if (draft[field].trim()) pricing[field] = Number(draft[field])
    else delete pricing[field]
  }
  const byResolution = Object.fromEntries(draft.resolutions
    .filter((item) => item.resolution.trim() && item.rate.trim())
    .map((item) => [item.resolution.trim(), Number(item.rate)]))
  if (Object.keys(byResolution).length) pricing.per_second_by_resolution = byResolution
  else delete pricing.per_second_by_resolution
  result.pricing = pricing
  return result
}

function pricingError(draft: PricingDraft, modality: Modality): string | null {
  if (!draft.enabled) return null
  const rates = modality === 'text' ? [draft.per_generation]
    : modality === 'image' ? [draft.per_image, draft.per_generation]
      : [draft.per_second, draft.per_generation, ...draft.resolutions.map((item) => item.rate)]
  for (const rate of [draft.per_generation, draft.per_image, draft.per_second, ...draft.resolutions.map((item) => item.rate)]) {
    if (rate.trim() && (!Number.isFinite(Number(rate)) || Number(rate) < 0)) return '价格必须是大于或等于 0 的数字'
  }
  if (!rates.some((rate) => rate.trim())) return '请填写至少一项适用于当前模型的价格'
  const named = draft.resolutions.filter((item) => item.rate.trim()).map((item) => item.resolution.trim())
  if (named.some((name) => !name)) return '填写分辨率价格时也要填写分辨率名称'
  if (new Set(named).size !== named.length) return '分辨率价格不能重复'
  return null
}

export default function ModelAdvancedEditor({model,provider,onApply,onClose}:{model:Model;provider:Provider;onApply:(model:Model)=>void;onClose:()=>void}) {
  const configurableProviders=[provider]
  const busy=false
  const editingModelId=model.id
  const [modelDraft,setModelDraft]=useState<ModelDraft>({...model,settings:formattedSettings(model.settings)})
  const [pricingDraft,setPricingDraft]=useState(()=>pricingFromSettings(model.settings))
  const [advancedOpen,setAdvancedOpen]=useState(false)
  const [formError,setFormError]=useState('')
  const [pricingFormError,setPricingFormError]=useState('')
  function setModelOpen(open:boolean){if(!open)onClose()}
  async function saveModel() {
    let settings: Record<string, unknown>
    try {
      settings = parsedSettings(modelDraft.settings)
    } catch {
      setFormError('模型配置必须是有效的 JSON 对象')
      setAdvancedOpen(true)
      return
    }
    if (modelDraft.modality === 'text') {
      settings = scopeTextCapabilities(settings, {base_url:typeof settings.api_base_url==='string'?settings.api_base_url:provider.base_url,protocol:modelDraft.protocol,remote_id:modelDraft.remote_id.trim()})
      const issue = textApiConfigError(settings, modelDraft.protocol as TextApiProtocol) || textCapabilitiesConfigError(settings) || textContextConfigError(settings) || videoInputConfigError(settings)
      if (issue) { setFormError(issue); return }
      settings = migrateStandardTextSettings(settings, modelDraft.protocol as TextApiProtocol) || settings
    }
    if (modelDraft.modality === 'video') {
      const issue = videoModelConfigError(settings)
      if (issue) { setFormError(issue); return }
    }
    if (modelDraft.modality === 'image') {
      const issue = documentedImageConfigError(settings) || imageAnalysisConfigError(settings)
      if (issue) { setFormError(issue); return }
      if (settings.image_api_profile === documentedImageProfile) settings = documentedImageSettings(settings,
        configurableProviders.find(item => item.id === modelDraft.provider_id)?.base_url || '')
      if (Array.isArray(settings.ratios) && (!settings.ratios.length || settings.default_ratio !== undefined && !settings.ratios.includes(settings.default_ratio))) {
        setFormError('请选择至少一个画幅，并将默认画幅设为可选画幅之一')
        return
      }
    }
    const priceError = pricingError(pricingDraft, modelDraft.modality)
    if (priceError) {
      setPricingFormError(priceError)
      return
    }
    settings = mergePricing(settings, pricingDraft)
    setFormError('')
    setPricingFormError('')
    onApply({...model,...modelDraft,settings})
    onClose()
  }

  function formatModelSettings() {
    try {
      setModelDraft((current) => ({ ...current, settings: formattedSettings(parsedSettings(current.settings)) }))
      setFormError('')
    } catch {
      setFormError('模型配置必须是有效的 JSON 对象')
    }
  }

  function textCapability(key: 'structured_output_mode' | 'strict_tool_arguments' | 'supports_vision' | 'supports_video' | 'video_input_format') {
    try { return (JSON.parse(modelDraft.settings) as Record<string, unknown>)[key] }
    catch { return undefined }
  }
  function changeTextCapability(key: 'structured_output_mode' | 'strict_tool_arguments' | 'supports_vision' | 'supports_video' | 'video_input_format', value: string | boolean) {
    try {
      const settings = JSON.parse(modelDraft.settings)
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('请求配置必须为 JSON 对象')
      setModelDraft(current => ({ ...current, settings: JSON.stringify({ ...settings, [key]: value }, null, 2) }))
      setFormError('')
    } catch { setFormError('请先修正请求配置 JSON，再调整输出能力') }
  }
  let textSettings: Record<string, unknown> | null = null
  if (modelDraft.modality === 'text') try { textSettings = parsedSettings(modelDraft.settings) } catch { /* The JSON editor remains available for invalid drafts. */ }

  return (
    <Modal opened={true} onClose={() => setModelOpen(false)} title='模型高级设置' size="xl" centered classNames={{ content: 'ms-modal', header: 'ms-modal-header' }}>
      <div className="ms-modal-body">
        <div className="ms-field-pair">
          <Select label="提供商" placeholder="选择提供商" data={configurableProviders.map((item) => ({ value: item.id, label: item.name }))} value={modelDraft.provider_id || null} onChange={(value) => setModelDraft({ ...modelDraft, provider_id: value || '' })} />
          <div className="ms-modality-field"><span>类型</span><SegmentedControl fullWidth value={modelDraft.modality} data={Object.entries(modalityLabels).map(([value, label]) => ({ value, label }))} onChange={(value) => {
            const modality = value as Modality
            const protocol = protocolsFor[modality][0]
            setModelDraft({ ...modelDraft, modality, protocol, settings: formattedSettings(starterSettings[protocol]) })
            if (modality === 'video') setPricingDraft((current) => {
              const configured = pricingFromSettings(starterSettings[protocol]).resolutions
              return { ...current, resolutions: [...configured.map((item) => current.resolutions.find((row) => row.resolution === item.resolution) || item), ...current.resolutions.filter((row) => !configured.some((item) => item.resolution === row.resolution))] }
            })
            setPricingFormError('')
          }} /></div>
        </div>
        <div className="ms-field-pair"><TextInput label="显示名称" placeholder="填写模型名称" value={modelDraft.name} onChange={(event) => setModelDraft({ ...modelDraft, name: event.currentTarget.value })} /><TextInput label="模型 ID / Endpoint ID" placeholder="厂商模型标识" value={modelDraft.remote_id} onChange={(event) => setModelDraft({ ...modelDraft, remote_id: event.currentTarget.value })} /></div>
        <Select label="接口协议" data={protocolsFor[modelDraft.modality].map((protocol) => ({ value: protocol, label: protocolLabels[protocol] }))} value={modelDraft.protocol} onChange={(value) => {
          if (!value) return
          const protocol = value as Protocol
          try {
            const settings = parsedSettings(modelDraft.settings)
            const migrated = modelDraft.modality === 'text' ? migrateStandardTextSettings(settings, modelDraft.protocol as TextApiProtocol) : null
            setModelDraft({ ...modelDraft, protocol, settings: formattedSettings(migrated || settings) })
            setFormError('')
          } catch { setFormError('请先修正高级配置，再切换协议') }
        }} />
        {modelDraft.modality === 'text' && <TextModelApiSettings key={editingModelId || 'new-model'} value={modelDraft.settings} protocol={modelDraft.protocol as TextApiProtocol} hideManagedFields
          onChange={settings => { setModelDraft(current => ({ ...current, settings: formattedSettings(settings) })); setFormError('') }}
          onError={setFormError} onAdvanced={() => setAdvancedOpen(true)} />}
        {modelDraft.modality === 'text' && textSettings && <HarnessTextModelOptions settings={textSettings} protocol={modelDraft.protocol as TextApiProtocol}
          scope={{base_url:typeof textSettings.api_base_url==='string'?textSettings.api_base_url:provider.base_url,protocol:modelDraft.protocol,remote_id:modelDraft.remote_id}}
          onChange={settings => { setModelDraft(current => ({ ...current, settings: formattedSettings(settings) })); setFormError('') }} />}
        {modelDraft.modality === 'image' && <ImageModelConfig value={modelDraft.settings}
          providerBaseUrl={configurableProviders.find(item => item.id === modelDraft.provider_id)?.base_url || ''}
          onChange={settings => { setModelDraft(current => ({ ...current, settings: formattedSettings(settings) })); setFormError('') }}
          onError={setFormError} onAdvanced={() => setAdvancedOpen(true)} />}
        {modelDraft.modality === 'image' && <ImageAnalysisModelSettings value={modelDraft.settings} remoteId={modelDraft.remote_id}
          providerBaseUrl={configurableProviders.find(item => item.id === modelDraft.provider_id)?.base_url || ''}
          onChange={settings => { setModelDraft(current => ({ ...current, settings: formattedSettings(settings) })); setFormError('') }} />}
        <section className="ms-pricing" aria-labelledby="ms-pricing-title">
          <div className="ms-pricing-heading">
            <div><strong id="ms-pricing-title">费用估算</strong><p>填写模型实际价格，生成前可查看预计费用。</p></div>
            <Switch label="启用" checked={pricingDraft.enabled} onChange={(event) => { setPricingDraft({ ...pricingDraft, enabled: event.currentTarget.checked }); setPricingFormError('') }} />
          </div>
          {pricingDraft.enabled && <div className="ms-pricing-fields">
            <TextInput className="ms-pricing-currency" label="货币符号" placeholder="¥" value={pricingDraft.currency} onChange={(event) => { setPricingDraft({ ...pricingDraft, currency: event.currentTarget.value }); setPricingFormError('') }} />
            {modelDraft.modality === 'text' && <TextInput label="每次文本请求" placeholder="0.00" inputMode="decimal" value={pricingDraft.per_generation} onChange={(event) => { setPricingDraft({ ...pricingDraft, per_generation: event.currentTarget.value }); setPricingFormError('') }} />}
            {modelDraft.modality === 'image' && <>
              <TextInput label="每张图片" placeholder="0.00" inputMode="decimal" value={pricingDraft.per_image} onChange={(event) => { setPricingDraft({ ...pricingDraft, per_image: event.currentTarget.value }); setPricingFormError('') }} />
              <TextInput label="每次生成（备用）" placeholder="0.00" inputMode="decimal" value={pricingDraft.per_generation} onChange={(event) => { setPricingDraft({ ...pricingDraft, per_generation: event.currentTarget.value }); setPricingFormError('') }} />
            </>}
            {modelDraft.modality === 'video' && <>
              <TextInput label="每秒视频" placeholder="0.00" inputMode="decimal" value={pricingDraft.per_second} onChange={(event) => { setPricingDraft({ ...pricingDraft, per_second: event.currentTarget.value }); setPricingFormError('') }} />
              <TextInput label="每次生成（备用）" placeholder="0.00" inputMode="decimal" value={pricingDraft.per_generation} onChange={(event) => { setPricingDraft({ ...pricingDraft, per_generation: event.currentTarget.value }); setPricingFormError('') }} />
              <div className="ms-resolution-pricing">
                <div className="ms-resolution-heading"><strong>按分辨率计价</strong><span>填写后优先采用对应分辨率的每秒价格</span></div>
                {pricingDraft.resolutions.map((row) => <div className="ms-resolution-row" key={row.id}>
                  <TextInput aria-label="分辨率" placeholder="例如 720p" value={row.resolution} onChange={(event) => { const resolution = event.currentTarget.value; setPricingDraft((current) => ({ ...current, resolutions: current.resolutions.map((item) => item.id === row.id ? { ...item, resolution } : item) })); setPricingFormError('') }} />
                  <TextInput aria-label={`${row.resolution || '分辨率'}每秒价格`} placeholder="每秒价格" inputMode="decimal" value={row.rate} onChange={(event) => { const rate = event.currentTarget.value; setPricingDraft((current) => ({ ...current, resolutions: current.resolutions.map((item) => item.id === row.id ? { ...item, rate } : item) })); setPricingFormError('') }} />
                  <Tooltip label="移除分辨率价格"><ActionIcon variant="subtle" color="gray" aria-label={`移除 ${row.resolution || '分辨率'} 价格`} onClick={() => { setPricingDraft((current) => ({ ...current, resolutions: current.resolutions.filter((item) => item.id !== row.id) })); setPricingFormError('') }}><Trash2 size={15} /></ActionIcon></Tooltip>
                </div>)}
                <Button variant="subtle" size="compact-sm" leftSection={<Plus size={14} />} onClick={() => setPricingDraft((current) => ({ ...current, resolutions: [...current.resolutions, { id: Math.max(-1, ...current.resolutions.map((item) => item.id)) + 1, resolution: '', rate: '' }] }))}>添加分辨率价格</Button>
              </div>
            </>}
            {pricingFormError && <p className="ms-pricing-error" role="alert">{pricingFormError}</p>}
          </div>}
        </section>
        {modelDraft.modality === 'text' && <section className="ms-text-capabilities">
          <Select label="结构化输出" description="按厂商实际支持选择；未知时使用兼容模式" value={String(textCapability('structured_output_mode') || 'prompt')} allowDeselect={false}
            data={[{ value: 'prompt', label: '兼容模式 · 提示词与本地校验' }, ...(modelDraft.protocol === 'anthropic_messages' ? [] : [{ value: 'json_object', label: 'JSON 模式' }]), { value: 'json_schema', label: 'JSON Schema · 严格结构' }]}
            onChange={value => value && changeTextCapability('structured_output_mode', value)} />
          <Select label="视频输入格式" description="豆包视频反推请选择豆包格式，并确认当前服务商支持视频输入" value={String(textCapability('video_input_format') || 'chat_video_url')} allowDeselect={false}
            data={[{ value: 'chat_video_url', label: '通用 Chat Completions · video_url' }, { value: 'doubao_ark', label: '豆包视频理解 · Chat / Responses' }]}
            onChange={value => value && changeTextCapability('video_input_format', value)} />
          <Switch label="支持视频理解" description="仅在当前服务商确认该模型支持所选视频输入格式时开启，用于视频反推与成片复核" disabled={modelDraft.protocol !== 'chat_completions' && !(modelDraft.protocol === 'responses' && textCapability('video_input_format') === 'doubao_ark')} checked={textCapability('supports_video') === true} onChange={event => changeTextCapability('supports_video', event.currentTarget.checked)} />
          <Switch label="严格函数参数" description="仅在接口支持严格工具 Schema 时开启；执行前仍会校验参数" checked={textCapability('strict_tool_arguments') === true} onChange={event => changeTextCapability('strict_tool_arguments', event.currentTarget.checked)} />
        </section>}
        {modelDraft.modality === 'video' && <VideoModelConfig value={modelDraft.settings}
          onChange={settings => { setModelDraft(current => ({ ...current, settings: formattedSettings(settings) })); setFormError('') }}
          onError={setFormError} onAdvanced={() => setAdvancedOpen(true)} />}
        <Accordion className="ms-advanced-config" variant="contained" value={advancedOpen ? 'json' : null} onChange={value => setAdvancedOpen(value === 'json')}>
          <Accordion.Item value="json">
            <Accordion.Control icon={<Braces size={16} />}>高级配置 · JSON</Accordion.Control>
            <Accordion.Panel>
              {modelDraft.modality === 'text' && <TextModelContextSettings value={modelDraft.settings} section="reserve"
                onChange={settings => { setModelDraft(current => ({ ...current, settings: formattedSettings(settings) })); setFormError('') }} onError={setFormError} />}
              <div className="ms-json-head"><span>请求配置 JSON</span><Button variant="subtle" size="compact-sm" leftSection={<Braces size={14} />} onClick={formatModelSettings}>格式化</Button></div>
              <Textarea aria-label="请求配置 JSON" classNames={{ input: 'ms-json-editor' }} spellCheck={false} rows={13} value={modelDraft.settings} onChange={(event) => { setModelDraft({ ...modelDraft, settings: event.currentTarget.value }); setFormError('') }} />
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
        {formError && <Alert color="red" title="模型配置有误">{formError}</Alert>}
        <div className="ms-modal-actions"><Button variant="default" onClick={() => setModelOpen(false)}>取消</Button><Button className="ms-primary-action" leftSection={<Save size={15} />} disabled={busy || !modelDraft.provider_id || !modelDraft.name.trim() || !modelDraft.remote_id.trim()} onClick={saveModel}>保存模型</Button></div>
      </div>
    </Modal>

  )
}
