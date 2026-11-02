// Prepares fresh QA projects (never touches existing ones) and drives analysis / task states through public APIs.
//   node scripts/qa/states.mjs new <name> [short|long|multi]  (multi = 30 small episodes, for local-source Q&A)      -> creates project with uploaded source, prints id
//   node scripts/qa/states.mjs analyze <project> <model>    -> POST source/analysis (slow model: queued/running; fail model: failed)
//   node scripts/qa/states.mjs pause <project>              -> pause current analysis
//   node scripts/qa/states.mjs status <project>             -> analysis status
//   node scripts/qa/states.mjs replace <project> [short|long] -> re-upload source (changes version, cancels analysis)
//   node scripts/qa/states.mjs task <project> <model>       -> start a resumable source_outline task over SSE, print task id
//   node scripts/qa/states.mjs task-status|cancel|continue <project> <taskId>
import { readFileSync } from 'node:fs'
const api = 'http://127.0.0.1:18000/api', dir = '/tmp/agent-research-20261101/acceptance/'
const [cmd, a, b] = process.argv.slice(2)
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t) } catch { return t } }
const post = (p, body) => fetch(api + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(j)
const upload = async (project, kind) => {
  const fd = new FormData(); const file = kind === 'long' ? 'long-source.txt' : kind === 'multi' ? 'qa-multi-episode-source.txt' : 'short-source.txt'
  fd.append('file', new Blob([readFileSync(dir + file) + (kind === 'v2' ? '\n新增版本尾段。' : '')], { type: 'text/plain' }), file)
  return fetch(`${api}/projects/${project}/script/source`, { method: 'POST', body: fd }).then(j)
}
if (cmd === 'new') { const p = await post('/projects', { name: a }); const s = await upload(p.id, b || 'short'); console.log(JSON.stringify({ project: p.id, updated_at: s.updated_at })) }
else if (cmd === 'analyze') { const s = await fetch(`${api}/projects/${a}/script/source`).then(j); console.log(JSON.stringify(await post(`/projects/${a}/script/source/analysis`, { model_id: b, source_updated_at: s.updated_at }), (k, v) => k === 'sections' ? undefined : v)) }
else if (cmd === 'pause') { const st = await fetch(`${api}/projects/${a}/script/source/analysis`).then(j); console.log(JSON.stringify(await post(`/projects/${a}/script/source/analysis/pause`, { analysis_id: st.id }), (k, v) => k === 'sections' ? undefined : v)) }
else if (cmd === 'status') { const st = await fetch(`${api}/projects/${a}/script/source/analysis`).then(j); console.log(JSON.stringify({ id: st?.id, status: st?.status, phase: st?.phase, source_version: st?.source_version, error: st?.error })) }
else if (cmd === 'replace') console.log(JSON.stringify(await upload(a, b === 'long' ? 'long' : 'v2'), (k, v) => k === 'content' ? undefined : v))
else if (cmd === 'task') {
  const id = crypto.randomUUID()
  const body = { task: { id, conversation: { id: crypto.randomUUID(), messages: [{ id: crypto.randomUUID(), role: 'user', text: '整理原稿大纲' }] }, execution: { title: '整理原稿大纲', request: '整理原稿大纲', started_at: Date.now(), workflow: { stage: 'outline', scope: 'project', episode_number: 0, intent: 'source_outline', artifact_types: ['outline'] } } },
    model_id: b, mode: 'script', use_tools: false, workflow: { stage: 'outline', intent: 'source_outline', artifact_types: ['outline'] }, messages: [{ role: 'user', text: '整理原稿大纲' }] }
  const r = await fetch(`${api}/projects/${a}/script/director/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  console.log(JSON.stringify({ task_id: id, http: r.status })); setTimeout(() => process.exit(0), 1500)
}
else if (cmd === 'task-status') console.log(JSON.stringify(await fetch(`${api}/projects/${a}/script/director/tasks/${b}`).then(j), (k, v) => k === 'events' ? `[${v.length} events]` : v))
else if (cmd === 'cancel') console.log(JSON.stringify(await post(`/projects/${a}/script/director/tasks/${b}/cancel`, {}), (k, v) => k === 'events' ? `[${v.length} events]` : v))
else if (cmd === 'continue') console.log(JSON.stringify(await post(`/projects/${a}/script/director/tasks/${b}/continue`, {}), (k, v) => k === 'events' ? `[${v.length} events]` : v))
else console.log('unknown command')
