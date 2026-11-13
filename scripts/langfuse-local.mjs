import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, lstat, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'

export const projectName = 'ai-video-studio-langfuse'
export const defaultRoot = fileURLToPath(new URL('../', import.meta.url))
const dockerEnvName = '.env.langfuse.docker.local'
const appEnvName = '.env.langfuse.local'
const localUrl = 'http://127.0.0.1:3035'
const requiredDockerKeys = ['POSTGRES_PASSWORD', 'CLICKHOUSE_PASSWORD', 'REDIS_AUTH', 'MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD',
  'NEXTAUTH_SECRET', 'SALT', 'ENCRYPTION_KEY', 'LANGFUSE_INIT_ORG_ID', 'LANGFUSE_INIT_PROJECT_ID',
  'LANGFUSE_INIT_PROJECT_PUBLIC_KEY', 'LANGFUSE_INIT_PROJECT_SECRET_KEY', 'LANGFUSE_INIT_USER_EMAIL', 'LANGFUSE_INIT_USER_PASSWORD']

function failure(code) {
  const messages = {
    unsafe_file: '本机配置必须是普通文件，不能使用符号链接。',
    invalid_docker_config: '已有 Docker 配置不完整，已保留原文件；请核对本机配置后重试。',
    app_without_docker: '已有应用配置但缺少 Docker 配置，已保留原文件；请先核对已有部署与凭据。',
    config_mismatch: '已有应用配置与本机 Docker 项目不匹配，已保留原文件；请核对后重试。',
    write_failed: '本机配置写入失败；已存在的文件不会被覆盖，请检查目录权限。',
    compose_failed: 'Docker Compose 操作未完成，请检查 Docker 是否已启动及本机端口是否可用。',
    invalid_command: '用法：npm run langfuse:local -- setup|up|down|status',
  }
  return Object.assign(new Error(messages[code] || 'Langfuse 本机操作未完成。'), { code })
}

async function privateConfig(path) {
  let info
  try { info = await lstat(path) } catch (error) { if (error.code === 'ENOENT') return undefined; throw failure('unsafe_file') }
  if (!info.isFile() || info.isSymbolicLink()) throw failure('unsafe_file')
  await chmod(path, 0o600)
  try { return parseEnv(await readFile(path, 'utf8')) } catch { throw failure('unsafe_file') }
}

function envText(values) {
  return '# Generated local credentials. Do not commit or paste into chat.\n' + Object.entries(values)
    .map(([key, value]) => `${key}=${value}`).join('\n') + '\n'
}
async function createPrivateFile(path, values) {
  try { await writeFile(path, envText(values), { flag: 'wx', mode: 0o600 }) }
  catch { throw failure('write_failed') }
}

/** Generate once; preserve existing credentials and reject inconsistent pairs. */
export async function setupLangfuse(root = defaultRoot) {
  const dockerPath = resolve(root, dockerEnvName), appPath = resolve(root, appEnvName)
  let docker = await privateConfig(dockerPath)
  const app = await privateConfig(appPath)
  if (!docker && app) throw failure('app_without_docker')
  let created = false
  if (!docker) {
    const secret = () => randomBytes(32).toString('hex')
    docker = { POSTGRES_PASSWORD: secret(), CLICKHOUSE_PASSWORD: secret(), REDIS_AUTH: secret(),
      MINIO_ROOT_USER: `lf${randomBytes(8).toString('hex')}`, MINIO_ROOT_PASSWORD: secret(), NEXTAUTH_SECRET: secret(), SALT: secret(), ENCRYPTION_KEY: secret(),
      LANGFUSE_INIT_ORG_ID: `studio-local-${randomUUID()}`, LANGFUSE_INIT_PROJECT_ID: `studio-local-${randomUUID()}`,
      LANGFUSE_INIT_PROJECT_PUBLIC_KEY: `pk-lf-${randomUUID()}`, LANGFUSE_INIT_PROJECT_SECRET_KEY: `sk-lf-${secret()}`,
      LANGFUSE_INIT_USER_EMAIL: 'admin@langfuse.local', LANGFUSE_INIT_USER_PASSWORD: randomBytes(24).toString('base64url') }
    await createPrivateFile(dockerPath, docker)
    created = true
  }
  if (requiredDockerKeys.some(key => !docker[key]) || !/^[a-f0-9]{64}$/.test(docker.ENCRYPTION_KEY)) throw failure('invalid_docker_config')
  if (app && (app.LANGFUSE_PUBLIC_KEY !== docker.LANGFUSE_INIT_PROJECT_PUBLIC_KEY ||
      app.LANGFUSE_SECRET_KEY !== docker.LANGFUSE_INIT_PROJECT_SECRET_KEY || app.LANGFUSE_BASE_URL !== localUrl)) throw failure('config_mismatch')
  if (!app) await createPrivateFile(appPath, {
    LANGFUSE_TRACING: 'true', LANGFUSE_PUBLIC_KEY: docker.LANGFUSE_INIT_PROJECT_PUBLIC_KEY,
    LANGFUSE_SECRET_KEY: docker.LANGFUSE_INIT_PROJECT_SECRET_KEY, LANGFUSE_BASE_URL: localUrl,
    LANGFUSE_TRACING_SAMPLING_RATE: '1', VIDEO_STUDIO_LANGFUSE_TIMEOUT_MS: '3000', VIDEO_STUDIO_LANGFUSE_MAX_PENDING: '256',
  })
  return { created, url: localUrl, dockerPath, appPath }
}

export function composeArgs(command, root = defaultRoot) {
  const actions = { up: ['up', '--detach', '--wait', '--wait-timeout', '240'], down: ['down'], status: ['ps', '--format', 'json'] }
  if (!actions[command]) throw failure('invalid_command')
  return ['compose', '--project-name', projectName, '--file', resolve(root, 'infra/langfuse/compose.yaml'),
    '--env-file', resolve(root, dockerEnvName), ...actions[command]]
}

/** Buffer Compose output: do not echo interpolated config or Docker errors that
 * could contain credentials. Never put key values in process arguments. */
async function runDocker(args, root) {
  return new Promise((resolveRun, reject) => {
    const child = spawn('docker', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', bytes = 0
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes < 1024 * 1024) stdout += chunk.toString() })
    child.stderr.on('data', () => {})
    child.once('error', () => reject(failure('compose_failed')))
    child.once('exit', code => code === 0 ? resolveRun(stdout) : reject(failure('compose_failed')))
  })
}

function statusSummary(raw) {
  try {
    const trimmed = raw.trim()
    const records = !trimmed ? [] : trimmed.startsWith('[') ? JSON.parse(trimmed) : trimmed.split('\n').filter(Boolean).map(line => JSON.parse(line))
    return records.map(record => {
      const service = typeof record.Service === 'string' && /^[a-z][a-z0-9-]{0,60}$/.test(record.Service) ? record.Service : 'service'
      const state = ['running', 'exited', 'created', 'restarting', 'paused', 'dead', 'removing'].includes(record.State) ? record.State : 'unknown'
      const health = ['healthy', 'unhealthy', 'starting'].includes(record.Health) ? ` (${record.Health})` : ''
      return `${service}: ${state}${health}`
    }).join('\n') || '本项目当前没有运行中的 Langfuse 容器。'
  } catch { return '无法解析容器状态；未显示 Docker 原始输出。' }
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const { root = defaultRoot, run = runDocker, log = console.log } = dependencies
  const command = args[0]
  if (args.length !== 1 || !['setup', 'up', 'down', 'status'].includes(command)) throw failure('invalid_command')
  const setup = await setupLangfuse(root)
  if (command === 'setup') {
    log(`${setup.created ? '已创建' : '已保留'}本机 Langfuse 配置。`)
    log(`应用配置：${setup.appPath}`)
    log(`管理员账号与密码保存在：${setup.dockerPath}`)
    log(`访问地址：${setup.url}`)
    return
  }
  const output = await run(composeArgs(command, root), root)
  if (command === 'status') log(statusSummary(output))
  else if (command === 'up') log(`Langfuse 已启动：${setup.url}`)
  else log('Langfuse 容器已停止，命名卷与数据已保留。')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error?.code && error?.message ? error.message : 'Langfuse 本机操作失败，未显示配置或原始错误。'); process.exitCode = 1 })
}
