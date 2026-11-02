// Isolated acceptance app with a chosen review-concurrency ceiling (existing env VIDEO_STUDIO_SCRIPT_REVIEW_CONCURRENCY).
//   REVIEW_CONCURRENCY=2 PORT=18300 DATA=/tmp/script-agent-conc2-data node scripts/qa/concurrency-app.mjs
// The same real app/routes/SQLite as 18000; only the env value and the data directory differ. Pair it with mock 18101.
process.env.VIDEO_STUDIO_SCRIPT_REVIEW_CONCURRENCY = process.env.REVIEW_CONCURRENCY || '2'
process.env.VIDEO_STUDIO_DATA_DIR = process.env.DATA || '/tmp/script-agent-conc-data'
const port = Number(process.env.PORT || 18300)
const { mkdirSync } = await import('node:fs'); mkdirSync(process.env.VIDEO_STUDIO_DATA_DIR, { recursive: true })
const { buildApp, startWorker } = await import('../../backend/src/app.ts')
const app = buildApp(), stopWorker = startWorker()
await app.listen({ host: '127.0.0.1', port })
console.log(`concurrency app http://127.0.0.1:${port} ceiling=${process.env.VIDEO_STUDIO_SCRIPT_REVIEW_CONCURRENCY} data=${process.env.VIDEO_STUDIO_DATA_DIR}`)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void Promise.allSettled([stopWorker(), app.close()]).then(() => process.exit()) })
