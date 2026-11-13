import { activityStatusLabel, type ScriptActivity } from './director-activity'
import { activityOutputRecoveries, type ActivityOutputRecovery, type ActivityRecoveryOptions } from './director-activity-recovery'

export type ActivityNode = { event: ScriptActivity; children: ActivityNode[]; waiting: boolean; recovery?: ActivityOutputRecovery }
export type ActivityDisplayStatus = ScriptActivity['status'] | 'waiting' | 'unconfirmed' | ActivityOutputRecovery

function activityDisplayEvent(event: ScriptActivity, events: ScriptActivity[]): ScriptActivity {
  if (event.scope !== 'task' || event.status !== 'succeeded' || event.reused !== undefined ||
      !event.step_id || !/^work:(outline|characters|locations|props|episode):[^/]+$/.test(event.step_id)) return event
  // Older task wrappers omitted checkpoint reuse metadata. Their checkpoint
  // steps are siblings, identified by stable IDs rather than labels or clocks.
  const stepIds = new Set([`${event.step_id}/draft`, `${event.step_id.replace(/^work:/, 'work:document:')}/draft`])
  const matches = events.filter(step => step.scope === 'step' && step.parent_id === event.parent_id && stepIds.has(step.step_id || ''))
  if (matches.length !== 1 || matches[0].status !== 'succeeded' || !matches[0].reused) return event
  // Neither old wrapper nor replay step recorded trustworthy original timing.
  // Change only this display copy; never replace saved history or guess time.
  return { ...event, reused: true, duration_ms: undefined }
}

/** Presentation only: never rewrite persisted traces or infer ownership from
 * labels/timing. Old, orphaned and cyclic records remain visible in order. */
export function activitySequence(events: ScriptActivity[], options?: ActivityRecoveryOptions) {
  const recoveries = activityOutputRecoveries(events, options)
  const nodes = new Map(events.map(event => [event.id, { event: activityDisplayEvent(event, events), children: [], waiting: false, recovery: recoveries.get(event.id) } as ActivityNode]))
  const roots: ActivityNode[] = []
  for (const event of events) {
    const node = nodes.get(event.id)!
    let parent = event.parent_id ? nodes.get(event.parent_id) : undefined
    const seen = new Set([event.id])
    let ancestor = parent
    while (ancestor) {
      if (seen.has(ancestor.event.id)) { parent = undefined; break }
      seen.add(ancestor.event.id)
      ancestor = ancestor.event.parent_id ? nodes.get(ancestor.event.parent_id) : undefined
    }
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const markWaiting = (node: ActivityNode): boolean => {
    const descendants = node.children.map(markWaiting).some(Boolean)
    node.waiting = node.event.status === 'running' && descendants
    return node.event.scope !== 'notice' && node.event.status === 'running' || descendants
  }
  roots.forEach(markWaiting)
  const tasks: ActivityNode[] = [], steps: ActivityNode[] = []
  const notices = events.filter(event => event.scope === 'notice').map(event => nodes.get(event.id)!)
  const promote = (node: ActivityNode) => {
    if (node.event.scope === 'notice') {
      node.children.forEach(promote)
    } else if (node.event.scope === 'task') {
      tasks.push(node)
      node.children.forEach(promote)
    } else steps.push(node)
  }
  roots.forEach(promote)
  const order = new Map(events.map((event, index) => [event.id, index]))
  steps.sort((a, b) => order.get(a.event.id)! - order.get(b.event.id)!)
  const active = [...events].reverse().map(event => nodes.get(event.id)!).find(node => node.event.scope !== 'notice' && node.event.status === 'running' && !node.waiting)
  const current = active && [...steps, ...tasks.slice().reverse()].find(step => [step, ...activityCalls(step).map(call => call.node)].includes(active))
  return { steps, tasks, notices, active, current }
}

export function activityCalls(step: ActivityNode) {
  const calls: Array<{ node: ActivityNode; depth: number }> = []
  const visit = (node: ActivityNode, depth: number) => {
    for (const child of node.children) {
      if (child.event.scope === 'notice') visit(child, depth)
      else {
        calls.push({ node: child, depth })
        visit(child, depth + 1)
      }
    }
  }
  visit(step, 0)
  return calls
}

export function activityPresentation(node: ActivityNode, pending?: boolean) {
  const event = node.event
  const status: ActivityDisplayStatus = event.status === 'failed' && node.recovery && (pending || node.recovery === 'continued') ? node.recovery
    : event.status === 'running' && !pending ? 'unconfirmed' : event.status
  const label = status === 'continuing' ? '已截断，正在接续' : status === 'continued' ? '已截断，已继续处理'
    : status === 'unconfirmed' ? '未记录完成' : event.kind === 'skill' && event.status === 'succeeded' ? '规则已加载' : activityStatusLabel(event)
  return { status, label }
}

export function activityDuration(event: ScriptActivity, now: number, pending?: boolean) {
  if (event.scope === 'notice' || event.status === 'running' && (!pending || event.reused)) return undefined
  // Replayed timestamps describe this restoration, not the original work.
  // Older retained checkpoints used zero for an unknown original duration.
  const validStart = Number.isFinite(event.started_at) && event.started_at > 0
  const duration = event.status === 'running' ? validStart ? Math.max(0, now - event.started_at) : undefined
    : event.duration_ms ?? (!event.reused && validStart && event.ended_at !== undefined && event.ended_at >= event.started_at ? event.ended_at - event.started_at : undefined)
  return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 && (!event.reused || duration > 0) ? duration : undefined
}

export function activityDurationTitle(event: ScriptActivity) {
  return event.reused ? '此前生成用时' : event.scope === 'task' ? '任务用时（包含内部步骤）' : '步骤用时（包含内部调用）'
}
