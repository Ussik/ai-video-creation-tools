import { z } from 'zod'

export const modelCatalogInput = z.object({
  path: z.string().trim().min(1).max(1024).default('models'),
  list_path: z.string().trim().max(200).default('data'),
  id_path: z.string().trim().min(1).max(200).default('id'),
  name_path: z.string().trim().min(1).max(200).default('id'),
  modality_path: z.string().trim().max(200).default(''),
}).strict()
export const providerInput = z.object({
  name: z.string().trim().min(1).max(120), adapter: z.literal('http').default('http'),
  base_url: z.string().min(1), auth_header: z.string().min(1).default('Authorization'),
  auth_prefix: z.string().default('Bearer '), api_key: z.string().nullable().optional(),
  enabled: z.boolean().default(true), model_catalog: modelCatalogInput.default({
    path: 'models', list_path: 'data', id_path: 'id', name_path: 'id', modality_path: '',
  }),
})
export const providerPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(), adapter: z.literal('http').optional(),
  base_url: z.string().min(1).optional(), auth_header: z.string().min(1).optional(),
  auth_prefix: z.string().optional(), api_key: z.string().nullable().optional(),
  enabled: z.boolean().optional(), model_catalog: modelCatalogInput.optional(),
})
const modality = z.enum(['text', 'image', 'video'])
const protocol = z.enum(['responses', 'chat_completions', 'image_generations', 'async_video'])
export const modelInput = z.object({
  provider_id: z.string().min(1), name: z.string().trim().min(1).max(120),
  remote_id: z.string().trim().min(1), modality, protocol,
  settings: z.record(z.string(), z.unknown()).default({}), enabled: z.boolean().default(true),
})
export const modelPatch = z.object({
  provider_id: z.string().min(1).optional(), name: z.string().trim().min(1).max(120).optional(),
  remote_id: z.string().trim().min(1).optional(), modality: modality.optional(), protocol: protocol.optional(),
  settings: z.record(z.string(), z.unknown()).optional(), enabled: z.boolean().optional(),
})
export const modelCatalogImport = z.object({
  models: z.array(z.object({
    remote_id: z.string().trim().min(1),
    name: z.string().trim().min(1).max(120).optional(),
    modality, protocol,
    settings: z.record(z.string(), z.unknown()).default({}),
    enabled: z.boolean().default(false),
  })).min(1).max(100),
})
