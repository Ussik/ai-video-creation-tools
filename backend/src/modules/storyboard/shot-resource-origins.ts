import { db, now } from '../../infrastructure/database/db.js'
/** Written only for new derived objects, never for a reused upstream/reference object. */
export function recordShotProfileOrigin(projectId:string,profileId:string,shotIds:string[],sceneIds:string[]) {
  if(!shotIds.length)return
  db.exec('CREATE TABLE IF NOT EXISTS shot_resource_origins(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,kind TEXT NOT NULL,resource_id TEXT NOT NULL,shot_ids TEXT NOT NULL,scene_ids TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(project_id,kind,resource_id))')
  db.prepare('INSERT INTO shot_resource_origins VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,kind,resource_id) DO NOTHING')
    .run(projectId,'profile',profileId,JSON.stringify([...new Set(shotIds)].sort()),JSON.stringify([...new Set(sceneIds)].sort()),now())
}
