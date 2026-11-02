// Starts isolated backend (18000) + vite (18888) + mock upstream (18100) with a seeded project.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
const root = new URL('../../', import.meta.url).pathname
const data = process.env.QA_DATA_DIR || '/tmp/script-agent-qa-data'
mkdirSync(data, { recursive: true })
const env = { ...process.env, VIDEO_STUDIO_DATA_DIR: data, PORT: '18000', VITE_DEV_PORT: '18888', VITE_API_TARGET: 'http://127.0.0.1:18000', MOCK_PORT: '18100' }
const pids = []
const pidFile = '/tmp/script-agent-qa.pids'
const run = (cmd, args, cwd = root) => { const child = spawn(cmd, args, { cwd, env, stdio: 'inherit', detached: true }); pids.push(child.pid); writeFileSync(pidFile, JSON.stringify(pids)); return child }
run('node', ['scripts/qa/mock-upstream.mjs'])
run('npx', ['tsx', 'src/server.ts'], root + 'backend')
run('npx', ['vite', '--host', '127.0.0.1'], root + 'web')
const api = (p, o = {}) => fetch(`http://127.0.0.1:18000${p}`, o)
for (let i = 0; i < 60; i++) { try { if ((await api('/api/projects')).ok) break } catch {} await new Promise(r => setTimeout(r, 500)) }
const ready = async () => {
  const checks = { web: 'http://127.0.0.1:18888/', api: 'http://127.0.0.1:18000/api/projects', mock: 'http://127.0.0.1:18100/__config' }
  const bad = []
  for (const [name, url] of Object.entries(checks)) { let ok = false; for (let i = 0; i < 40 && !ok; i++) { try { ok = (await fetch(url)).ok } catch {} if (!ok) await new Promise(r => setTimeout(r, 500)) } if (!ok) bad.push(name) }
  if (bad.length) { console.error('NOT READY: ' + bad.join(', ')); process.exit(1) }
  console.log('READY web=http://127.0.0.1:18888 api=http://127.0.0.1:18000 mock-log=http://127.0.0.1:18100/__log')
}
const json = async (p, body) => (await api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
const existing = await (await api('/api/projects')).json()
if (Array.isArray(existing) && existing.some(p => p.name.startsWith('QA '))) { console.log('already seeded', existing.map(p => `${p.name}:${p.id}`).join(' ')); await ready(); process.exit(0) }
const provider = await json('/api/providers', { name: 'QA mock 上游', base_url: 'http://127.0.0.1:18100/v1', api_key: 'qa-mock-key' })
const model = await json('/api/models', { provider_id: provider.id, name: 'QA mock 文本模型', remote_id: 'mock', modality: 'text', protocol: 'chat_completions', settings: {
  structured_output_mode: 'json_schema', request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
for (const [name, file] of [['QA 短原稿', 'short-source.txt'], ['QA 长原稿', 'long-source.txt']]) {
  const project = await json('/api/projects', { name })
  const fd = new FormData(); fd.append('file', new Blob([readFileSync(`/tmp/agent-research-20261101/acceptance/${file}`)], { type: 'text/plain' }), file)
  await api(`/api/projects/${project.id}/script/source`, { method: 'POST', body: fd })
  console.log(`QA project ${name}: ${project.id}  model=${model.id}`)
}
await ready()
