import type { PromptReferenceOverrides } from '@video-studio/shared/visuals/prompt-references'
import { extractPromptReferenceIds, resolvePromptReferences } from '@video-studio/shared/visuals/prompt-references'
import type { PromptVisualBinding } from '@video-studio/shared/visuals/visual-prompt'
import type { CanvasGraph } from './ProjectCanvas'

export function replacePromptReference(overrides: PromptReferenceOverrides = {}, source: string, replacement: string | null): PromptReferenceOverrides {
  const next = { ...overrides }
  for (const [id, target] of Object.entries(next)) if (target === source) next[id] = replacement
  next[source] = replacement
  for (const [id, target] of Object.entries(next)) if (id === target) delete next[id]
  return next
}

export function promptReferenceBindings<T extends PromptVisualBinding>(bindings: T[], overrides: PromptReferenceOverrides = {}): T[] {
  const target = (id: string) => Object.hasOwn(overrides, id) ? overrides[id] : id
  return bindings.map(binding => ({ ...binding,
    board_asset_id: binding.board_asset_id ? target(binding.board_asset_id) || null : null,
    reference_assets: binding.reference_assets?.flatMap(reference => {
      const asset_id = target(reference.asset_id)
      return asset_id ? [{ ...reference, asset_id }] : []
    }),
  }))
}

/** A mention describes an existing input. It must never resurrect a disconnected
 * image just because its stable token is still present in edited prose. */
export function disconnectedPromptReferenceIds(prompt: string, referenceAssetIds: string[], overrides: PromptReferenceOverrides = {}): string[] {
  const active = resolvePromptReferences({ prompt: '', referenceAssetIds, overrides })
  return extractPromptReferenceIds(prompt).filter(id => {
    const mapped = Object.hasOwn(active.replacements, id) ? active.replacements[id] : id
    return mapped === null || !active.referenceAssetIds.includes(mapped!)
  })
}

/** Removing a visible replacement also disconnects the binding it replaced.
 * Leave its explicit mention intact so the editor can show the broken link. */
export function disconnectRemovedPromptReplacements(previous: CanvasGraph, next: CanvasGraph): CanvasGraph {
  if (previous.edges === next.edges) return next
  const removed = previous.edges.filter(edge => edge.reference_asset_id && !next.edges.some(item => item.id === edge.id
    && item.source === edge.source && item.target === edge.target && item.reference_asset_id === edge.reference_asset_id))
  if (!removed.length) return next
  let changed = false
  const nodes = next.nodes.map(node => {
    const relevant = removed.filter(edge => edge.target === node.id).map(edge => edge.reference_asset_id!)
    const overrides = node.settings.prompt_reference_overrides
    if (!relevant.length || !overrides) return node
    let updated = overrides
    for (const key of Object.keys(overrides)) {
      const finalId = resolvePromptReferences({ prompt: '', referenceAssetIds: [key], overrides }).referenceAssetIds[0]
      if (!finalId || !relevant.includes(finalId) || next.edges.some(edge => edge.target === node.id
        && edge.reference_asset_id && resolvePromptReferences({ prompt: '', referenceAssetIds: [edge.reference_asset_id], overrides }).referenceAssetIds.includes(finalId))) continue
      updated = { ...updated, [key]: null }
    }
    if (updated === overrides) return node
    changed = true
    return { ...node, settings: { ...node.settings, prompt_reference_overrides: updated } }
  })
  return changed ? { ...next, nodes } : next
}
