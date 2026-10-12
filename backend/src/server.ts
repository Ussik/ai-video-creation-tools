import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp, startWorker } from './app.js'

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = buildApp()
  const stopWorker = startWorker()
  const port = Number(process.env.PORT || 8000)
  app.listen({ host: '127.0.0.1', port }).then(address => console.log(`视频创作服务: ${address}`)).catch(error => { stopWorker(); console.error(error); process.exitCode = 1 })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    void Promise.allSettled([stopWorker(), app.close()]).then(() => process.exit())
  })
}
