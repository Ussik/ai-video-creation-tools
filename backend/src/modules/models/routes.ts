import type { FastifyInstance } from 'fastify'
import { all, db, newId, now, one, required, run, type Job, type Model, type Provider } from '../../infrastructure/database/db.js'
import { idParams, invalid, parse } from '../../infrastructure/http/request.js'
import { encryptKey } from '../../infrastructure/security/secrets.js'
import { fetchModelCatalog, type ModelCatalogConfig } from '../../infrastructure/providers/model-catalog.js'
import { modelCatalogInput, modelCatalogImport, modelInput, modelPatch, providerInput, providerPatch } from './schemas.js'
import { modelPublic, providerPublic } from './serializers.js'
import { checkBaseUrl, checkProtocol, validateSettings } from './validation.js'

export function registerModelRoutes(app: FastifyInstance) {
  app.get('/api/providers', async () => all<Provider>("SELECT * FROM providers WHERE adapter <> 'demo' AND archived=0 ORDER BY name").map(providerPublic))
  app.post('/api/providers', async request => {
    const data = parse(providerInput, request.body)
    checkBaseUrl(data.base_url)
    const id = newId()
    run('INSERT INTO providers (id, name, adapter, base_url, auth_header, auth_prefix, key_ciphertext, model_catalog, created_at, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, data.name, data.adapter, data.base_url, data.auth_header, data.auth_prefix, encryptKey(data.api_key), JSON.stringify(data.model_catalog), now(), Number(data.enabled))
    return providerPublic(required<Provider>('providers', id))
  })
  app.patch('/api/providers/:id', async request => {
    const { id } = parse(idParams, request.params)
    const existing = required<Provider>('providers', id)
    if (existing.adapter === 'demo' || existing.archived) invalid('此提供商已归档')
    const data = parse(providerPatch, request.body)
    const nameOnly = 'name' in data && Object.keys(data).every(key => key === 'name')
    if (!nameOnly && one<Job>("SELECT jobs.* FROM jobs JOIN models ON jobs.model_id=models.id WHERE models.provider_id=? AND jobs.status IN ('queued','running') LIMIT 1", id)) invalid('此厂商还有进行中的任务，完成后才能修改连接')
    checkBaseUrl(data.base_url || existing.base_url)
    if ('api_key' in data) {
      run('UPDATE providers SET key_ciphertext=? WHERE id=?', encryptKey(data.api_key), id)
      delete data.api_key
    }
    for (const [key, value] of Object.entries(data)) {
      run(`UPDATE providers SET ${key}=? WHERE id=?`, key === 'enabled' ? Number(value) : key === 'model_catalog' ? JSON.stringify(value) : value, id)
    }
    if (data.enabled === false) run('UPDATE models SET is_default=0 WHERE provider_id=?', id)
    return providerPublic(required<Provider>('providers', id))
  })
  app.get('/api/providers/:id/model-catalog', async request => {
    const { id } = parse(idParams, request.params)
    const provider = required<Provider>('providers', id)
    if (provider.adapter === 'demo' || provider.archived) invalid('此提供商已归档')
    if (!provider.enabled) invalid('请先启用提供商再同步模型')
    const config = modelCatalogInput.parse(JSON.parse(provider.model_catalog)) as ModelCatalogConfig
    const catalog = await fetchModelCatalog(provider, config)
    const existing = new Set(all<{ remote_id: string }>('SELECT remote_id FROM models WHERE provider_id=? AND archived=0', id).map(model => model.remote_id))
    return { models: catalog.map(model => ({ ...model, existing: existing.has(model.remote_id) })), total: catalog.length }
  })
  app.post('/api/providers/:id/model-catalog/import', async request => {
    const { id } = parse(idParams, request.params)
    const provider = required<Provider>('providers', id)
    if (provider.adapter === 'demo' || provider.archived) invalid('此提供商已归档')
    const data = parse(modelCatalogImport, request.body)
    for (const model of data.models) {
      checkProtocol(model.modality, model.protocol)
      if (model.enabled) validateSettings(model.modality, model.settings)
    }
    const imported: Model[] = []
    const skipped: Array<{ remote_id: string; reason: 'existing' | 'duplicate' }> = []
    db.transaction(() => {
      const seen = new Set<string>()
      for (const model of data.models) {
        if (seen.has(model.remote_id)) {
          skipped.push({ remote_id: model.remote_id, reason: 'duplicate' })
          continue
        }
        seen.add(model.remote_id)
        if (one<Model>('SELECT * FROM models WHERE provider_id=? AND remote_id=? AND archived=0 LIMIT 1', id, model.remote_id)) {
          skipped.push({ remote_id: model.remote_id, reason: 'existing' })
          continue
        }
        const modelId = newId()
        run('INSERT INTO models (id, provider_id, name, remote_id, modality, protocol, settings, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          modelId, id, model.name || model.remote_id.slice(0, 120), model.remote_id, model.modality, model.protocol, JSON.stringify(model.settings), Number(model.enabled))
        imported.push(required<Model>('models', modelId))
      }
    })()
    return { imported: imported.map(modelPublic), skipped }
  })
  app.delete('/api/providers/:id', async request => {
    const { id } = parse(idParams, request.params)
    const provider = required<Provider>('providers', id)
    if (provider.adapter === 'demo' || provider.archived) invalid('此提供商已归档')
    if (one<Job>("SELECT jobs.* FROM jobs JOIN models ON jobs.model_id=models.id WHERE models.provider_id=? AND jobs.status IN ('queued','running') LIMIT 1", id)) invalid('此厂商还有进行中的任务')
    run('DELETE FROM providers WHERE id=?', id)
    return { ok: true }
  })
  app.get('/api/models', async () => all<Model>("SELECT models.* FROM models JOIN providers ON providers.id=models.provider_id WHERE providers.adapter <> 'demo' AND providers.archived=0 AND models.archived=0 ORDER BY models.modality, models.name").map(modelPublic))
  app.put('/api/models/:id/default', async request => {
    const { id } = parse(idParams, request.params)
    const model = required<Model>('models', id)
    const provider = required<Provider>('providers', model.provider_id)
    if (provider.adapter === 'demo' || provider.archived || model.archived) invalid('此模型已归档')
    if (!provider.enabled || !model.enabled) invalid('请先启用提供商和模型再设为默认')
    db.transaction(() => {
      run('UPDATE models SET is_default=0 WHERE modality=? AND is_default=1', model.modality)
      run('UPDATE models SET is_default=1 WHERE id=?', id)
    })()
    return modelPublic(required<Model>('models', id))
  })
  app.delete('/api/models/:id/default', async request => {
    const { id } = parse(idParams, request.params)
    const model = required<Model>('models', id)
    const provider = required<Provider>('providers', model.provider_id)
    if (provider.adapter === 'demo' || provider.archived || model.archived) invalid('此模型已归档')
    run('UPDATE models SET is_default=0 WHERE id=?', id)
    return modelPublic(required<Model>('models', id))
  })
  app.post('/api/models', async request => {
    const data = parse(modelInput, request.body)
    const provider = required<Provider>('providers', data.provider_id)
    if (provider.adapter === 'demo' || provider.archived) invalid('此提供商已归档')
    checkProtocol(data.modality, data.protocol)
    validateSettings(data.modality, data.settings)
    const id = newId()
    run('INSERT INTO models (id, provider_id, name, remote_id, modality, protocol, settings, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, data.provider_id, data.name, data.remote_id, data.modality, data.protocol, JSON.stringify(data.settings), Number(data.enabled))
    return modelPublic(required<Model>('models', id))
  })
  app.patch('/api/models/:id', async request => {
    const { id } = parse(idParams, request.params)
    const existing = required<Model>('models', id)
    const currentProvider = required<Provider>('providers', existing.provider_id)
    if (currentProvider.adapter === 'demo' || currentProvider.archived || existing.archived) invalid('此模型已归档')
    if (one<Job>("SELECT * FROM jobs WHERE model_id=? AND status IN ('queued','running') LIMIT 1", id)) invalid('此模型还有进行中的任务，完成后才能修改配置')
    const data = parse(modelPatch, request.body)
    const targetProvider = required<Provider>('providers', data.provider_id || existing.provider_id)
    if (targetProvider.adapter === 'demo' || targetProvider.archived) invalid('此提供商已归档')
    checkProtocol(data.modality || existing.modality, data.protocol || existing.protocol)
    const settings = data.settings || JSON.parse(existing.settings) as Record<string, unknown>
    if (data.enabled ?? Boolean(existing.enabled)) validateSettings(data.modality || existing.modality, settings)
    if (data.enabled === false || !targetProvider.enabled || (data.modality && data.modality !== existing.modality)) {
      run('UPDATE models SET is_default=0 WHERE id=?', id)
    }
    if (data.settings) {
      run('UPDATE models SET settings=? WHERE id=?', JSON.stringify(data.settings), id)
      delete data.settings
    }
    for (const [key, value] of Object.entries(data)) run(`UPDATE models SET ${key}=? WHERE id=?`, key === 'enabled' ? Number(value) : value, id)
    return modelPublic(required<Model>('models', id))
  })
  app.delete('/api/models/:id', async request => {
    const { id } = parse(idParams, request.params)
    const model = required<Model>('models', id)
    const provider = required<Provider>('providers', model.provider_id)
    if (provider.adapter === 'demo' || provider.archived || model.archived) invalid('此模型已归档')
    if (one<Job>("SELECT * FROM jobs WHERE model_id=? AND status IN ('queued','running') LIMIT 1", id)) invalid('此模型还有进行中的任务')
    run('DELETE FROM models WHERE id=?', id)
    return { ok: true }
  })
}
