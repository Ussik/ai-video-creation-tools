export const visualBindingUsages = ['both', 'image', 'video', 'none'] as const
export type VisualBindingUsage = typeof visualBindingUsages[number]
export const visualBindingUsageLabels: Record<VisualBindingUsage, string> = {
  both: '图片与视频', image: '仅开镜图片', video: '仅视频过程', none: '本镜头不使用',
}

/** Usage is an explicit shot decision, not a guess from names in the prompt.
 * Older clients and saved bindings without this field keep their original use.
 */
export function visualBindingApplies(binding: { usage?: VisualBindingUsage }, modality: string | undefined): boolean {
  const usage = binding.usage || 'both'
  return usage !== 'none' && (usage === 'both' || usage === modality)
}

export function visualBindingsForModality<T extends { usage?: VisualBindingUsage }>(bindings: T[], modality: string | undefined): T[] {
  return bindings.filter(binding => visualBindingApplies(binding, modality))
}
