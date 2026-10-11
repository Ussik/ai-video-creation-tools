import { useEffect, useRef, useState } from 'react'
import { UnstyledButton,
  ActionIcon, Badge, Button, Modal, PasswordInput, Popover, SegmentedControl,
  Select, Switch, Tabs, Textarea, TextInput, Tooltip,
} from '@mantine/core'
import {
  Braces, Check, ChevronDown, Film, HelpCircle, Image as ImageIcon, KeyRound,
  ListFilter, ListPlus, Minus, Pencil, Plus, RefreshCw, Save, Search, Server,
  Settings2, Trash2, Type, X,
} from 'lucide-react'
import { api, json } from './api'
import type { Model, Modality, Protocol, Provider } from './api'
import { normalizeProviderBaseUrl } from './provider-url'
import { imageRatios } from './canvas-model-parameters'
import { videoRatios, videoResolutions } from '../../backend/src/video-parameters'
import { applySeedance2VideoSettings } from '../../backend/src/seedance-video-settings'
import './model-settings.css'

type Props = {
  providers: Provider[]
  models: Model[]
  refresh: () => Promise<void>
  action: (task: () => Promise<unknown>, success?: string) => Promise<void>
  busy: boolean
}

type ProviderDraft = {
  name: string
  base_url: string
  api_key: string
}

type ConnectionDraft = Pick<ProviderDraft, 'base_url' | 'api_key'>
type ConnectionField = keyof ConnectionDraft
type ConnectionErrors = Partial<Record<ConnectionField, string>>
type CatalogItem = { remote_id: string; name: string; modality_hint: Modality | null; existing: boolean }
type CatalogChoice = { modality: Modality | null; protocol: Protocol }

type ModelDraft = {
  provider_id: string
  name: string
  remote_id: string
  modality: Modality
  protocol: Protocol
  settings: string
}

type ResolutionPrice = { id: number; resolution: string; rate: string }
type PricingDraft = {
  enabled: boolean
  currency: string
  per_generation: string
  per_image: string
  per_second: string
  resolutions: ResolutionPrice[]
}

type DeleteTarget = { kind: 'provider' | 'model'; id: string; name: string } | null

const emptyProvider = (): ProviderDraft => ({
  name: '', base_url: '', api_key: '',
})

const emptyConnection = (): ConnectionDraft => ({ base_url: '', api_key: '' })

const protocolLabels: Record<Protocol, string> = {
  responses: 'Responses',
  chat_completions: 'Chat Completions',
  image_generations: 'Image Generations',
  async_video: 'Async Video',
}

const protocolsFor: Record<Modality, Protocol[]> = {
  text: ['responses', 'chat_completions'],
  image: ['image_generations'],
  video: ['async_video'],
}

const modalityLabels: Record<Modality, string> = { text: '文本', image: '图片', video: '视频' }
const modalityIcons = { text: Type, image: ImageIcon, video: Film }

function suggestedModality(model: CatalogItem): Modality | null {
  // Capabilities come from provider metadata or the creator's explicit choice.
  // A model name is not evidence of supported output modalities.
  return model.modality_hint || null
}

function modelFamily(model: CatalogItem): string {
  const id = model.remote_id.trim().toLowerCase()
  if (id.startsWith('nano-banana')) return 'nano-banana'
  return id.split(/[\s._/-]/, 1)[0] || '其他'
}

const starterSettings: Record<Protocol, Record<string, unknown>> = {
  responses: {
    request_path: 'responses',
    request_template: { model: '{{model}}', input: '{{prompt}}' },
    text_paths: ['output_text', 'output'],
  },
  chat_completions: {
    request_path: 'chat/completions',
    request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] },
    text_path: 'choices.0.message.content',
  },
  image_generations: {
    request_path: 'images/generations',
    request_template: { model: '{{model}}', prompt: '{{prompt}}', ratio: '{{ratio}}' },
    image_base64_path: 'data.0.b64_json',
    image_url_path: 'data.0.url',
    ratios: imageRatios,
    default_ratio: '1:1',
  },
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

function emptyModel(providerId: string): ModelDraft {
  return {
    provider_id: providerId, name: '', remote_id: '', modality: 'text',
    protocol: 'responses', settings: formattedSettings(starterSettings.responses),
  }
}

export default function ModelSettings({ providers, models, refresh, action, busy }: Props) {
  const [providerId, setProviderId] = useState('')
  const [providerSearch, setProviderSearch] = useState('')
  const [modelSearch, setModelSearch] = useState('')
  const [modalityFilter, setModalityFilter] = useState<'all' | Modality>('all')
  const [connection, setConnection] = useState<ConnectionDraft>(emptyConnection)
  const [connectionErrors, setConnectionErrors] = useState<ConnectionErrors>({})
  const [connectionSaving, setConnectionSaving] = useState(false)
  const [connectionSaved, setConnectionSaved] = useState(false)
  const [connectionSyncing, setConnectionSyncing] = useState(false)
  const connectionDrafts = useRef(new Map<string, ConnectionDraft>())
  const savedBaseUrls = useRef(new Map<string, string>())
  const savedErrors = useRef(new Map<string, ConnectionErrors>())
  const connectionQueue = useRef<Promise<void>>(Promise.resolve())
  const pendingConnectionSaves = useRef(new Map<string, { value: string; task: Promise<boolean> }>())
  const activeProviderId = useRef('')
  const syncRequestId = useRef(0)
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>(emptyProvider)
  const [providerOpen, setProviderOpen] = useState(false)
  const [providerNameTarget, setProviderNameTarget] = useState<{ id: string; name: string } | null>(null)
  const [providerNameDraft, setProviderNameDraft] = useState('')
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([])
  const [catalogChoices, setCatalogChoices] = useState<Record<string, CatalogChoice>>({})
  const [catalogSearch, setCatalogSearch] = useState('')
  const [catalogFilter, setCatalogFilter] = useState<'all' | Modality | 'unknown'>('all')
  const [catalogCollapsed, setCatalogCollapsed] = useState<string[]>([])
  const [catalogConfiguring, setCatalogConfiguring] = useState<string | null>(null)
  const [catalogActiveAction, setCatalogActiveAction] = useState<string | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogImporting, setCatalogImporting] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [catalogStatus, setCatalogStatus] = useState('')
  const catalogRequestId = useRef(0)
  const [keyClearOpen, setKeyClearOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [editingModelId, setEditingModelId] = useState<string | null>(null)
  const [modelDraft, setModelDraft] = useState<ModelDraft>(() => emptyModel(''))
  const [pricingDraft, setPricingDraft] = useState<PricingDraft>(() => pricingFromSettings(starterSettings.responses))
  const [formError, setFormError] = useState('')
  const [pricingFormError, setPricingFormError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null)

  const configurableProviders = providers.filter((item) => item.adapter !== 'demo')
  const filteredProviders = configurableProviders.filter((item) => item.name.toLocaleLowerCase().includes(providerSearch.trim().toLocaleLowerCase()))
  const provider = configurableProviders.find((item) => item.id === providerId)
  const providerModels = models.filter((model) => model.provider_id === providerId)
  const visibleModels = providerModels.filter((model) =>
    (modalityFilter === 'all' || model.modality === modalityFilter) &&
    `${model.name} ${model.remote_id}`.toLocaleLowerCase().includes(modelSearch.trim().toLocaleLowerCase()))
  useEffect(() => {
    if (!configurableProviders.some((item) => item.id === providerId)) {
      setProviderId(configurableProviders[0]?.id || '')
    }
  }, [providers, providerId])

  useEffect(() => {
    syncRequestId.current += 1
    activeProviderId.current = provider?.id || ''
    if (!provider) {
      setConnection(emptyConnection())
      setConnectionErrors({})
    } else {
      const draft = connectionDrafts.current.get(provider.id) || {
        base_url: normalizeProviderBaseUrl(provider.base_url), api_key: '',
      }
      connectionDrafts.current.set(provider.id, draft)
      if (!savedBaseUrls.current.has(provider.id)) savedBaseUrls.current.set(provider.id, provider.base_url)
      setConnection(draft)
      setConnectionErrors(savedErrors.current.get(provider.id) || {})
    }
    setConnectionSaving(false)
    setConnectionSaved(false)
    setConnectionSyncing(false)
  }, [provider?.id])

  useEffect(() => {
    catalogRequestId.current += 1
    setCatalogOpen(false)
  }, [providerId])

  function openNewModel() {
    setEditingModelId(null)
    setModelDraft(emptyModel(providerId))
    setPricingDraft(pricingFromSettings(starterSettings.responses))
    setFormError('')
    setPricingFormError('')
    setModelOpen(true)
  }

  function openModel(model: Model) {
    setEditingModelId(model.id)
    setModelDraft({
      provider_id: model.provider_id, name: model.name, remote_id: model.remote_id,
      modality: model.modality, protocol: model.protocol, settings: formattedSettings(model.settings),
    })
    setPricingDraft(pricingFromSettings(model.settings))
    setFormError('')
    setPricingFormError('')
    setModelOpen(true)
  }

  async function addProvider() {
    if (!providerDraft.name.trim() || !providerDraft.base_url.trim()) return
    await action(async () => {
      const created = await api<Provider>('/providers', json('POST', {
        ...providerDraft, name: providerDraft.name.trim(), base_url: normalizeProviderBaseUrl(providerDraft.base_url), adapter: 'http',
      }))
      await refresh()
      setProviderId(created.id)
      setProviderSearch('')
      setProviderDraft(emptyProvider())
      setProviderOpen(false)
    }, '厂商已添加')
  }

  async function renameProvider() {
    const name = providerNameDraft.trim()
    if (!providerNameTarget || busy || !name || name.length > 120 || name === providerNameTarget.name) return
    const id = providerNameTarget.id
    await action(async () => {
      await api(`/providers/${id}`, json('PATCH', { name }))
      await refresh()
      setProviderNameTarget(null)
    }, '提供商名称已更新')
  }

  function setConnectionFieldError(providerId: string, field: ConnectionField, message: string | null) {
    const errors = { ...savedErrors.current.get(providerId) }
    if (message) errors[field] = message
    else delete errors[field]
    savedErrors.current.set(providerId, errors)
    if (activeProviderId.current === providerId) setConnectionErrors(errors)
  }

  function changeConnection(field: ConnectionField, value: string) {
    if (!provider) return
    const draft = { ...(connectionDrafts.current.get(provider.id) || connection), [field]: value }
    connectionDrafts.current.set(provider.id, draft)
    setConnection(draft)
    setConnectionSaved(false)
    setConnectionFieldError(provider.id, field, null)
  }

  function queueConnectionSave(providerId: string, field: ConnectionField, value: string): Promise<boolean> {
    const saveId = `${providerId}:${field}`
    const pending = pendingConnectionSaves.current.get(saveId)
    if (pending?.value === value) return pending.task
    const task = connectionQueue.current.then(async () => {
      const normalized = field === 'base_url' ? normalizeProviderBaseUrl(value) : value
      if (field === 'base_url' && !normalized) {
        setConnectionFieldError(providerId, field, '请输入 API 地址')
        return false
      }
      if (field === 'base_url' && savedBaseUrls.current.get(providerId) === normalized) return true
      if (field === 'api_key' && !normalized) return true
      if (activeProviderId.current === providerId) setConnectionSaving(true)
      try {
        await api(`/providers/${providerId}`, json('PATCH', { [field]: normalized }))
        await refresh()
        if (field === 'base_url') savedBaseUrls.current.set(providerId, normalized)
        if (field === 'api_key') {
          const draft = connectionDrafts.current.get(providerId)
          if (draft?.api_key === value) {
            const cleared = { ...draft, api_key: '' }
            connectionDrafts.current.set(providerId, cleared)
            if (activeProviderId.current === providerId) setConnection(cleared)
          }
        }
        setConnectionFieldError(providerId, field, null)
        if (activeProviderId.current === providerId) {
          const draft = connectionDrafts.current.get(providerId)
          setConnectionSaved(!draft?.api_key && normalizeProviderBaseUrl(draft?.base_url || '') === savedBaseUrls.current.get(providerId))
        }
        return true
      } catch (error) {
        setConnectionFieldError(providerId, field, error instanceof Error ? error.message : String(error))
        if (activeProviderId.current === providerId) setConnectionSaved(false)
        return false
      } finally {
        if (activeProviderId.current === providerId) setConnectionSaving(false)
      }
    })
    connectionQueue.current = task.then(() => undefined)
    pendingConnectionSaves.current.set(saveId, { value, task })
    void task.then(() => {
      if (pendingConnectionSaves.current.get(saveId)?.task === task) pendingConnectionSaves.current.delete(saveId)
    })
    return task
  }

  function saveConnectionField(field: ConnectionField) {
    if (!provider) return
    const draft = connectionDrafts.current.get(provider.id) || connection
    const value = field === 'base_url' ? normalizeProviderBaseUrl(draft.base_url) : draft.api_key
    if (field === 'base_url' && value !== draft.base_url) changeConnection(field, value)
    void queueConnectionSave(provider.id, field, value)
  }

  async function openCatalog() {
    if (!provider || connectionSyncing) return
    const providerId = provider.id
    const requestId = ++syncRequestId.current
    setConnectionSyncing(true)
    try {
      await connectionQueue.current
      if (activeProviderId.current !== providerId || syncRequestId.current !== requestId) return
      const draft = connectionDrafts.current.get(providerId) || connection
      const url = normalizeProviderBaseUrl(draft.base_url)
      if (url !== savedBaseUrls.current.get(providerId) && !(await queueConnectionSave(providerId, 'base_url', url))) return
      const key = connectionDrafts.current.get(providerId)?.api_key || ''
      if (key && !(await queueConnectionSave(providerId, 'api_key', key))) return
      if (activeProviderId.current !== providerId || syncRequestId.current !== requestId) return
      setCatalogSearch('')
      setCatalogFilter('all')
      setCatalogCollapsed([])
      setCatalogOpen(true)
      void loadCatalog()
    } finally {
      if (activeProviderId.current === providerId) setConnectionSyncing(false)
    }
  }

  async function loadCatalog() {
    if (!provider) return
    const requestId = ++catalogRequestId.current
    setCatalogLoading(true)
    setCatalogError('')
    setCatalogStatus('')
    setCatalogItems([])
    setCatalogConfiguring(null)
    try {
      const result = await api<{ models: CatalogItem[]; total: number }>(`/providers/${provider.id}/model-catalog`)
      if (requestId !== catalogRequestId.current) return
      setCatalogItems(result.models)
      setCatalogChoices(Object.fromEntries(result.models.map((item) => {
        const saved = providerModels.find((model) => model.remote_id === item.remote_id)
        const modality = saved?.modality || suggestedModality(item)
        return [item.remote_id, { modality, protocol: saved?.protocol || protocolsFor[modality || 'text'][0] }]
      })))
    } catch (error) {
      if (requestId === catalogRequestId.current) setCatalogError(error instanceof Error ? error.message : String(error))
    } finally {
      if (requestId === catalogRequestId.current) setCatalogLoading(false)
    }
  }

  function closeCatalog() {
    if (catalogImporting) return
    catalogRequestId.current += 1
    setCatalogOpen(false)
  }

  async function importCatalog(selected: CatalogItem[], activeAction: string) {
    if (!provider || catalogImporting || selected.length === 0) return
    const missingType = selected.some((item) => !catalogChoices[item.remote_id]?.modality)
    if (missingType) {
      setCatalogError('请先为模型选择类型')
      return
    }
    setCatalogError('')
    setCatalogStatus('')
    setCatalogImporting(true)
    setCatalogActiveAction(activeAction)
    setCatalogConfiguring(null)
    const completedIds = new Set<string>()
    let importedCount = 0
    let skippedCount = 0
    try {
      for (let start = 0; start < selected.length; start += 100) {
        const batch = selected.slice(start, start + 100)
        setCatalogStatus(`正在导入 ${start + 1}-${Math.min(start + batch.length, selected.length)} / ${selected.length}`)
        const result = await api<{ imported: Model[]; skipped: Array<{ remote_id: string; reason: string }> }>(`/providers/${provider.id}/model-catalog/import`, json('POST', {
          models: batch.map((item) => {
            const choice = catalogChoices[item.remote_id]
            return {
              remote_id: item.remote_id,
              name: item.name.slice(0, 120),
              modality: choice.modality,
              protocol: choice.protocol,
              settings: starterSettings[choice.protocol],
              enabled: false,
            }
          }),
        }))
        for (const item of result.imported) completedIds.add(item.remote_id)
        for (const item of result.skipped) completedIds.add(item.remote_id)
        importedCount += result.imported.length
        skippedCount += result.skipped.length
      }
      setCatalogStatus(`已导入 ${importedCount} 个模型${skippedCount ? `，跳过 ${skippedCount} 个重复项` : ''}`)
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : String(error))
      setCatalogStatus(importedCount ? `已导入 ${importedCount} 个模型，剩余模型未导入。` : '')
    } finally {
      if (completedIds.size) {
        setCatalogItems((current) => current.map((item) => completedIds.has(item.remote_id) ? { ...item, existing: true } : item))
        try {
          await refresh()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          setCatalogError((current) => `${current ? `${current}；` : ''}刷新模型列表失败：${message}`)
        }
      }
      setCatalogImporting(false)
      setCatalogActiveAction(null)
    }
  }

  async function setProviderEnabled(enabled: boolean) {
    if (!provider) return
    await action(async () => {
      await api(`/providers/${provider.id}`, json('PATCH', { enabled }))
      await refresh()
    }, enabled ? '提供商已启用' : '提供商已停用')
  }

  async function clearApiKey() {
    if (!provider?.has_key) return
    const providerId = provider.id
    await connectionQueue.current
    if (activeProviderId.current !== providerId) return
    await action(async () => {
      await api(`/providers/${providerId}`, json('PATCH', { api_key: null }))
      const draft = connectionDrafts.current.get(providerId)
      if (draft) {
        const cleared = { ...draft, api_key: '' }
        connectionDrafts.current.set(providerId, cleared)
        setConnection(cleared)
      }
      setConnectionFieldError(providerId, 'api_key', null)
      await refresh()
      setKeyClearOpen(false)
    }, 'API 密钥已清除')
  }

  async function saveModel() {
    let settings: Record<string, unknown>
    try {
      settings = parsedSettings(modelDraft.settings)
    } catch {
      setFormError('模型配置必须是有效的 JSON 对象')
      return
    }
    const priceError = pricingError(pricingDraft, modelDraft.modality)
    if (priceError) {
      setPricingFormError(priceError)
      return
    }
    settings = mergePricing(settings, pricingDraft)
    setFormError('')
    setPricingFormError('')
    await action(async () => {
      if (editingModelId) {
        await api(`/models/${editingModelId}`, json('PATCH', { ...modelDraft, settings }))
      } else {
        await api('/models', json('POST', { ...modelDraft, settings }))
      }
      await refresh()
      setModelOpen(false)
    }, editingModelId ? '模型已保存' : '模型已添加')
  }

  function formatModelSettings() {
    try {
      setModelDraft((current) => ({ ...current, settings: formattedSettings(parsedSettings(current.settings)) }))
      setFormError('')
    } catch {
      setFormError('模型配置必须是有效的 JSON 对象')
    }
  }

  function textCapability(key: 'structured_output_mode' | 'strict_tool_arguments') {
    try { return (JSON.parse(modelDraft.settings) as Record<string, unknown>)[key] }
    catch { return undefined }
  }
  function changeTextCapability(key: 'structured_output_mode' | 'strict_tool_arguments', value: string | boolean) {
    try {
      const settings = JSON.parse(modelDraft.settings)
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('请求配置必须为 JSON 对象')
      setModelDraft(current => ({ ...current, settings: JSON.stringify({ ...settings, [key]: value }, null, 2) }))
      setFormError('')
    } catch { setFormError('请先修正请求配置 JSON，再调整输出能力') }
  }

  async function deleteSelected() {
    if (!deleteTarget) return
    await action(async () => {
      await api(`/${deleteTarget.kind === 'provider' ? 'providers' : 'models'}/${deleteTarget.id}`, { method: 'DELETE' })
      const deletedModel = deleteTarget.kind === 'model' ? models.find((item) => item.id === deleteTarget.id) : undefined
      await refresh()
      if (deleteTarget.kind === 'provider') {
        setProviderId(configurableProviders.find((item) => item.id !== deleteTarget.id)?.id || '')
      }
      if (deletedModel?.provider_id === providerId) {
        setCatalogItems((current) => current.map((item) => item.remote_id === deletedModel.remote_id ? { ...item, existing: false } : item))
      }
      setDeleteTarget(null)
    }, deleteTarget.kind === 'provider' ? '厂商已删除' : '模型已删除')
  }

  const deleteCount = deleteTarget?.kind === 'provider'
    ? models.filter((model) => model.provider_id === deleteTarget.id).length : 0
  const catalogCounts = {
    all: catalogItems.length,
    text: catalogItems.filter((item) => catalogChoices[item.remote_id]?.modality === 'text').length,
    image: catalogItems.filter((item) => catalogChoices[item.remote_id]?.modality === 'image').length,
    video: catalogItems.filter((item) => catalogChoices[item.remote_id]?.modality === 'video').length,
    unknown: catalogItems.filter((item) => !catalogChoices[item.remote_id]?.modality).length,
  }
  const filteredCatalog = catalogItems.filter((item) =>
    (catalogFilter === 'all' || catalogConfiguring === item.remote_id || (catalogFilter === 'unknown'
      ? !catalogChoices[item.remote_id]?.modality
      : catalogChoices[item.remote_id]?.modality === catalogFilter)) &&
    `${item.name} ${item.remote_id}`.toLocaleLowerCase().includes(catalogSearch.trim().toLocaleLowerCase()))
  const catalogGroups = [...filteredCatalog.reduce((groups, item) => {
    const family = modelFamily(item)
    groups.set(family, [...(groups.get(family) || []), item])
    return groups
  }, new Map<string, CatalogItem[]>()).entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
  const readyCatalog = catalogItems.filter((item) => !item.existing && catalogChoices[item.remote_id]?.modality)
  const unknownCatalogCount = catalogItems.filter((item) => !item.existing && !catalogChoices[item.remote_id]?.modality).length

  function setCatalogModality(remoteId: string, modality: Modality | null) {
    if (catalogFilter === 'unknown' && modality && catalogCounts.unknown === 1) setCatalogFilter('all')
    setCatalogChoices((current) => ({
      ...current, [remoteId]: { modality, protocol: protocolsFor[modality || 'text'][0] },
    }))
    setCatalogError('')
  }

  function openNewProvider() {
    setProviderDraft(emptyProvider())
    setProviderOpen(true)
  }

  return <section className="ms-page" aria-label="模型设置">
    <div className="ms-layout">
      <aside className="ms-sidebar" aria-label="提供商列表">
        <div className="ms-sidebar-heading"><strong>提供商</strong><span>{configurableProviders.length}</span></div>
        <TextInput
          aria-label="搜索提供商"
          placeholder="搜索提供商"
          leftSection={<Search size={16} />}
          value={providerSearch}
          onChange={(event) => setProviderSearch(event.currentTarget.value)}
          rightSection={providerSearch ? <ActionIcon variant="subtle" aria-label="清除搜索" onClick={() => setProviderSearch('')}><X size={14} /></ActionIcon> : null}
        />
        <nav className="ms-provider-list" aria-label="选择提供商">
          {filteredProviders.map((item, index) => {
            const count = models.filter((model) => model.provider_id === item.id).length
            return <UnstyledButton key={item.id} type="button" className={`ms-provider ${providerId === item.id ? 'is-active' : ''}`} aria-current={providerId === item.id ? 'true' : undefined} onClick={() => { syncRequestId.current += 1; activeProviderId.current = item.id; catalogRequestId.current += 1; setCatalogOpen(false); setProviderId(item.id); setModelSearch(''); setModalityFilter('all') }}>
              <span className={`ms-provider-symbol ms-symbol-${index % 5}`}>{item.name.trim().slice(0, 1).toUpperCase()}</span>
              <span className="ms-provider-copy"><strong>{item.name}</strong><small>{count} 个模型</small></span>
              <span className={`ms-status-light ${item.enabled && item.has_key ? 'is-ready' : ''}`} title={!item.enabled ? '已停用' : item.has_key ? '已配置密钥' : '待配置密钥'} />
            </UnstyledButton>
          })}
          {configurableProviders.length > 0 && filteredProviders.length === 0 && <p className="ms-search-empty">没有匹配的提供商</p>}
        </nav>
        <div className="ms-sidebar-footer"><Button fullWidth variant="default" leftSection={<Plus size={16} />} onClick={openNewProvider}>添加提供商</Button></div>
      </aside>

      <div className="ms-content">
        {provider ? <>
          <header className="ms-provider-heading">
            <span className="ms-provider-emblem">{provider.name.trim().slice(0, 1).toUpperCase()}</span>
            <div className="ms-provider-title"><div className="ms-provider-name"><h1>{provider.name}</h1><Tooltip label="修改提供商名称"><ActionIcon aria-label="修改提供商名称" variant="subtle" disabled={busy} onClick={() => { setProviderNameDraft(provider.name); setProviderNameTarget({ id: provider.id, name: provider.name }) }}><Pencil size={15} /></ActionIcon></Tooltip></div><span>{provider.enabled ? '已启用' : '已停用'} · {providerModels.length} 个模型</span></div>
            <div className="ms-head-actions">
              <Switch label="启用提供商" checked={provider.enabled} disabled={busy} onChange={(event) => void setProviderEnabled(event.currentTarget.checked)} />
              <Tooltip label="删除提供商"><ActionIcon aria-label={`删除提供商 ${provider.name}`} color="gray" variant="subtle" disabled={busy} onClick={() => setDeleteTarget({ kind: 'provider', id: provider.id, name: provider.name })}><Trash2 size={16} /></ActionIcon></Tooltip>
            </div>
          </header>

          <div className="ms-content-inner">
            <section className="ms-connection" aria-labelledby="ms-connection-title">
              <div className="ms-section-heading">
                <div><h2 id="ms-connection-title">连接配置</h2><p>密钥只在本机保存，当前值不会回传到页面。</p></div>
                <Badge color={provider.has_key ? 'teal' : 'gray'} leftSection={provider.has_key ? <Check size={12} /> : <KeyRound size={12} />}>{provider.has_key ? '已保存密钥' : '待配置密钥'}</Badge>
              </div>
              <div className="ms-connection-form">
                <div className="ms-key-field">
                  <PasswordInput
                    label="API 密钥"
                    autoComplete="new-password"
                    placeholder={provider.has_key ? '已保存密钥，输入新密钥可替换' : '输入 API 密钥'}
                    value={connection.api_key}
                    disabled={connectionSyncing}
                    error={connectionErrors.api_key}
                    onChange={(event) => changeConnection('api_key', event.currentTarget.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
                    onBlur={() => saveConnectionField('api_key')}
                  />
                  {provider.has_key && <Button className="ms-clear-key" size="compact-xs" variant="subtle" color="gray" leftSection={<Trash2 size={13} />} onClick={() => setKeyClearOpen(true)}>清除已保存密钥</Button>}
                </div>
                <TextInput label="API 地址" description="仅填域名时自动补 /v1；已有接口路径保持原样" type="url" placeholder="https://api.example.com/v1" value={connection.base_url} disabled={connectionSyncing} error={connectionErrors.base_url} onChange={(event) => changeConnection('base_url', event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} onBlur={() => saveConnectionField('base_url')} />
                <div className="ms-connection-status" role="status" aria-live="polite">{connectionSaving ? '正在保存…' : connectionSaved ? '已保存' : ''}</div>
              </div>
            </section>

            <section className="ms-models" aria-labelledby="ms-model-title">
              <div className="ms-section-heading ms-models-heading"><div><h2 id="ms-model-title">模型 <span className="ms-count">{providerModels.length}</span></h2><p>为文本、图片和视频任务选择可用模型。</p></div><div className="ms-model-heading-actions"><Tooltip label="请先启用提供商" disabled={provider.enabled}><span><Button variant="default" leftSection={<RefreshCw size={16} />} loading={connectionSyncing} onClick={() => void openCatalog()} disabled={busy || connectionSyncing || !provider.enabled}>同步模型</Button></span></Tooltip><Button leftSection={<Plus size={16} />} onClick={openNewModel}>手动添加</Button></div></div>
              <div className="ms-model-toolbar">
                <TextInput aria-label="搜索模型" placeholder="搜索模型名称或 ID" leftSection={<Search size={16} />} value={modelSearch} onChange={(event) => setModelSearch(event.currentTarget.value)} />
                <Select aria-label="按模型类型筛选" leftSection={<ListFilter size={15} />} allowDeselect={false} value={modalityFilter} data={[{ value: 'all', label: '全部类型' }, ...Object.entries(modalityLabels).map(([value, label]) => ({ value, label }))]} onChange={(value) => setModalityFilter((value || 'all') as 'all' | Modality)} />
              </div>
              <div className="ms-model-table">
                {(['text', 'image', 'video'] as Modality[]).map((modality) => {
                  const groupedModels = visibleModels.filter((model) => model.modality === modality)
                  if (!groupedModels.length) return null
                  return <div className="ms-model-group" key={modality}>
                    <div className="ms-model-group-heading"><span>{modalityLabels[modality]}</span><small>{groupedModels.length}</small></div>
                    {groupedModels.map((model) => {
                      const Icon = modalityIcons[model.modality]
                      return <div className={`ms-model-row ${model.enabled ? '' : 'is-disabled'}`} key={model.id}>
                        <span className={`ms-model-symbol ms-${model.modality}`}><Icon size={17} strokeWidth={1.8} /></span>
                        <div className="ms-model-copy"><strong>{model.name}</strong><small>{model.remote_id} <span className="ms-separator">·</span> {protocolLabels[model.protocol] || model.protocol}</small></div>
                        <div className="ms-model-actions">
                          <Switch size="sm" checked={model.enabled} disabled={busy} aria-label={model.enabled ? `停用 ${model.name}` : `启用 ${model.name}`} onChange={(event) => {
                            const enabled = event.currentTarget.checked
                            void action(async () => { await api(`/models/${model.id}`, json('PATCH', { enabled })); await refresh() })
                          }} />
                          <Tooltip label="编辑模型"><ActionIcon variant="subtle" color="gray" aria-label={`编辑 ${model.name}`} onClick={() => openModel(model)}><Pencil size={16} /></ActionIcon></Tooltip>
                          <Tooltip label="删除模型"><ActionIcon variant="subtle" color="gray" aria-label={`删除 ${model.name}`} disabled={busy} onClick={() => setDeleteTarget({ kind: 'model', id: model.id, name: model.name })}><Trash2 size={16} /></ActionIcon></Tooltip>
                        </div>
                      </div>
                    })}
                  </div>
                })}
                {!visibleModels.length && <div className="ms-empty-models"><Server size={22} /><strong>{providerModels.length ? '没有匹配的模型' : '还没有模型'}</strong><span>{providerModels.length ? '试试其他名称或类型。' : '添加此提供商的第一个模型。'}</span>{!providerModels.length && <Button size="xs" variant="default" leftSection={<Plus size={14} />} onClick={openNewModel}>添加模型</Button>}</div>}
              </div>
            </section>
          </div>
        </> : <div className="ms-empty-provider"><Server size={28} /><strong>还没有提供商</strong><span>添加提供商后即可配置密钥和模型。</span><Button leftSection={<Plus size={16} />} onClick={openNewProvider}>添加提供商</Button></div>}
      </div>
    </div>

    <Modal opened={providerOpen} onClose={() => setProviderOpen(false)} title="添加自定义提供商" size="md" centered classNames={{ content: 'ms-modal', header: 'ms-modal-header' }}>
      <div className="ms-modal-body">
        <TextInput label="提供商名称" withAsterisk placeholder="填写提供商名称" value={providerDraft.name} onChange={(event) => setProviderDraft({ ...providerDraft, name: event.currentTarget.value })} />
        <PasswordInput label="API 密钥" autoComplete="new-password" placeholder="输入 API 密钥" value={providerDraft.api_key} onChange={(event) => setProviderDraft({ ...providerDraft, api_key: event.currentTarget.value })} />
        <TextInput label="API 地址" description="仅填域名时自动补 /v1；已有接口路径保持原样" withAsterisk type="url" placeholder="https://api.example.com/v1" value={providerDraft.base_url} onChange={(event) => setProviderDraft({ ...providerDraft, base_url: event.currentTarget.value })} onBlur={() => setProviderDraft((current) => ({ ...current, base_url: normalizeProviderBaseUrl(current.base_url) }))} />
        <div className="ms-modal-actions"><Button variant="default" onClick={() => setProviderOpen(false)}>取消</Button><Button className="ms-primary-action" leftSection={<Plus size={15} />} disabled={busy || !providerDraft.name.trim() || !providerDraft.base_url.trim()} onClick={addProvider}>添加提供商</Button></div>
      </div>
    </Modal>

    <Modal opened={!!providerNameTarget} onClose={() => { if (!busy) setProviderNameTarget(null) }} title="修改提供商名称" size="sm" centered closeOnClickOutside={!busy} closeOnEscape={!busy} withCloseButton={!busy} classNames={{ content: 'ms-modal', header: 'ms-modal-header' }}>
      <div className="ms-modal-body">
        <TextInput label="提供商名称" aria-label="提供商名称" withAsterisk data-autofocus maxLength={120} value={providerNameDraft} disabled={busy} onChange={event => setProviderNameDraft(event.currentTarget.value)} />
        <div className="ms-modal-actions"><Button variant="default" disabled={busy} onClick={() => setProviderNameTarget(null)}>取消</Button><Button leftSection={<Save size={15} />} loading={busy} disabled={!providerNameDraft.trim() || providerNameDraft.trim() === providerNameTarget?.name} onClick={() => void renameProvider()}>保存名称</Button></div>
      </div>
    </Modal>

    <Modal
      opened={catalogOpen}
      onClose={closeCatalog}
      size={1040}
      centered
      classNames={{ content: 'ms-modal ms-catalog-modal', header: 'ms-modal-header' }}
      title={<div className="ms-catalog-title">
        <div><strong>{provider?.name || '提供商'} 模型</strong><span className="ms-catalog-count">{catalogItems.length}</span></div>
        <Button variant="subtle" leftSection={<ListPlus size={17} />} loading={catalogImporting && catalogActiveAction === 'all'} disabled={busy || catalogLoading || catalogImporting || readyCatalog.length === 0} onClick={() => void importCatalog(readyCatalog, 'all')}>
          {unknownCatalogCount ? `添加可识别模型 (${readyCatalog.length})` : '添加全部模型'}
        </Button>
      </div>}
    >
      <div className="ms-catalog-body">
        <div className="ms-catalog-search">
          <TextInput aria-label="搜索远端模型" placeholder="搜索模型" leftSection={<Search size={17} />} value={catalogSearch} onChange={(event) => { setCatalogConfiguring(null); setCatalogSearch(event.currentTarget.value) }} />
          <Tooltip label="重新获取模型列表"><ActionIcon variant="default" size="lg" aria-label="重新获取模型列表" loading={catalogLoading} disabled={catalogImporting} onClick={() => void loadCatalog()}><RefreshCw size={17} /></ActionIcon></Tooltip>
        </div>
        <Tabs className="ms-catalog-tabs" value={catalogFilter} onChange={(value) => { setCatalogConfiguring(null); setCatalogFilter((value || 'all') as typeof catalogFilter) }}>
          <Tabs.List>
            <Tabs.Tab value="all">全部 <span className="ms-catalog-tab-count">{catalogCounts.all}</span></Tabs.Tab>
            <Tabs.Tab value="text" leftSection={<Type size={15} />}>文本 <span className="ms-catalog-tab-count">{catalogCounts.text}</span></Tabs.Tab>
            <Tabs.Tab value="image" leftSection={<ImageIcon size={15} />}>图片 <span className="ms-catalog-tab-count">{catalogCounts.image}</span></Tabs.Tab>
            <Tabs.Tab value="video" leftSection={<Film size={15} />}>视频 <span className="ms-catalog-tab-count">{catalogCounts.video}</span></Tabs.Tab>
            {(catalogCounts.unknown > 0 || catalogFilter === 'unknown') && <Tabs.Tab value="unknown" leftSection={<HelpCircle size={15} />}>待分类 <span className="ms-catalog-tab-count">{catalogCounts.unknown}</span></Tabs.Tab>}
          </Tabs.List>
        </Tabs>
        {catalogError && <div className="ms-catalog-message is-error" role="alert">{catalogError}</div>}
        {catalogStatus && <div className="ms-catalog-message is-success" role="status">{catalogStatus}</div>}
        <div className="ms-catalog-list">
          {catalogLoading ? <div className="ms-catalog-loading" aria-label="正在读取模型列表">
            {Array.from({ length: 5 }, (_, index) => <div className="ms-catalog-skeleton" key={index}><span /><span /></div>)}
          </div> : catalogGroups.map(([family, groupItems]) => {
            const collapsed = catalogCollapsed.includes(family)
            const readyGroup = groupItems.filter((item) => !item.existing && catalogChoices[item.remote_id]?.modality)
            return <section className="ms-catalog-group" key={family} aria-label={`${family} 模型`}>
              <div className="ms-catalog-group-head">
                <UnstyledButton type="button" aria-expanded={!collapsed} onClick={() => setCatalogCollapsed((current) => collapsed ? current.filter((name) => name !== family) : [...current, family])}>
                  <ChevronDown size={17} className={collapsed ? 'is-collapsed' : ''} /><strong>{family}</strong><span>{groupItems.length}</span>
                </UnstyledButton>
                <Tooltip label={readyGroup.length ? `添加此组 ${readyGroup.length} 个模型` : '本组没有可直接添加的模型'}>
                  <ActionIcon variant="subtle" aria-label={`添加 ${family} 分组模型`} loading={catalogImporting && catalogActiveAction === `group:${family}`} disabled={busy || catalogImporting || readyGroup.length === 0} onClick={() => void importCatalog(readyGroup, `group:${family}`)}><Plus size={18} /></ActionIcon>
                </Tooltip>
              </div>
              {!collapsed && groupItems.map((item) => {
                const choice = catalogChoices[item.remote_id] || { modality: null, protocol: 'responses' as Protocol }
                const Icon = choice.modality ? modalityIcons[choice.modality] : HelpCircle
                const existingModel = providerModels.find((model) => model.remote_id === item.remote_id)
                return <div className={`ms-catalog-row ${item.existing ? 'is-existing' : ''}`} key={item.remote_id}>
                  <span className={`ms-catalog-avatar ms-${choice.modality || 'unknown'}`}><Icon size={17} /></span>
                  <div className="ms-catalog-row-title"><strong>{item.name}</strong>{item.name !== item.remote_id && <small>{item.remote_id}</small>}</div>
                  <div className="ms-catalog-row-actions">
                    <span className={`ms-catalog-kind ms-${choice.modality || 'unknown'}`}>{choice.modality ? modalityLabels[choice.modality] : '待分类'}</span>
                    {item.existing ? <Tooltip label="从提供商移除模型"><ActionIcon variant="subtle" aria-label={`移除模型 ${item.name}`} disabled={busy || catalogImporting || !existingModel} onClick={() => { if (existingModel) setDeleteTarget({ kind: 'model', id: existingModel.id, name: existingModel.name }) }}><Minus size={18} /></ActionIcon></Tooltip> : <>
                      <Popover opened={catalogConfiguring === item.remote_id} onChange={(opened) => setCatalogConfiguring(opened ? item.remote_id : null)} position="bottom-end" withArrow shadow="md">
                        <Popover.Target><ActionIcon variant="subtle" aria-label={`设置 ${item.name} 的类型和协议`} title="设置类型和协议" disabled={catalogImporting} onClick={() => setCatalogConfiguring(catalogConfiguring === item.remote_id ? null : item.remote_id)}><Settings2 size={17} /></ActionIcon></Popover.Target>
                        <Popover.Dropdown className="ms-catalog-config">
                          <strong>{item.name}</strong>
                          <Select label="模型类型" placeholder="选择类型" allowDeselect={false} comboboxProps={{ withinPortal: false }} data={Object.entries(modalityLabels).map(([value, label]) => ({ value, label }))} value={choice.modality} onChange={(value) => setCatalogModality(item.remote_id, value as Modality | null)} />
                          <Select label="接口协议" allowDeselect={false} disabled={!choice.modality} comboboxProps={{ withinPortal: false }} data={choice.modality ? protocolsFor[choice.modality].map((protocol) => ({ value: protocol, label: protocolLabels[protocol] })) : []} value={choice.modality ? choice.protocol : null} onChange={(value) => { if (value) setCatalogChoices((current) => ({ ...current, [item.remote_id]: { ...choice, protocol: value as Protocol } })) }} />
                          <Button fullWidth disabled={!choice.modality || catalogImporting} onClick={() => void importCatalog([item], `model:${item.remote_id}`)}>添加模型</Button>
                        </Popover.Dropdown>
                      </Popover>
                      <Tooltip label={choice.modality ? '添加模型' : '先选择模型类型'}><ActionIcon variant="subtle" aria-label={`添加模型 ${item.name}`} loading={catalogImporting && catalogActiveAction === `model:${item.remote_id}`} disabled={busy || catalogImporting} onClick={() => choice.modality ? void importCatalog([item], `model:${item.remote_id}`) : setCatalogConfiguring(item.remote_id)}><Plus size={19} /></ActionIcon></Tooltip>
                    </>}
                  </div>
                </div>
              })}
            </section>
          })}
          {!catalogLoading && catalogItems.length === 0 && !catalogError && <div className="ms-catalog-empty">没有获取到模型，请检查 API 地址或手动添加。</div>}
          {!catalogLoading && catalogItems.length > 0 && filteredCatalog.length === 0 && <div className="ms-catalog-empty">没有匹配的模型</div>}
        </div>
        <div className="ms-catalog-footer"><span>{unknownCatalogCount ? `${unknownCatalogCount} 个模型需选择类型后添加。` : '新添加的模型默认停用，核对请求配置后再启用。'}</span><Button variant="default" disabled={catalogImporting} onClick={closeCatalog}>关闭</Button></div>
      </div>
    </Modal>

    <Modal opened={modelOpen} onClose={() => setModelOpen(false)} title={editingModelId ? '编辑模型' : '添加模型'} size="xl" centered classNames={{ content: 'ms-modal', header: 'ms-modal-header' }}>
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
          setModelDraft({ ...modelDraft, protocol, settings: formattedSettings(starterSettings[protocol]) })
        }} />
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
            data={[{ value: 'prompt', label: '兼容模式 · 提示词与本地校验' }, { value: 'json_object', label: 'JSON 模式' }, { value: 'json_schema', label: 'JSON Schema · 严格结构' }]}
            onChange={value => value && changeTextCapability('structured_output_mode', value)} />
          <Switch label="严格函数参数" description="仅在接口支持严格工具 Schema 时开启；执行前仍会校验参数" checked={textCapability('strict_tool_arguments') === true} onChange={event => changeTextCapability('strict_tool_arguments', event.currentTarget.checked)} />
        </section>}
        <div className="ms-json-head"><span>请求配置 JSON</span><div>
          {modelDraft.modality === 'video' && <Button variant="subtle" size="compact-sm" onClick={() => {
            try {
              const previous = parsedSettings(modelDraft.settings)
              setModelDraft({ ...modelDraft, settings: formattedSettings(applySeedance2VideoSettings(previous)) })
              setFormError('')
            } catch (issue) { setFormError(issue instanceof Error ? issue.message : String(issue)) }
          }}>应用 Seedance 2.0 配置</Button>}
          <Button variant="subtle" size="compact-sm" leftSection={<Braces size={14} />} onClick={formatModelSettings}>格式化</Button>
        </div></div>
        <Textarea aria-label="请求配置 JSON" classNames={{ input: 'ms-json-editor' }} spellCheck={false} rows={13} value={modelDraft.settings} onChange={(event) => { setModelDraft({ ...modelDraft, settings: event.currentTarget.value }); setFormError('') }} error={formError || undefined} />
        <div className="ms-modal-actions"><Button variant="default" onClick={() => setModelOpen(false)}>取消</Button><Button className="ms-primary-action" leftSection={<Save size={15} />} disabled={busy || !modelDraft.provider_id || !modelDraft.name.trim() || !modelDraft.remote_id.trim()} onClick={saveModel}>保存模型</Button></div>
      </div>
    </Modal>

    <Modal opened={keyClearOpen} onClose={() => setKeyClearOpen(false)} title="清除 API 密钥" size="sm" centered classNames={{ content: 'ms-modal', header: 'ms-modal-header' }}>
      <div className="ms-confirm"><p>清除「{provider?.name}」的密钥后，此提供商的模型将无法发起请求，直到重新保存密钥。</p><div className="ms-modal-actions"><Button variant="default" onClick={() => setKeyClearOpen(false)}>取消</Button><Button color="red" loading={busy} onClick={clearApiKey}>清除密钥</Button></div></div>
    </Modal>

    <Modal opened={!!deleteTarget} onClose={() => setDeleteTarget(null)} title={deleteTarget?.kind === 'provider' ? '删除提供商' : '删除模型'} size="sm" centered classNames={{ content: 'ms-modal', header: 'ms-modal-header' }}>
      <div className="ms-confirm"><p>删除「{deleteTarget?.name}」{deleteTarget?.kind === 'provider' ? `及其 ${deleteCount} 个模型` : ''}？已生成的素材仍会保留。</p><div className="ms-modal-actions"><Button variant="default" onClick={() => setDeleteTarget(null)}>取消</Button><Button color="red" leftSection={<Trash2 size={15} />} loading={busy} onClick={deleteSelected}>删除</Button></div></div>
    </Modal>
  </section>
}
