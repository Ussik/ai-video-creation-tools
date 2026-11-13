import { one } from '../../infrastructure/database/db.js'

const directorModel = "json_extract(CASE WHEN json_valid(request_payload) THEN request_payload ELSE '{}' END, '$.model_id')"

/** Director work runs independently of generation jobs. Its original model
 * binding protects the connection and configuration throughout the task. */
export function modelConfigurationInUse(modelId: string): boolean {
  return Boolean(one("SELECT id FROM jobs WHERE model_id=? AND status IN ('queued','running') LIMIT 1", modelId)
    || one(`SELECT id FROM script_director_tasks WHERE status='running' AND ${directorModel}=? LIMIT 1`, modelId))
}

export function providerConfigurationInUse(providerId: string): boolean {
  return Boolean(one("SELECT jobs.id FROM jobs JOIN models ON jobs.model_id=models.id WHERE models.provider_id=? AND jobs.status IN ('queued','running') LIMIT 1", providerId)
    || one(`SELECT script_director_tasks.id FROM script_director_tasks JOIN models ON models.id=${directorModel}
      WHERE script_director_tasks.status='running' AND models.provider_id=? LIMIT 1`, providerId))
}
