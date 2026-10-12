import Database from 'better-sqlite3'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dataDir } from '../src/infrastructure/paths.js'
import { rightApiImageSettings } from '../src/infrastructure/providers/rightapi-image-settings.js'

// Explicit maintenance command: preview by default, apply only with --apply.
// Opens the existing database without running application startup migrations.
const apply = process.argv.includes('--apply')
const db = new Database(resolve(dataDir, 'studio.db'), { fileMustExist: true, readonly: !apply })
try {
  const candidates = db.prepare(`SELECT m.id, m.name, m.remote_id, m.settings, p.base_url
    FROM models m JOIN providers p ON p.id=m.provider_id
    WHERE m.modality='image' AND m.protocol='image_generations' AND m.archived=0
      AND m.remote_id IN ('gpt-image-2.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst')`).all() as Array<{
      id: string; name: string; remote_id: string; settings: string; base_url: string;
    }>
  const rows = candidates.filter(row => ['right.codes', 'www.right.codes', 'rightapi.ai', 'www.rightapi.ai'].includes(new URL(row.base_url).hostname))
  const updates = rows.map(row => ({ ...row, next: JSON.stringify(rightApiImageSettings(JSON.parse(row.settings))) }))
    .filter(row => row.settings !== row.next)
  if (apply && updates.length) {
    const backupDir = resolve(dataDir, 'model-config-backups')
    mkdirSync(backupDir, { recursive: true })
    const backupPath = resolve(backupDir, `rightapi-images-${new Date().toISOString().replaceAll(':', '-')}.json`)
    db.transaction(() => {
      for (const row of updates) {
        const active = db.prepare("SELECT 1 FROM jobs WHERE model_id=? AND status IN ('queued','running') LIMIT 1").get(row.id)
        if (active) throw new Error(`${row.name} 还有进行中的任务，暂不修改配置`)
      }
      writeFileSync(backupPath, JSON.stringify(updates.map(({ id, name, settings }) => ({ id, name, settings: JSON.parse(settings) })), null, 2), { mode: 0o600, flag: 'wx' })
      for (const row of updates) db.prepare('UPDATE models SET settings=? WHERE id=?').run(row.next, row.id)
    })()
    console.log(`旧模型配置备份：${backupPath}`)
  }
  console.log(JSON.stringify({ applied: apply, updated_models: updates.map(row => row.name) }, null, 2))
} finally { db.close() }
