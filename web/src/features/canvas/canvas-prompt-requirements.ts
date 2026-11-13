import type { ManagedPromptBlockName } from '@video-studio/shared/visuals/prompt-document'
import type { PromptSectionBlock } from '@video-studio/shared/visuals/prompt-section-document'

/** Display order only. Persisted documents and reference inputs keep their own order. */
export const promptRequirementNames = [
  '设定图固定要求',
  '图片生成要求',
  '项目画风约束',
  '镜头视觉设定',
  '图片参考图用途',
  '视频参考图用途',
  '视频生成要求',
  '基础身份参考',
  '基础版本与本次状态变化',
  '生成参考图',
  '生成参数约束',
] as const satisfies readonly ManagedPromptBlockName[]

export type PromptRequirementStatus = 'active' | 'unconfigured' | 'not_applicable'
export type PromptRequirementEntry = {
  id: string
  name: ManagedPromptBlockName
  block?: PromptSectionBlock
  status: PromptRequirementStatus
  primary: boolean
  /** Historical identities, never a reason to hide an active same-name block. */
  removedBlocks?: readonly PromptSectionBlock[]
}

type PromptRequirementTask = 'board' | 'image' | 'video'
const applicableTasks = {
  '设定图固定要求': ['board'],
  '图片生成要求': ['board', 'image'],
  '项目画风约束': ['board', 'image', 'video'],
  '镜头视觉设定': ['image', 'video'],
  '图片参考图用途': ['image'],
  '视频参考图用途': ['video'],
  '视频生成要求': ['video'],
  '基础身份参考': ['board'],
  '基础版本与本次状态变化': ['board'],
  '生成参考图': ['board'],
  '生成参数约束': ['board', 'image', 'video'],
} satisfies Record<ManagedPromptBlockName, readonly PromptRequirementTask[]>

/** The saved active document is authoritative, including imported or legacy
 * sections outside the usual task catalogue. Missing entries describe the
 * current task only; browsing them never creates or restores a section. */
export function buildPromptRequirements({ blocks, visualBoard, modality }: {
  blocks: readonly PromptSectionBlock[]
  visualBoard: boolean
  modality?: 'image' | 'video'
}): PromptRequirementEntry[] {
  const task: PromptRequirementTask | undefined = visualBoard ? 'board' : modality
  return promptRequirementNames.flatMap<PromptRequirementEntry>(name => {
    const sameName = blocks.filter(block => block.kind === 'managed' && block.name === name)
    const active = sameName.filter(block => !block.deleted)
    const removed = sameName.filter(block => block.deleted)
    const primary = visualBoard && name === '设定图固定要求'
    const history = removed.length ? { removedBlocks: removed } : {}
    if (active.length) return active.map(block => ({ id: block.id, name, block, status: 'active' as const, primary, ...history }))
    const tasks: readonly PromptRequirementTask[] = applicableTasks[name]
    return [{ id: `missing:${name}`, name, primary, ...history,
      status: task && !tasks.includes(task) ? 'not_applicable' as const : 'unconfigured' as const }]
  })
}
