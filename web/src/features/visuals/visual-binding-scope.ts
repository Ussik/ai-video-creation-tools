import { visualBindingApplies, type VisualBindingUsage } from '@video-studio/shared/visuals/visual-binding-usage'

export type VisualBindingScope = 'image' | 'video'

export function visualBindingScopeEnabled(binding: { usage?: VisualBindingUsage } | undefined, scope?: VisualBindingScope): boolean {
  return !!binding && (!scope || visualBindingApplies(binding, scope))
}

/** Change one output's use without removing the other output's saved choice.
 * An existing legacy binding without usage retains its original "both" use. */
export function toggleVisualBindingScope(usage: VisualBindingUsage | undefined, scope: VisualBindingScope, enabled: boolean): VisualBindingUsage {
  const image = scope === 'image' ? enabled : visualBindingApplies({ usage }, 'image')
  const video = scope === 'video' ? enabled : visualBindingApplies({ usage }, 'video')
  return image ? video ? 'both' : 'image' : video ? 'video' : 'none'
}
