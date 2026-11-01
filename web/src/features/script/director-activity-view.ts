import { activityStatusLabel, type ScriptActivity } from './director-activity'

export type ActivityNode = { event: ScriptActivity; children: ActivityNode[]; waiting: boolean }
export type ActivityDisplayStatus = ScriptActivity['status'] | 'waiting' | 'unconfirmed'

/** Presentation only: never rewrite persisted traces or infer ownership from
 * labels/timing. Old, orphaned and cyclic records remain visible in order. */
export function activitySequence(events: ScriptActivity[]) {
  const nodes = new Map(events.map(event => [event.id, { event, children: [], waiting: false } as ActivityNode]))
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
  const status: ActivityDisplayStatus = event.status === 'running' && !pending ? 'unconfirmed' : event.status
  const label = status === 'unconfirmed' ? '未记录完成' : event.kind === 'skill' && event.status === 'succeeded' ? '规则已加载' : activityStatusLabel(event)
  return { status, label }
}

export function activityDuration(event: ScriptActivity, now: number, pending?: boolean) {
  if (event.scope === 'notice' || event.reused || event.status === 'running' && !pending) return undefined
  return event.status === 'running' ? Math.max(0, now - event.started_at) : event.duration_ms
}
