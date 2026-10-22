import type { ProjectDetail, VisualProfile } from '../../shared/api/api'
import type { CanvasGraph } from './ProjectCanvas'
import { visualBoardJobs } from './canvas-visual-profiles'
import { orderedVisualProfiles, visualProfileBaseChain, visualProfileBaseReadiness, visualProfileBoardReady, visualProfileLabel } from '../visuals/visual-profile-inheritance'

export type ReferenceBatchItem = {
  profileId: string; revision: number; fingerprint: string;
  status: 'pending' | 'submitting' | 'submitted' | 'failed'; jobIds: string[]; message?: string;
}
export type ReferenceBatchState = {
  version: 1; projectId: string; canvasId: string; targetId: string;
  styleVersion: string | null; items: ReferenceBatchItem[];
}
export type ReferenceBatchDecision = {
  ready: Array<{ profileId: string }>; waiting: Array<{ profileId: string; message: string }>;
  blocked: Array<{ profileId: string; message: string }>; completed: string[];
}
const profileFingerprint = (profile: VisualProfile) => JSON.stringify([profile.kind, profile.name, profile.variant,
  profile.definition, profile.view_requirements, profile.base_profile_id || null, profile.state_delta || ''])
export const referenceBatchStorageKey = (projectId: string, canvasId: string) => `project-reference-batch:${JSON.stringify([projectId, canvasId])}`

export function createReferenceBatch(input: { projectId: string; canvasId: string; targetId: string; profileIds: string[] }, detail: ProjectDetail): ReferenceBatchState {
  const profiles = detail.visual_profiles || [], selected = new Map<string, VisualProfile>()
  for (const id of input.profileIds) {
    const profile = profiles.find(item => item.id === id)
    if (!profile) throw new Error('所需视觉设定已移除，请重新检查引用。')
    const chain = visualProfileBaseChain(profile, profiles)
    if (chain.error) throw new Error(chain.error)
    for (const base of chain.ancestors) selected.set(base.id, base)
    selected.set(id, profile)
  }
  return { version: 1, projectId: input.projectId, canvasId: input.canvasId, targetId: input.targetId,
    styleVersion: detail.project_visual_style?.version || null,
    items: orderedVisualProfiles([...selected.values()]).map(profile => ({ profileId: profile.id, revision: profile.revision,
      fingerprint: profileFingerprint(profile), status: 'pending', jobIds: [] })) }
}

function changeItem(state: ReferenceBatchState, profileId: string, patch: Partial<ReferenceBatchItem>): ReferenceBatchState {
  return { ...state, items: state.items.map(item => item.profileId === profileId ? { ...item, ...patch } : item) }
}
export const markReferenceBatchSubmitting = (state: ReferenceBatchState, profileId: string) => changeItem(state, profileId, { status: 'submitting', message: undefined })
export const recordReferenceBatchSubmission = (state: ReferenceBatchState, profileId: string, jobIds: string[]) => {
  if (!jobIds.length) throw new Error('生成任务未返回编号，不能自动重发；请核对任务记录。')
  return changeItem(state, profileId, { status: 'submitted', jobIds: [...new Set(jobIds)], message: undefined })
}
export const recordReferenceBatchFailure = (state: ReferenceBatchState, profileId: string, message: string) => changeItem(state, profileId, { status: 'failed', message })

/** This planner reads declared identity relations and accepted job IDs. Manual
 * reference lines are evaluated by board preview, never treated as DAG edges. */
export function evaluateReferenceBatch(state: ReferenceBatchState, graph: CanvasGraph, detail: ProjectDetail): ReferenceBatchDecision {
  const result: ReferenceBatchDecision = { ready: [], waiting: [], blocked: [], completed: [] }
  if (!graph.nodes.some(node => node.id === state.targetId)) {
    result.blocked = state.items.map(item => ({ profileId: item.profileId, message: '目标节点已移除，已停止自动生成。' }))
    return result
  }
  for (const item of state.items) {
    const profile = detail.visual_profiles?.find(profile => profile.id === item.profileId)
    const block = (message: string) => result.blocked.push({ profileId: item.profileId, message })
    const wait = (message: string) => result.waiting.push({ profileId: item.profileId, message })
    if (!profile) { block('设定已移除，已停止此项自动生成。'); continue }
    if (state.projectId !== detail.id || state.styleVersion !== (detail.project_visual_style?.version || null) || item.fingerprint !== profileFingerprint(profile)) {
      block('设定或项目画风已变化，请检查后重新发起。'); continue
    }
    const inheritance = visualProfileBaseReadiness(profile, detail)
    if (inheritance.error) { block(inheritance.error); continue }
    if (visualProfileBoardReady(profile, detail)) { result.completed.push(profile.id); continue }
    if (profile.board_style_status === 'needs_review' || profile.base_reference_status === 'needs_review') {
      block('参考图或基础来源已更新，请核对并重新确认后继续。'); continue
    }
    if (item.status === 'failed') { block(item.message || '此项生成失败，请检查任务记录后手动重试。'); continue }
    const node = graph.nodes.find(node => node.settings.visual_profile_id === profile.id)
    const acceptedJobs = item.jobIds.map(id => detail.jobs.find(job => job.id === id))
    const boardJobs = visualBoardJobs(profile, detail.jobs)
    const nodeJob = node?.job_id && detail.jobs.find(job => job.id === node.job_id)
    const activeJobs = [...boardJobs, ...(nodeJob ? [nodeJob] : []), ...acceptedJobs.filter(job => !!job)]
    if (detail.asset_tasks.some(task => task.id === profile.asset_task_id && task.status === 'generating')) { wait('当前设定图正在生成，完成并确认后自动继续。'); continue }
    if (activeJobs.some(job => job?.status === 'queued' || job?.status === 'running')) { wait('当前设定图正在生成，完成并确认后自动继续。'); continue }
    if (item.status === 'submitting') { block('上次提交是否成功尚不确定，请先核对任务记录；已停止自动重发。'); continue }
    if (item.status === 'submitted') {
      if (acceptedJobs.some(job => !job)) { wait('生成任务已提交，正在同步任务状态。'); continue }
      if (acceptedJobs.some(job => job?.status === 'succeeded')) { wait('生成已完成，等待确认可用候选图后继续。'); continue }
      block('已提交的生成任务未成功，请查看失败原因后手动重试。'); continue
    }
    if (boardJobs.some(job => job.status === 'succeeded' && !!job.result_asset_id && detail.assets.some(asset => asset.id === job.result_asset_id))) {
      wait('已有生成候选，确认可用设定图后继续。'); continue
    }
    if (inheritance.waitingProfile) {
      const parent = state.items.find(item => item.profileId === inheritance.waitingProfile!.id)
      if (parent?.status === 'failed') block(`基础设定「${visualProfileLabel(inheritance.waitingProfile)}」生成失败，请先处理基础图。`)
      else wait(`等待「${visualProfileLabel(inheritance.waitingProfile)}」的基础图确认。`)
      continue
    }
    result.ready.push({ profileId: item.profileId })
  }
  return result
}

type BatchStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const defaultStorage = (): BatchStorage | undefined => {
  try { return typeof window !== 'undefined' ? window.localStorage : undefined } catch { return undefined }
}
export function writeReferenceBatch(state: ReferenceBatchState, storage = defaultStorage()): boolean {
  try { if (!storage) return false; storage.setItem(referenceBatchStorageKey(state.projectId, state.canvasId), JSON.stringify(state)); return true } catch { return false }
}
export function clearReferenceBatch(projectId: string, canvasId: string, storage = defaultStorage()): void {
  try { storage?.removeItem(referenceBatchStorageKey(projectId, canvasId)) } catch { /* State remains safe in this mounted worker. */ }
}
export function readReferenceBatch(projectId: string, canvasId: string, storage = defaultStorage()): ReferenceBatchState | null {
  try {
    const raw = storage?.getItem(referenceBatchStorageKey(projectId, canvasId))
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<ReferenceBatchState>
    if (value.version !== 1 || value.projectId !== projectId || value.canvasId !== canvasId || typeof value.targetId !== 'string' ||
      !(value.styleVersion === null || typeof value.styleVersion === 'string') || !Array.isArray(value.items) || value.items.length > 500 ||
      value.items.some(item => !item || typeof item.profileId !== 'string' || !item.profileId || !Number.isInteger(item.revision) || item.revision < 1 ||
        typeof item.fingerprint !== 'string' || !['pending', 'submitting', 'submitted', 'failed'].includes(item.status) || !Array.isArray(item.jobIds) || item.jobIds.some(id => typeof id !== 'string' || !id)) ||
      new Set(value.items.map(item => item.profileId)).size !== value.items.length) return null
    return value as ReferenceBatchState
  } catch { return null }
}
