import type { Modality } from '../../shared/api/api'

export const MODEL_SELECTION_CHANGED = 'studio:model-selection-changed'
const keyPrefix = 'studio:last-model:'
// Keep this session usable even when browser storage is unavailable.
const sessionChoices = new WeakMap<Window, Map<Modality, string | null>>()
export const modelSelectionStorageKey = (modality: Modality) => `${keyPrefix}${modality}`

export function rememberedModelId(modality: Modality): string | undefined {
  if (typeof window === 'undefined') return undefined
  const session = sessionChoices.get(window)
  if (session?.has(modality)) return session.get(modality) || undefined
  try { return window.localStorage.getItem(modelSelectionStorageKey(modality)) || undefined }
  catch { return undefined }
}

/** Only deliberate user choices belong here; capability fallbacks stay local. */
export function rememberModelSelection(modality: Modality, id: string | null): void {
  if (typeof window === 'undefined') return
  const value = id?.trim() || null
  let choices = sessionChoices.get(window)
  if (!choices) { choices = new Map(); sessionChoices.set(window, choices) }
  choices.set(modality, value)
  try {
    if (value) window.localStorage.setItem(modelSelectionStorageKey(modality), value)
    else window.localStorage.removeItem(modelSelectionStorageKey(modality))
    choices.delete(modality)
  } catch { /* The latest choice remains available within this session. */ }
  window.dispatchEvent(new window.CustomEvent(MODEL_SELECTION_CHANGED, { detail: { modality } }))
}

export function subscribeModelSelection(modality: Modality, listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const changed = (event: Event) => {
    if ((event as CustomEvent<{ modality: Modality }>).detail?.modality === modality) listener()
  }
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key === modelSelectionStorageKey(modality)) {
      sessionChoices.get(window)?.delete(modality)
      listener()
    }
  }
  window.addEventListener(MODEL_SELECTION_CHANGED, changed)
  window.addEventListener('storage', storage)
  return () => { window.removeEventListener(MODEL_SELECTION_CHANGED, changed); window.removeEventListener('storage', storage) }
}
