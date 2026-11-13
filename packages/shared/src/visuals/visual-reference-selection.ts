import type { VisualReferenceAsset, VisualReferenceView } from './visual-reference-types.js'

/** Supplied by a structured planning result or an explicit creator choice. */
export type VisualReferencePreference = { view?: VisualReferenceView }

/** Select approved references from explicit metadata. Creative prose is never
 * interpreted here: a missing preference uses the creator's confirmed defaults. */
export function recommendVisualReferences(profile: { kind: 'character' | 'location' | 'prop'; revision: number },
  references: VisualReferenceAsset[], preference: VisualReferencePreference | undefined, styleVersion?: string): VisualReferenceAsset[] {
  const eligible = references.filter(reference => reference.status === 'confirmed' && reference.revision === profile.revision
    && (!styleVersion || reference.style_version === styleVersion))
    .sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.id.localeCompare(b.id))
  if (!eligible.length) return []
  const choose = (views: string[]) => views.flatMap(view => eligible.filter(reference => reference.view === view))[0]
  const view = preference?.view
  if (profile.kind === 'character') {
    const preferred = ['front', 'three_quarter', 'side', 'back', 'wide']
    const defaults = preferred.flatMap(view => eligible.filter(reference => reference.is_default && reference.view === view))
    const angle = view ? preferred.includes(view) || view === 'face' ? choose([view]) : undefined : defaults[0] || choose(preferred)
    const face = view !== 'back' && angle?.view !== 'back' ? choose(['face']) : undefined
    // Face identity comes first. Use at most one body angle; never select a character layout as a person reference.
    return [...new Map([face, angle].filter((item): item is VisualReferenceAsset => !!item).map(item => [item.id, item])).values()]
  }
  const match = view ? choose([view]) : undefined
  return match ? [match] : eligible.filter(reference => reference.is_default).slice(0, 1)
}
