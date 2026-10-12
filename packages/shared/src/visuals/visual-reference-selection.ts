import type { VisualReferenceAsset } from './visual-reference-types.js'

/** A suggestion from the written camera description, never an identity verdict. */
export function recommendVisualReferences(profile: { kind: 'character' | 'location' | 'prop'; revision: number },
  references: VisualReferenceAsset[], shotText: string, styleVersion?: string): VisualReferenceAsset[] {
  const eligible = references.filter(reference => reference.status === 'confirmed' && reference.revision === profile.revision
    && (!styleVersion || reference.style_version === styleVersion))
    .sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.id.localeCompare(b.id))
  if (!eligible.length) return []
  const choose = (views: string[]) => views.flatMap(view => eligible.filter(reference => reference.view === view))[0]
  let view: string | undefined
  if (/背面|背影|背拍|背后拍|rear\s+view|back\s+view/i.test(shotText)) view = 'back'
  else if (/四分之三|三分之四|3\s*\/\s*4|three.quarter/i.test(shotText)) view = 'three_quarter'
  else if (/侧面|侧脸|侧拍|侧视|profile\s+view|side\s+view/i.test(shotText)) view = 'side'
  else if (/正面|正脸|front\s+view/i.test(shotText)) view = 'front'
  if (profile.kind === 'character') {
    const preferred = ['front', 'three_quarter', 'side', 'back', 'wide']
    const angle = view ? choose([view]) : eligible.find(reference => reference.is_default && preferred.includes(reference.view)) || choose(preferred)
    const face = view !== 'back' && angle?.view !== 'back' ? choose(['face']) : undefined
    // Face identity comes first. Use at most one body angle; never select a character layout as a person reference.
    return [...new Map([face, angle].filter((item): item is VisualReferenceAsset => !!item).map(item => [item.id, item])).values()]
  }
  if (profile.kind === 'location') {
    const target = /反打|reverse\s+(shot|angle)/i.test(shotText) ? 'reverse'
      : /全景|远景|广角|wide\s+shot|establishing/i.test(shotText) ? 'wide' : view
    const match = target ? choose([target]) : undefined
    return match ? [match] : eligible.filter(reference => reference.is_default).slice(0, 1)
  }
  const target = /特写|近景|细节|close.up|detail/i.test(shotText) ? 'detail' : view
  const match = target ? choose([target]) : undefined
  return match ? [match] : eligible.filter(reference => reference.is_default).slice(0, 1)
}
