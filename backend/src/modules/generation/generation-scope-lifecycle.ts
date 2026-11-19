import { db, one } from '../../infrastructure/database/db.js'
const exists=()=>!!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='generation_scope_versions'")
export function generationScopeVersion(projectId:string,namespace:string):number {
  return exists()?one<{version:number}>('SELECT version FROM generation_scope_versions WHERE project_id=? AND namespace=?',projectId,namespace)?.version||0:0
}
export function assertGenerationScope(projectId:string,namespace:string,version:number) {
  if(generationScopeVersion(projectId,namespace)!==version)throw Object.assign(new Error('原内容已彻底删除，旧运行不能保存或恢复；请从当前分镜重新开始。'),{statusCode:410,code:'generation_scope_purged'})
}
export function invalidateGenerationScopes(projectId:string,namespaces:Iterable<string>) {
  db.exec('CREATE TABLE IF NOT EXISTS generation_scope_versions(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,namespace TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(project_id,namespace))')
  for(const namespace of new Set(namespaces))db.prepare('INSERT INTO generation_scope_versions VALUES(?,?,1) ON CONFLICT(project_id,namespace) DO UPDATE SET version=version+1').run(projectId,namespace)
}
