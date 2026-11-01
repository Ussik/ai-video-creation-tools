import type { PromptVisualBinding } from './visual-prompt.js'
import type { VisualReferenceSnapshot } from './visual-reference-types.js'

export type ExplicitReferenceProfile = Omit<PromptVisualBinding, 'profile_id' | 'reference_assets'> & {
  id: string
  reference_assets?: Array<VisualReferenceSnapshot & { status?: string }>
}

export type ExplicitReferenceBindingOptions = {
  /** Final submitted images; this helper annotates them and never adds an input. */
  referenceAssetIds: string[]
  explicitReferenceAssetIds: string[]
  /** Callers scope these frozen snapshots to the current shot. */
  savedBindings?: PromptVisualBinding[]
  profiles?: ExplicitReferenceProfile[]
  overrides?: Record<string, string | null>
  excludedVisualProfileIds?: string[]
}

type ReferenceOwner = {
  binding: PromptVisualBinding
  priority: number
  board: string | null
  references: VisualReferenceSnapshot[]
}

function cloneBinding(binding: PromptVisualBinding): PromptVisualBinding {
  return { ...binding, ...(binding.selected_reference_asset_ids ? {
    selected_reference_asset_ids: [...binding.selected_reference_asset_ids],
  } : {}), ...(binding.reference_assets ? {
    reference_assets: binding.reference_assets.map(reference => ({ ...reference })),
  } : {}) }
}

function ownerKey(binding: PromptVisualBinding): string {
  return binding.profile_id ? `profile:${binding.profile_id}`
    : `anonymous:${binding.kind}\0${binding.name}\0${binding.variant}`
}

function referenceKey(reference: VisualReferenceSnapshot): string {
  return `${reference.id}\0${reference.asset_id}`
}

/** Add identity metadata only for explicitly selected, already submitted images.
 * Frozen shot text wins over newer library definitions, and every input remains
 * untouched. Unknown uploads continue to use the ordinary manual-image context.
 */
export function enrichExplicitReferenceBindings(bindings: PromptVisualBinding[], options: ExplicitReferenceBindingOptions): PromptVisualBinding[] {
  const selected = new Set(options.explicitReferenceAssetIds)
  const ids = [...new Set(options.referenceAssetIds)].filter(id => selected.has(id))
  if (!ids.length) return bindings.map(cloneBinding)
  const excluded = new Set(options.excludedVisualProfileIds || [])
  const permitted = (binding: PromptVisualBinding) => !binding.profile_id || !excluded.has(binding.profile_id)
  const candidates: ReferenceOwner[] = []
  // A frozen shot binding is authoritative even when usage:none excluded it
  // from the ordinary image/video binding list.
  for (const binding of options.savedBindings || []) if (permitted(binding)) candidates.push({ binding, priority: 0,
    board: binding.board_asset_id,
    references: (binding.reference_assets || []).filter(reference => reference.revision === binding.revision),
  })
  for (const binding of bindings) if (permitted(binding)) candidates.push({ binding, priority: 1,
    board: binding.board_asset_id, references: binding.reference_assets || [],
  })
  for (const profile of options.profiles || []) {
    const { id, reference_assets, ...fields } = profile
    const binding: PromptVisualBinding = { ...fields, profile_id: id }
    if (permitted(binding)) candidates.push({ binding, priority: 2, board: profile.board_asset_id,
      references: (reference_assets || []).filter(reference => reference.status === 'confirmed' && reference.revision === profile.revision),
    })
  }
  const owns = (owner: ReferenceOwner, assetId: string) => owner.board === assetId
    || owner.references.some(reference => reference.asset_id === assetId)
  const replacement = (id: string): string | null => {
    let current: string | null = id
    const seen = new Set<string>()
    while (current && Object.hasOwn(options.overrides || {}, current) && options.overrides![current] !== current) {
      if (seen.has(current)) return null
      seen.add(current)
      current = options.overrides![current]!
    }
    return current
  }
  const ownersFor = (assetId: string): ReferenceOwner[] => {
    const owners = new Map<string, ReferenceOwner>()
    for (const candidate of candidates) {
      if (!owns(candidate, assetId)) continue
      const key = ownerKey(candidate.binding)
      const current = owners.get(key)
      if (!current || candidate.priority < current.priority) owners.set(key, candidate)
    }
    const origins = Object.keys(options.overrides || {}).filter(origin => origin !== assetId && replacement(origin) === assetId)
    const assignments = new Set(candidates.filter(candidate => candidate.priority === 1 && owns(candidate, assetId)
      && origins.some(origin => candidates.some(original => original.priority !== 1
        && ownerKey(original.binding) === ownerKey(candidate.binding) && owns(original, origin))))
      .map(candidate => ownerKey(candidate.binding)))
    if (assignments.size) {
      // An already mapped active binding records the creator's replacement
      // assignment. Do not infer a second character from the library image's
      // other owner. Ordinary shared snapshots, without such an assignment,
      // retain all of their genuine owners.
      return [...owners].filter(([key]) => assignments.has(key)).map(([, owner]) => owner)
    }
    return [...owners.values()]
  }
  type SelectedOwner = { owner: ReferenceOwner; board: string | null; references: VisualReferenceSnapshot[]; selectedIds: string[] }
  const chosen = new Map<string, SelectedOwner>()
  for (const assetId of ids) {
    const direct = ownersFor(assetId)
    // The replacement's own identity wins. Origin metadata is a fallback only
    // for otherwise unowned images, never a reason to rename another owner.
    const matches = direct.length ? direct.map(owner => ({ owner, origin: assetId }))
      : Object.keys(options.overrides || {}).filter(origin => origin !== assetId && replacement(origin) === assetId)
        .flatMap(origin => ownersFor(origin).map(owner => ({ owner, origin })))
    for (const { owner, origin } of matches) {
      const key = ownerKey(owner.binding), current = chosen.get(key)
      const item: SelectedOwner = current || { owner, board: null, references: [], selectedIds: [] }
      if (owner.priority < item.owner.priority) item.owner = owner
      if (!item.selectedIds.includes(assetId)) item.selectedIds.push(assetId)
      if (owner.board === origin) item.board = assetId
      for (const reference of owner.references.filter(reference => reference.asset_id === origin)) {
        const mapped = { ...reference, asset_id: assetId }
        if (!item.references.some(saved => referenceKey(saved) === referenceKey(mapped))) item.references.push(mapped)
      }
      chosen.set(key, item)
    }
  }
  const result = bindings.map(cloneBinding)
  for (const [key, item] of chosen) {
    const existing = result.find(binding => ownerKey(binding) === key)
    if (existing) {
      // Keep every active field frozen, including its definition and board.
      // Only newly selected independent views need additional annotations.
      const references = existing.reference_assets || []
      const added = item.references.filter(reference => !references.some(saved => referenceKey(saved) === referenceKey(reference)))
      if (added.length) existing.reference_assets = [...references, ...added.map(reference => ({ ...reference }))]
      existing.selected_reference_asset_ids = [...new Set([...(existing.selected_reference_asset_ids || []), ...item.selectedIds])]
      continue
    }
    result.push({ ...cloneBinding(item.owner.binding), usage: 'both', required: false,
      board_asset_id: item.board,
      selected_reference_asset_ids: [...item.selectedIds],
      ...(item.references.length ? { reference_assets: item.references.map(reference => ({ ...reference })) }
        : { reference_assets: undefined }),
    })
  }
  return result
}
