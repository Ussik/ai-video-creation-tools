import type { Provider as PublicProvider, Model as PublicModel } from '@video-studio/shared/api/contracts'
import type { Provider, Model } from '../../infrastructure/database/db.js'
import { modelCatalogInput } from './schemas.js'

export function providerPublic(provider: Provider): PublicProvider {
  const { key_ciphertext, created_at, archived, model_catalog, ...publicFields } = provider
  return {
    ...publicFields, model_catalog: modelCatalogInput.parse(JSON.parse(model_catalog)),
    enabled: Boolean(provider.enabled), has_key: Boolean(key_ciphertext),
  }
}

export function modelPublic(model: Model): PublicModel {
  const { archived, ...publicFields } = model
  return { ...publicFields, settings: JSON.parse(model.settings) as Record<string, unknown>, enabled: Boolean(model.enabled), is_default: Boolean(model.is_default) }
}
