import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db, now, one, run } from './db.js'
import type { Job } from './db.js'

export const defaultJobConcurrency = 3
export const maxJobConcurrency = 10
const settingsInput = z.object({ concurrency: z.number().int().min(1).max(maxJobConcurrency) }).strict()
const wakeWorkers = new Set<() => void>()

export function initJobQueue(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS job_queue_settings (
    id INTEGER PRIMARY KEY CHECK (id=1), concurrency INTEGER NOT NULL CHECK (concurrency BETWEEN 1 AND 10)
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(status, created_at);`)
  run('INSERT OR IGNORE INTO job_queue_settings (id, concurrency) VALUES (1, ?)', defaultJobConcurrency)
}

export function jobQueueStatus() {
  return {
    concurrency: one<{ concurrency: number }>('SELECT concurrency FROM job_queue_settings WHERE id=1')!.concurrency,
    max_concurrency: maxJobConcurrency,
    running: one<{ count: number }>("SELECT COUNT(*) AS count FROM jobs WHERE status='running'")!.count,
    queued: one<{ count: number }>("SELECT COUNT(*) AS count FROM jobs WHERE status='queued'")!.count,
  }
}

export function registerJobQueueRoutes(app: FastifyInstance): void {
  initJobQueue()
  app.get('/api/job-queue', async () => jobQueueStatus())
  app.put('/api/job-queue', async request => {
    const settings = settingsInput.parse(request.body)
    run('UPDATE job_queue_settings SET concurrency=? WHERE id=1', settings.concurrency)
    for (const wake of wakeWorkers) wake()
    return jobQueueStatus()
  })
}

// Capacity and ownership are checked together, including other worker instances.
// An export waiting for its lane does not block later generation jobs.
const claimJob = db.transaction((): Job | undefined => {
  const status = jobQueueStatus()
  if (status.running >= status.concurrency) return
  const job = one<Job>(`SELECT * FROM jobs WHERE status='queued'
    AND (job_type<>'export' OR NOT EXISTS (SELECT 1 FROM jobs WHERE status='running' AND job_type='export'))
    ORDER BY created_at, rowid LIMIT 1`)
  if (!job) return
  const claimed = db.prepare("UPDATE jobs SET status='running', updated_at=? WHERE id=? AND status='queued'").run(now(), job.id)
  return claimed.changes ? job : undefined
})

export function startJobQueue(processJob: (job: Job) => Promise<void>, failJob: (job: Job, error: unknown) => void): () => Promise<void> {
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  const active = new Set<Promise<void>>()
  const pump = () => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    try {
      while (!stopped) {
        const job = claimJob.immediate()
        if (!job) break
        const execution = Promise.resolve().then(() => processJob(job))
          .catch(error => failJob(job, error))
          .catch(error => console.error('任务处理失败', error))
          .finally(() => {
            active.delete(execution)
            if (!stopped) pump()
          })
        active.add(execution)
      }
    } catch (error) { console.error('任务调度失败', error) }
    if (!stopped) timer = setTimeout(pump, 1000)
  }
  wakeWorkers.add(pump)
  pump()
  return async () => {
    stopped = true
    if (timer) clearTimeout(timer)
    wakeWorkers.delete(pump)
    await Promise.allSettled(active)
  }
}
