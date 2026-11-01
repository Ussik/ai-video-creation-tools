export type SkillSyncItem = {
  id: string
  name: string
  status: 'updated' | 'unchanged' | 'failed'
  revision?: string
  error?: string
}

export type SkillSyncResult = {
  total: number
  updated: number
  unchanged: number
  failed: number
  results: SkillSyncItem[]
}
