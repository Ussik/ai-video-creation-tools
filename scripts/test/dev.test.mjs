import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const entry = fileURLToPath(new URL('../dev.mjs', import.meta.url))
const unsupported = process.platform === 'win32'

async function fixture(t, buildCode = 0, ignoreDescendantTerm = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'studio-dev-'))
  const events = path.join(directory, 'events.jsonl')
  const npm = path.join(directory, 'npm')
  const descendantCode = `const fs=require('node:fs'); const log=event=>fs.appendFileSync(process.env.STUDIO_DEV_FIXTURE_EVENTS, JSON.stringify({event,pid:process.pid})+'\\n'); process.on('SIGTERM',()=>{if(process.env.STUDIO_DEV_FIXTURE_IGNORE_TERM==='1'){log('ignored');return}log('stopped');process.exit(0)}); log('ready'); setInterval(()=>{},1000)`
  await writeFile(npm, `#!${process.execPath}
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const args=process.argv.slice(2);
const log=value=>fs.appendFileSync(process.env.STUDIO_DEV_FIXTURE_EVENTS,JSON.stringify(value)+'\\n');
if(args.includes('build:shared')) {log({event:'build'});process.exit(Number(process.env.STUDIO_DEV_FIXTURE_BUILD_CODE))}
const child=spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:'ignore'});
process.on('SIGTERM',()=>{log({event:'stopped',pid:process.pid});process.exit(0)});
log({event:'started',workspace:args.find(arg=>arg.startsWith('--workspace=')),pid:process.pid,descendant:child.pid});
setInterval(()=>{},1000);
`)
  await chmod(npm, 0o755)
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, PATH: directory + path.delimiter + process.env.PATH, STUDIO_DEV_FIXTURE_EVENTS: events, STUDIO_DEV_FIXTURE_BUILD_CODE: String(buildCode), STUDIO_DEV_FIXTURE_IGNORE_TERM: ignoreDescendantTerm ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const exited = once(child, 'exit')
  const records = async () => (await readFile(events, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    for (const record of await records()) if (record.event === 'started') {
      try { process.kill(-record.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    await exited
    await rm(directory, { recursive: true, force: true })
  })
  return { child, exited, records, output: () => output }
}

async function until(check) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(30)
  }
  assert.fail('Development process lifecycle did not complete within five seconds')
}

test('failed shared build returns its status and starts no application watchers', { skip: unsupported, timeout: 10000 }, async t => {
  const f = await fixture(t, 7)
  const [code] = await f.exited
  assert.equal(code, 7, f.output())
  assert.deepEqual(await f.records(), [{ event: 'build' }])
})

test('development starts all workspaces after building and stops watcher descendants on termination', { skip: unsupported, timeout: 10000 }, async t => {
  const f = await fixture(t)
  await until(async () => (await f.records()).filter(record => record.event === 'started').length === 3)
  const records = await f.records()
  assert.equal(records[0].event, 'build')
  const started = records.filter(record => record.event === 'started')
  assert.deepEqual(started.map(record => record.workspace).sort(), ['--workspace=@video-studio/shared', '--workspace=backend', '--workspace=web'].sort())
  await until(async () => (await f.records()).filter(record => record.event === 'ready').length === 3)
  const stopStarted = Date.now()
  f.child.kill('SIGTERM')
  const [code] = await f.exited
  assert.equal(code, 143, f.output())
  assert.ok(Date.now() - stopStarted < 3000, 'Cooperative watchers should stop without waiting for the force-kill deadline')
  const expected = started.flatMap(record => [record.pid, record.descendant])
  await until(async () => {
    const stopped = new Set((await f.records()).filter(record => record.event === 'stopped').map(record => record.pid))
    return expected.every(pid => stopped.has(pid))
  })
})

test('development kills remaining descendants after their npm wrappers have exited', { skip: unsupported, timeout: 15000 }, async t => {
  const f = await fixture(t, 0, true)
  await until(async () => (await f.records()).filter(record => record.event === 'ready').length === 3)
  const started = (await f.records()).filter(record => record.event === 'started')
  f.child.kill('SIGINT')
  await until(async () => (await f.records()).filter(record => record.event === 'ignored').length === 3)
  // npm and the terminal can forward the same signal while cleanup is pending.
  f.child.kill('SIGINT')
  f.child.kill('SIGTERM')
  const [code] = await f.exited
  assert.equal(code, 130, f.output())
  await until(() => started.every(record => {
    try { process.kill(record.descendant, 0); return false }
    catch (error) { if (error.code !== 'ESRCH') throw error; return true }
  }))
})
