export { MAX_AUXILIARY_SKILLS } from '@video-studio/shared/skills/skill-limits'
export type { SkillSyncResult } from '@video-studio/shared/skills/skill-updates'
export type { SkillTaskContext, SkillTaskKind } from '@video-studio/shared/skills/skill-recommendation'
import type { SkillCatalogEntry, SkillTaskKind } from '@video-studio/shared/skills/skill-recommendation'
export type SkillStage = 'script' | 'visual_assets' | 'image_prompt' | 'storyboard' | 'video_prompt'
export type SkillSelections = Partial<Record<SkillStage, string[]>>
export type CreativeSkillSelection = { ids: string[]; source: 'automatic' | 'default' | 'manual'; reason: string; task_label: string; task_kind?: SkillTaskKind }
export type SkillAssignment = { ids: string[]; source: CreativeSkillSelection['source'] | 'fixed'; reason: string; task?: SkillTaskKind }
export type SkillPolicy = { stage: SkillStage; label: string; primary_id: string | null; auxiliary_ids: string[]; source: 'builtin' | 'global' | 'project'; warning: string;
  skills: SkillCatalogEntry[] }
export type SkillTaskPolicy = SkillPolicy & { task: SkillTaskKind }
export const skillStageOptions: Array<{ value: SkillStage; label: string }> = [
  { value: 'script', label: '剧本创作' }, { value: 'visual_assets', label: '视觉设定' },
  { value: 'image_prompt', label: '图片提示词' }, { value: 'storyboard', label: '分镜规划' }, { value: 'video_prompt', label: '视频提示词' },
]
export interface DiscoverableSkill { repo: string; path: string; name: string; description: string; installs: number | null; url: string }
export interface InstalledSkill {
  id: string; repo: string; path: string; name: string; description: string; revision: string; license: string | null;
  tool_requirements: string[]; suggested_stages: SkillStage[]; stages: SkillStage[]; enabled: boolean; url: string;
  installed_at: string; updated_at: string;
}
export type SkillDetail = Omit<InstalledSkill, 'id' | 'enabled' | 'stages' | 'installed_at' | 'updated_at'> & {
  id?: string; enabled?: boolean; stages?: SkillStage[]; files: Array<{ path: string; content: string }>;
}
export const recommendedSkills: DiscoverableSkill[] = [
  ['short-drama-assets', '视觉资产整理', '从剧本整理人物、场景、道具与状态版本，明确跨场次需要保持的设定。'],
  ['short-drama-image-prompts', '信息图与图片提示词', '编写人物多视图、场景板与道具信息图提示词，明确每张参考图的用途。'],
  ['short-drama-storyboard', '分镜规划', '将场次拆成镜头，明确景别、机位、起止状态与参考图需求。'],
  ['short-drama-video-prompts', '视频提示词', '从分镜与关键帧整理动作、表演、运镜、声音和时序。'],
  ['short-drama-write', '剧本创作', '增强分集剧本的因果、对白、动作与可拍摄性。'],
].map(([name, label, description]) => ({ repo: 'zenstory-ai/drama-skills', path: name, name, description: `${label} · ${description}`, installs: null,
  url: `https://skills.sh/zenstory-ai/drama-skills/${name}` }))

export function skillMatches(installed: InstalledSkill, source: Pick<DiscoverableSkill, 'repo' | 'name' | 'path'>): boolean {
  return installed.repo === source.repo.toLowerCase() && (installed.path === source.path || installed.name === source.name)
}
