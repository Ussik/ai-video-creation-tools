import type { Modality } from '../../shared/api/api'
import { rememberedModelId } from './model-selection-store'

type ModelOption = { id?: string; modality?: Modality; is_default?: boolean }
function remembered(model: ModelOption): boolean {
  return !!model.id && !!model.modality && rememberedModelId(model.modality) === model.id
}
// Pass only models eligible for the task so capability requirements take priority.
export function preferredModel<T extends ModelOption>(models: readonly T[]): T | undefined {
  return models.find(remembered) || models.find(model => model.is_default) || models[0]
}

export function orderModelsByDefault<T extends ModelOption>(models: readonly T[]): T[] {
  return [...models].sort((left, right) => Number(remembered(right)) - Number(remembered(left)) || Number(!!right.is_default) - Number(!!left.is_default))
}
