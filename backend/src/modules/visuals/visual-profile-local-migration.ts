import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { catalogOutputCandidate } from '../generation/catalog-output-candidate.js'
import type { StructuredOutputCheckpoint } from '../generation/model-output-checkpoints.js'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
const bytes = (value: string) => createHash('sha256').update(value).digest('hex')
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const contents = ['definition', 'view_requirements', 'shot_usage'] as const
const locks = ['draft_key', 'kind', 'name', 'variant', 'scene_ids', 'base_profile_id', 'base_draft_key', 'state_delta'] as const
export const visualProfileMigrationAuditSchema = z.object({
  policy: z.literal('visual-profile-original-content-v1'), source: z.literal('original_raw'), unit_key: z.string(),
  binding_hash: z.string().regex(/^[a-f0-9]{64}$/), initial_input_hash: z.string().regex(/^[a-f0-9]{64}$/),
  original_hash: z.string().regex(/^[a-f0-9]{64}$/), correction_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  directory_hash: z.string().regex(/^[a-f0-9]{64}$/), schema_hash: z.string().regex(/^[a-f0-9]{64}$/),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/), candidate_hash: z.string().regex(/^[a-f0-9]{64}$/),
  format_changes: z.array(z.enum(['envelope', 'kind'])), correction_already_used: z.boolean(), new_paid_requests: z.literal(0),
}).strict()

/** No syntax repair or field aliasing. Only a unique complete ORIGINAL with
 * every identity/fact accounted for can migrate; the bad correction remains
 * independent immutable evidence, never an input to the recovered content. */
export function migrateOriginalVisualProfile<T>(input: {
  checkpoint: StructuredOutputCheckpoint; item: { draft_key: string; kind: string; [key: string]: unknown };
  bindingHash: string; initialInputHash: string; schema: z.ZodObject;
  assertLock: (value: unknown) => void; validate: (value: unknown) => T;
}): { value: T; audit: z.infer<typeof visualProfileMigrationAuditSchema> } | undefined {
  const cp = input.checkpoint
  if (cp.input_hash !== input.initialInputHash || cp.initial_started && (cp.raw === undefined || cp.initial_started.input_hash !== input.initialInputHash) ||
      cp.correction_started && (!cp.correction || cp.correction_started.input_hash !== cp.correction.input_hash)) return
  const frozen = cp.correction_request
  if (frozen && (frozen.base_input_hash !== input.initialInputHash || frozen.input_hash !== digest([frozen.prompt, frozen.contract]) ||
      cp.correction && frozen.input_hash !== cp.correction.input_hash || cp.correction_started && frozen.input_hash !== cp.correction_started.input_hash)) return
  // original_raw is required. A canonical raw or a correction must never be
  // promoted to 'original' merely because it happens to parse after an upgrade.
  if (typeof cp.original_raw !== 'string') return
  const root = catalogOutputCandidate(cp.original_raw)
  if (!root || root.audit || !record(root.value)) return
  let original = root.value
  const changes: Array<'envelope' | 'kind'> = []
  if (Object.hasOwn(original, 'profiles')) {
    if (Object.keys(original).length !== 1 || !Array.isArray(original.profiles) || original.profiles.length !== 1 || !record(original.profiles[0])) return
    original = original.profiles[0]
  } else changes.push('envelope')
  if (Object.keys(original).some(key => ![...locks, ...contents].includes(key as typeof locks[number]))) return
  for (const key of ['draft_key', 'kind', 'name', 'variant', 'scene_ids']) if (!Object.hasOwn(original, key)) return
  if (original.kind !== input.item.kind) {
    // This is the one historical read-only type/envelope dialect proved by
    // the incident. It is not an open-ended alias table or identity heuristic.
    if (original.kind !== 'look' || input.item.kind !== 'character') return
    changes.push('kind')
  }
  input.assertLock(original)
  const content = Object.fromEntries(contents.map(key => [key, original[key]]))
  const parsed = input.schema.safeParse(content)
  if (!parsed.success || !isDeepStrictEqual(parsed.data, content)) return
  const candidate = { ...structuredClone(input.item), ...structuredClone(content) }
  const value = input.validate(candidate)
  if (!record(value) || contents.some(key => !isDeepStrictEqual(value[key], content[key]))) return
  return { value, audit: visualProfileMigrationAuditSchema.parse({ policy: 'visual-profile-original-content-v1', source: 'original_raw', unit_key: input.item.draft_key,
    binding_hash: input.bindingHash, initial_input_hash: input.initialInputHash, original_hash: bytes(cp.original_raw),
    correction_hash: cp.correction ? digest(cp.correction) : null, directory_hash: digest(input.item),
    schema_hash: digest(z.toJSONSchema(input.schema, { io: 'input' })), content_hash: digest(content), candidate_hash: digest(candidate),
    format_changes: changes, correction_already_used: !!cp.correction, new_paid_requests: 0,
  }) }
}
