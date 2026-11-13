import { isDeepStrictEqual } from 'node:util'
import { all, db, newId, now, one, required, run, type Model, type Provider } from '../../infrastructure/database/db.js'
import { invalid, parse } from '../../infrastructure/http/request.js'
import { encryptKey } from '../../infrastructure/security/secrets.js'
import { providerInput, type ProviderConfigurationInput } from './schemas.js'
import { modelPublic, providerPublic } from './serializers.js'
import { checkBaseUrl, checkProtocol, validateSettings } from './validation.js'
import { modelConfigurationInUse, providerConfigurationInUse } from './model-configuration-usage.js'

export const providerModels = (id: string) => all<Model>('SELECT * FROM models WHERE provider_id=? AND archived=0 ORDER BY sort_order, modality, name, id', id)
export const nextModelOrder = (id: string) => one<{ position: number }>('SELECT COALESCE(MAX(sort_order), -1) + 1 AS position FROM models WHERE provider_id=? AND archived=0', id)!.position

/** A card is a full catalog snapshot. Validate and save every part under one
 * transaction so no failed row can leave a new connection or partial catalog. */
export function saveProviderConfiguration(id: string | undefined, input: ProviderConfigurationInput) {
  return db.transaction(() => {
    const existing = id ? required<Provider>('providers', id) : undefined
    if (existing && (existing.adapter === 'demo' || existing.archived)) invalid('此提供商已归档')
    const providerId = existing?.id ?? newId()
    const provider = input.provider
    const created = existing ? undefined : parse(providerInput, provider)
    checkBaseUrl(provider.base_url ?? existing?.base_url ?? created!.base_url)
    const currentModels = existing ? providerModels(providerId) : []
    const byId = new Map(currentModels.map(model => [model.id, model]))
    const submittedIds = new Set<string>()
    const protocol = provider.protocol !== undefined ? provider.protocol : existing?.protocol ?? null
    const enabled = provider.enabled ?? Boolean(existing?.enabled ?? 1)
    let connectionChanged = false
    if (existing) {
      for (const key of ['adapter', 'base_url', 'auth_header', 'auth_prefix', 'enabled', 'protocol'] as const) {
        if (provider[key] !== undefined && provider[key] !== (key === 'enabled' ? Boolean(existing[key]) : existing[key] ?? null)) connectionChanged = true
      }
      if (provider.model_catalog !== undefined && !isDeepStrictEqual(provider.model_catalog, JSON.parse(existing.model_catalog))) connectionChanged = true
      if (provider.api_key === null ? Boolean(existing.key_ciphertext) : Boolean(provider.api_key)) connectionChanged = true
      if (connectionChanged && providerConfigurationInUse(providerId)) invalid('此厂商还有进行中的任务，完成后才能修改连接')
    }
    const rows = input.models.map((row, sort_order) => {
      const previous = row.id ? byId.get(row.id) : undefined
      if (row.id && !previous) invalid('模型不存在或不属于此提供商')
      if (row.id && submittedIds.has(row.id)) invalid('模型目录不能重复提交同一模型')
      if (row.id) submittedIds.add(row.id)
      const remote_id = row.remote_id ?? previous?.remote_id
      const name = row.name ?? previous?.name
      const modality = row.modality ?? previous?.modality
      const modelProtocol = row.protocol ?? previous?.protocol ?? (modality === 'text' ? protocol : undefined)
      if (!remote_id || !name || !modality || !modelProtocol) invalid('新增模型需填写模型 ID、显示名称、类型和接口协议')
      const settingsObject = row.settings ?? (previous ? JSON.parse(previous.settings) as Record<string, unknown> : {})
      const sameSettings = previous && isDeepStrictEqual(settingsObject, JSON.parse(previous.settings))
      const settings = sameSettings ? previous.settings : JSON.stringify(settingsObject)
      const model: Model = { id: previous?.id ?? newId(), provider_id: providerId, remote_id, name, modality, protocol: modelProtocol,
        settings, enabled: Number(row.enabled ?? Boolean(previous?.enabled ?? 1)), archived: 0, sort_order,
        is_default: previous?.is_default ?? 0 }
      const changed = !previous || ['name', 'remote_id', 'modality', 'protocol', 'settings', 'enabled'].some(key => model[key as keyof Model] !== previous[key as keyof Model])
      checkProtocol(modality, modelProtocol)
      const configurationChanged = !previous || connectionChanged || ['remote_id', 'modality', 'protocol', 'settings', 'enabled'].some(key => model[key as keyof Model] !== previous[key as keyof Model])
      if (!previous || (configurationChanged && model.enabled)) validateSettings(modality, settingsObject, modelProtocol, { base_url: provider.base_url ?? existing?.base_url ?? created!.base_url, protocol: modelProtocol, remote_id })
      if (previous && changed && modelConfigurationInUse(previous.id)) invalid('此模型还有进行中的任务，完成后才能修改配置')
      if (!enabled || !model.enabled || (previous && model.modality !== previous.modality)) model.is_default = 0
      return { model, previous, changed }
    })
    const remoteIds = new Map<string, typeof rows>()
    for (const row of rows) remoteIds.set(row.model.remote_id, [...(remoteIds.get(row.model.remote_id) ?? []), row])
    for (const group of remoteIds.values()) {
      // Existing catalogs could contain aliases of the same remote model. Keep
      // those aliases; reject duplicate IDs introduced by this edit.
      if (group.length > 1 && group.some(row => !row.previous || row.previous.remote_id !== row.model.remote_id)) invalid('模型目录包含重复的模型 ID')
    }
    const removed = currentModels.filter(model => !submittedIds.has(model.id))
    if (removed.some(model => modelConfigurationInUse(model.id))) invalid('此模型还有进行中的任务，完成后才能删除')

    if (!existing) {
      run('INSERT INTO providers (id, name, adapter, base_url, auth_header, auth_prefix, key_ciphertext, model_catalog, protocol, created_at, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        providerId, created!.name, created!.adapter, created!.base_url, created!.auth_header, created!.auth_prefix, encryptKey(created!.api_key), JSON.stringify(created!.model_catalog), created!.protocol, now(), Number(created!.enabled))
    } else {
      for (const [key, value] of Object.entries(provider)) {
        if (key === 'api_key') {
          if (value === null || value) run('UPDATE providers SET key_ciphertext=? WHERE id=?', encryptKey(value as string | null), providerId)
        } else run(`UPDATE providers SET ${key}=? WHERE id=?`, key === 'enabled' ? Number(value) : key === 'model_catalog' ? JSON.stringify(value) : value, providerId)
      }
    }
    for (const model of removed) run('DELETE FROM models WHERE id=?', model.id)
    for (const { model, previous, changed } of rows) {
      if (!previous) {
        run('INSERT INTO models (id, provider_id, name, remote_id, modality, protocol, settings, enabled, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          model.id, providerId, model.name, model.remote_id, model.modality, model.protocol, model.settings, model.enabled, model.sort_order)
      } else if (changed || model.is_default !== previous.is_default || model.sort_order !== previous.sort_order) {
        run('UPDATE models SET name=?, remote_id=?, modality=?, protocol=?, settings=?, enabled=?, sort_order=?, is_default=? WHERE id=?',
          model.name, model.remote_id, model.modality, model.protocol, model.settings, model.enabled, model.sort_order, model.is_default, model.id)
      }
    }
    return { provider: providerPublic(required<Provider>('providers', providerId)), models: providerModels(providerId).map(modelPublic) }
  })()
}
