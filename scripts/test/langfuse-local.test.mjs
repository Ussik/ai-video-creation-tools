import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import test from 'node:test'
import { composeArgs, main, setupLangfuse } from '../langfuse-local.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'langfuse-local-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('setup creates private matching credentials once without printing any secret', async t => {
  const root = await fixture(t), output = []
  await main(['setup'], { root, log: value => output.push(value), run: () => assert.fail('setup must not invoke Docker') })
  const dockerPath = join(root, '.env.langfuse.docker.local'), appPath = join(root, '.env.langfuse.local')
  const beforeDocker = await readFile(dockerPath, 'utf8'), beforeApp = await readFile(appPath, 'utf8')
  const docker = parseEnv(beforeDocker), app = parseEnv(beforeApp)
  assert.equal(app.LANGFUSE_PUBLIC_KEY, docker.LANGFUSE_INIT_PROJECT_PUBLIC_KEY)
  assert.equal(app.LANGFUSE_SECRET_KEY, docker.LANGFUSE_INIT_PROJECT_SECRET_KEY)
  assert.equal(app.LANGFUSE_BASE_URL, 'http://127.0.0.1:3035')
  assert.equal(app.LANGFUSE_TRACING, 'true')
  assert.match(docker.ENCRYPTION_KEY, /^[a-f0-9]{64}$/)
  for (const file of [dockerPath, appPath]) assert.equal((await stat(file)).mode & 0o777, 0o600)
  for (const value of [docker.POSTGRES_PASSWORD, docker.REDIS_AUTH, docker.NEXTAUTH_SECRET, docker.LANGFUSE_INIT_USER_PASSWORD, app.LANGFUSE_SECRET_KEY]) {
    assert.ok(!output.join('\n').includes(value))
  }
  await setupLangfuse(root)
  assert.equal(await readFile(dockerPath, 'utf8'), beforeDocker)
  assert.equal(await readFile(appPath, 'utf8'), beforeApp)
})

test('setup recovers a missing application file from original Docker credentials', async t => {
  const root = await fixture(t)
  await setupLangfuse(root)
  const dockerPath = join(root, '.env.langfuse.docker.local'), appPath = join(root, '.env.langfuse.local')
  const beforeDocker = await readFile(dockerPath, 'utf8'), beforeApp = await readFile(appPath, 'utf8')
  await unlink(appPath)
  await setupLangfuse(root)
  assert.equal(await readFile(dockerPath, 'utf8'), beforeDocker)
  assert.equal(await readFile(appPath, 'utf8'), beforeApp)
})

test('existing mismatched or incomplete configuration remains untouched', async t => {
  const root = await fixture(t)
  await setupLangfuse(root)
  const appPath = join(root, '.env.langfuse.local'), dockerPath = join(root, '.env.langfuse.docker.local')
  const before = await readFile(appPath, 'utf8')
  const changed = before.replace('http://127.0.0.1:3035', 'https://other.example')
  await writeFile(appPath, changed)
  await assert.rejects(setupLangfuse(root), { code: 'config_mismatch' })
  assert.equal(await readFile(appPath, 'utf8'), changed)
  await unlink(dockerPath)
  await assert.rejects(setupLangfuse(root), { code: 'app_without_docker' })
  assert.equal(await readFile(appPath, 'utf8'), changed)
  await writeFile(dockerPath, 'POSTGRES_PASSWORD=private-unrelated-value\n')
  await assert.rejects(setupLangfuse(root), { code: 'invalid_docker_config' })
  assert.equal(await readFile(dockerPath, 'utf8'), 'POSTGRES_PASSWORD=private-unrelated-value\n')
})

test('setup rejects symlinks instead of reading or overwriting another configuration', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t), target = join(root, 'unrelated')
  await writeFile(target, 'private-unrelated-value')
  await symlink(target, join(root, '.env.langfuse.docker.local'))
  await assert.rejects(setupLangfuse(root), { code: 'unsafe_file' })
  assert.equal(await readFile(target, 'utf8'), 'private-unrelated-value')
})

test('compose commands are isolated and stopping cannot remove volumes or pass secrets as arguments', async t => {
  const root = await fixture(t), calls = [], output = []
  for (const command of ['up', 'down', 'status']) {
    await main([command], { root, log: value => output.push(value), run: async (args, cwd) => {
      calls.push({ args, cwd })
      return command === 'status' ? JSON.stringify([{ Service: 'langfuse-web', State: 'running', Health: 'healthy', Command: 'private-command', Labels: { secret: 'private-secret' } }]) : ''
    } })
  }
  assert.equal(calls.length, 3)
  const docker = parseEnv(await readFile(join(root, '.env.langfuse.docker.local'), 'utf8'))
  for (const { args, cwd } of calls) {
    assert.equal(cwd, root)
    assert.deepEqual(args.slice(0, 3), ['compose', '--project-name', 'ai-video-studio-langfuse'])
    assert.ok(!args.includes('--volumes') && !args.includes('-v'))
    assert.ok(!args.some(arg => Object.values(docker).includes(arg)))
  }
  assert.deepEqual(calls[1].args.slice(-1), ['down'])
  assert.ok(output.includes('langfuse-web: running (healthy)'))
  assert.ok(!output.join('\n').includes('private-command') && !output.join('\n').includes('private-secret'))
  assert.throws(() => composeArgs('delete-all', root), { code: 'invalid_command' })
  await assert.rejects(main(['down', '--volumes'], { root }), { code: 'invalid_command' })
})

test('deployment pins matching releases and keeps Next health checks reachable behind host loopback bindings', async () => {
  const source = await readFile(new URL('../../infra/langfuse/compose.yaml', import.meta.url), 'utf8')
  assert.match(source, /image: docker\.langfuse\.com\/langfuse\/langfuse:4\.79\.0@sha256:[a-f0-9]{64}/)
  assert.match(source, /image: docker\.langfuse\.com\/langfuse\/langfuse-worker:4\.79\.0@sha256:[a-f0-9]{64}/)
  assert.match(source, /image: docker\.io\/clickhouse\/clickhouse-server:26\.3\.62\.3@sha256:[a-f0-9]{64}/)
  assert.match(source, /HOSTNAME: "0\.0\.0\.0"/)
  assert.match(source, /fetch\('http:\/\/127\.0\.0\.1:3000\/api\/public\/health'\)/)
  const bindings = [...source.matchAll(/^\s+- "([^"\n]+:\d+:\d+)"$/gm)].map(match => match[1])
  assert.deepEqual(bindings, ['127.0.0.1:3035:3000', '127.0.0.1:9095:9000'])
  assert.match(source, /LANGFUSE_S3_MEDIA_UPLOAD_INTERNAL_ENDPOINT: http:\/\/minio:9000/)
  assert.match(source, /TELEMETRY_ENABLED: "false"/)
  assert.match(source, /NEXT_TELEMETRY_DISABLED: "1"/)
  assert.doesNotMatch(source, /^  langfuse-ai-gateway:/m)
})
