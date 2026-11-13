import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import Database from 'better-sqlite3'

const directory = await mkdtemp(join(tmpdir(), 'provider-configuration-migration-'))
process.env.VIDEO_STUDIO_DATA_DIR = directory
const settings = '{"request_path":"legacy/custom","request_template":{"max_tokens":8192,"prompt":"{{prompt}}"},"text_path":"answer","vendor":{"keep":true}}'
const legacy = new Database(join(directory, 'studio.db'))
legacy.exec(`
  CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, adapter TEXT NOT NULL, base_url TEXT NOT NULL,
    auth_header TEXT NOT NULL DEFAULT 'Authorization', auth_prefix TEXT NOT NULL DEFAULT 'Bearer ', key_ciphertext TEXT,
    model_catalog TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE models (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    name TEXT NOT NULL, remote_id TEXT NOT NULL, modality TEXT NOT NULL, protocol TEXT NOT NULL DEFAULT 'responses',
    settings TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0, is_default INTEGER NOT NULL DEFAULT 0);
  INSERT INTO providers (id,name,adapter,base_url,created_at) VALUES ('legacy-provider','旧连接','http','https://fixture.invalid/v1','2026-01-01');
`)
legacy.prepare('INSERT INTO models (id,provider_id,name,remote_id,modality,protocol,settings) VALUES (?,?,?,?,?,?,?)').run('legacy-z', 'legacy-provider', 'Z', 'z', 'text', 'responses', settings)
legacy.prepare('INSERT INTO models (id,provider_id,name,remote_id,modality,protocol,settings) VALUES (?,?,?,?,?,?,?)').run('legacy-a', 'legacy-provider', 'A', 'a', 'text', 'chat_completions', settings)
legacy.close()

const { buildApp } = await import('../src/app.js')
const { all, db, initDb, one, run } = await import('../src/infrastructure/database/db.js')
const app = buildApp()
after(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }) })

test('additive migration leaves legacy protocols and exact custom settings intact while retaining stable catalog order', async () => {
  assert.equal(one<{ protocol: string | null }>('SELECT protocol FROM providers WHERE id=?', 'legacy-provider')!.protocol, null)
  assert.deepEqual(all('SELECT id, protocol, settings, sort_order FROM models WHERE provider_id=? ORDER BY sort_order', 'legacy-provider'), [
    { id: 'legacy-a', protocol: 'chat_completions', settings, sort_order: 0 },
    { id: 'legacy-z', protocol: 'responses', settings, sort_order: 1 },
  ])
  run('UPDATE models SET sort_order=? WHERE id=?', 7, 'legacy-a')
  initDb()
  assert.equal(one<{ sort_order: number }>('SELECT sort_order FROM models WHERE id=?', 'legacy-a')!.sort_order, 7, 'startup must not overwrite a user-saved order')
  const providers = (await app.inject({ method: 'GET', url: '/api/providers' })).json()
  assert.equal(providers.find((provider: { id: string }) => provider.id === 'legacy-provider').protocol, null)
})
