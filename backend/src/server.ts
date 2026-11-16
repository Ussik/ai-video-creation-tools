import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { buildApp, startWorker } from './app.js'
import { flushLangfuseTraces } from './infrastructure/observability/langfuse-tracing.js'

// Development and the packaged server both start from different working
// directories. Load only the local Langfuse file when present; explicit
// process environment values remain authoritative and no credentials are
// logged. Without this, the tracer correctly reports `disabled` even though
// the local Langfuse container is healthy.
function loadLocalLangfuseEnv() {
  const load = (process as NodeJS.Process & { loadEnvFile?: (path?: string) => void }).loadEnvFile
  if (!load) return
  const dataDirEnv = process.env.VIDEO_STUDIO_DATA_DIR
  const candidates = [process.env.VIDEO_STUDIO_LANGFUSE_ENV_FILE,
    resolve(process.cwd(), '.env.langfuse.local'), resolve(process.cwd(), '../.env.langfuse.local'),
    dataDirEnv ? resolve(dataDirEnv, '../.env.langfuse.local') : undefined]
  const file = candidates.find(path => path && existsSync(path))
  if (file) {
    try { load(file) } catch { /* Diagnostics expose disabled/invalid configuration safely. */ }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadLocalLangfuseEnv()
  const app = buildApp()
  const stopWorker = startWorker()
  const port = Number(process.env.PORT || 8000)
  app.listen({ host: '127.0.0.1', port }).then(address => console.log(`视频创作服务: ${address}`)).catch(error => { stopWorker(); console.error(error); process.exitCode = 1 })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    void Promise.allSettled([stopWorker(), app.close()]).then(async () => {
      await flushLangfuseTraces(1500)
      process.exit()
    })
  })
}
