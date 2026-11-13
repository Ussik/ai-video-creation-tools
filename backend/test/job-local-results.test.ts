import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validVideo } from './fixtures/valid-video.js'
const directory = await mkdtemp(join(tmpdir(), 'job-local-results-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const { initDb, db, run, now, required } = await import('../src/infrastructure/database/db.js')
const { prepareMediaJob, claimMediaJob, markMediaJobDispatch, mediaJobExecution, stageLocalJobWriting, stageLocalJobReady, recoverLocalJobResult, assertMediaJobOwner } = await import('../src/modules/jobs/job-local-results.js')
type Job = import('../src/infrastructure/database/db.js').Job
initDb()
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
let n = 0
async function fixture() {
 const id = `job-${++n}`, project = `project-${n}`
 run('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)', project, project, now(), now())
 run("INSERT INTO jobs (id,project_id,job_type,request,status,created_at,updated_at) VALUES (?,?,'generation',?,'running',?,?)", id, project, '{"prompt":"same request"}', now(), now())
 const job = required<Job>('jobs', id); prepareMediaJob(id); const owner = claimMediaJob(job)
 const folder = join(directory, 'media', project); await mkdir(folder, { recursive: true })
 const result = { path: join(folder, 'ready.mp4'), kind: 'video' as const }
 return { job, owner, result }
}
test('a local validated file survives DB rollback and a new worker takes it over without HTTP', async t => {
 const f = await fixture(); stageLocalJobWriting(f.job, f.owner, f.result); await writeFile(f.result.path, validVideo); await stageLocalJobReady(f.job, f.owner, f.result)
 assert.throws(() => db.transaction(() => { run('DELETE FROM job_local_results WHERE job_id=?', f.job.id); throw new Error('asset commit failed') })())
 t.mock.method(globalThis, 'fetch', async () => assert.fail('local recovery cannot dispatch or download'))
 const next = claimMediaJob(f.job), recovered = await recoverLocalJobResult(f.job, next)
 assert.equal(recovered?.path, f.result.path); assert.equal(recovered?.kind, 'video')
 assert.throws(() => assertMediaJobOwner(f.job, f.owner), /归属已变化/)
})
test('writing checkpoints are decoded again, and corrupted ready files cannot be adopted', async () => {
 const f = await fixture(); stageLocalJobWriting(f.job, f.owner, f.result); await writeFile(f.result.path, validVideo)
 assert.equal((await recoverLocalJobResult(f.job, f.owner))?.path, f.result.path)
 await writeFile(f.result.path, 'corrupt')
 await assert.rejects(recoverLocalJobResult(f.job, f.owner), /摘要不一致/)
 const bad = await fixture(); stageLocalJobWriting(bad.job, bad.owner, bad.result); await writeFile(bad.result.path, '<html>partial</html>')
 await assert.rejects(recoverLocalJobResult(bad.job, bad.owner), /有效视频/)
})
test('dispatch intent and stable request id persist before payment and reject repeated paid dispatch', async () => {
 const f = await fixture(), before = mediaJobExecution(f.job.id)!
 assert.equal(before.phase, 'prepared'); markMediaJobDispatch(f.job, f.owner, before.request_id)
 assert.equal(mediaJobExecution(f.job.id)?.phase, 'dispatched')
 assert.throws(() => markMediaJobDispatch(f.job, f.owner), /不能再次提交/)
 run("UPDATE jobs SET status='failed' WHERE id=?", f.job.id)
 assert.throws(() => assertMediaJobOwner(f.job, f.owner), /状态或执行归属已变化/)
})
test('stage paths outside the project and changed input identities cannot be reused', async () => {
 const f = await fixture()
 assert.throws(() => stageLocalJobWriting(f.job, f.owner, { ...f.result, path: join(directory, 'outside.mp4') }), /超出/)
 stageLocalJobWriting(f.job, f.owner, f.result); await writeFile(f.result.path, validVideo)
 run('UPDATE jobs SET request=? WHERE id=?', '{"prompt":"new input"}', f.job.id)
 await assert.rejects(recoverLocalJobResult({ ...f.job, request: '{"prompt":"new input"}' }, f.owner), /所属请求已变化/)
})
