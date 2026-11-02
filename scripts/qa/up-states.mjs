// Second, independent mock (18101) + models whose remote_id selects behaviour, so analysis
// states can be produced through the ordinary APIs without touching 18100 or its log.
//   qa-slow-*  responds after MOCK_SLOW_MS (default 60s)  -> analysis stays queued/running
//   qa-fail-*  HTTP 400                                   -> analysis ends failed
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
const root = new URL('../../', import.meta.url).pathname, api = 'http://127.0.0.1:18000'
const pidFile = '/tmp/script-agent-qa.pids'
const child = spawn('node', ['scripts/qa/mock-upstream.mjs'], { cwd: root, detached: true, stdio: 'ignore',
  env: { ...process.env, MOCK_PORT: '18101', MOCK_LOG: '/tmp/script-agent-mock-states.jsonl', MOCK_SLOW_MS: process.env.MOCK_SLOW_MS || '60000' } })
child.unref()
const pids = existsSync(pidFile) ? JSON.parse(readFileSync(pidFile, 'utf8')) : []
writeFileSync(pidFile, JSON.stringify([...pids, child.pid]))
for (let i = 0; i < 40; i++) { try { if ((await fetch('http://127.0.0.1:18101/__config')).ok) break } catch {} await new Promise(r => setTimeout(r, 250)) }
const post = async (p, body) => (await fetch(api + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
const provider = await post('/api/providers', { name: 'QA 状态 mock', base_url: 'http://127.0.0.1:18101/v1', api_key: 'qa-mock-key' })
const mk = (name, remote) => post('/api/models', { provider_id: provider.id, name, remote_id: remote, modality: 'text', protocol: 'chat_completions', settings: {
  structured_output_mode: 'json_schema', request_path: 'chat/completions', request_template: { model: '{{model}}', messages: [{ role: 'user', content: '{{prompt}}' }] }, text_path: 'choices.0.message.content' } })
const slow = await mk('QA 慢模型', 'qa-slow-1'), fail = await mk('QA 失败模型', 'qa-fail-1')
console.log(JSON.stringify({ mock: 'http://127.0.0.1:18101', log: 'http://127.0.0.1:18101/__log', slow_model: slow.id, fail_model: fail.id }, null, 1))
