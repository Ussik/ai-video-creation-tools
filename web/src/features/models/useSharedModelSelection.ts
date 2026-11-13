import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { Modality } from '../../shared/api/api'
import { rememberedModelId, rememberModelSelection, subscribeModelSelection } from './model-selection-store'

export function useModelPreference(modality: Modality): string | undefined {
  const subscribe = useCallback((listener: () => void) => subscribeModelSelection(modality, listener), [modality])
  const snapshot = useCallback(() => rememberedModelId(modality), [modality])
  return useSyncExternalStore(subscribe, snapshot, () => undefined)
}

type Candidate = { id: string; is_default?: boolean }
type Options = { locked?: boolean; active?: boolean; fallbackId?: string }

/** Each caller supplies its eligible catalog. Requests keep their selected model
 * while locked; once idle they follow the latest compatible user choice. */
export function useSharedModelSelection(modality: Modality, models: readonly Candidate[], options: Options = {}) {
  const preference = useModelPreference(modality)
  const eligible = (id: string | undefined) => id && models.some(model => model.id === id) ? id : undefined
  const fallback = eligible(options.fallbackId) || models.find(model => model.is_default)?.id || models[0]?.id || ''
  const preferred = eligible(preference) || fallback
  const [modelId, setModelId] = useState(preferred)
  const active = options.active !== false, locked = options.locked === true
  useEffect(() => {
    if (active && !locked) setModelId(preferred)
  }, [active, locked, preferred])
  const selectModel = (id: string) => {
    if (!id || !models.some(model => model.id === id) || locked) return
    setModelId(id)
    rememberModelSelection(modality, id)
  }
  return { modelId, selectModel, setModelId }
}
