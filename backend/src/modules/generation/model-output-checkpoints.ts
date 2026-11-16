import { z } from 'zod'
import { AsyncLocalStorage } from 'node:async_hooks'

export const syntaxRepairAuditSchema = z.object({ policy: z.enum(['quoted-lines-v1', 'quoted-lines-v2-deterministic', 'quoted-lines-v3-local', 'stage-content-v1-insertion-only']), original_hash: z.string(), repaired_hash: z.string(), escape_offsets: z.array(z.number().int().nonnegative()) }).strict()

export const localRepairProgressSchema = z.object({ input_hash: z.string(), correction_hash: z.string(), candidate_hash: z.string(),
  candidate: z.unknown(), remaining_target_keys: z.array(z.string()), retained_target_keys: z.array(z.string()), diagnostics: z.string(),
}).strict()
/** Complete responses and correction intent are private execution state. They
 * never represent validated/applied business content. */
export type StructuredOutputCheckpoint = {
  input_hash?: string; raw?: string; original_raw?: string
  correction?: { input_hash: string; raw: string }
  initial_started?: { input_hash: string; intent_id?: string }
  correction_started?: { input_hash: string; intent_id?: string }
  /** Frozen request for this proposal's one correction, never UI data. */
  syntax_repair?: { policy: 'quoted-lines-v1' | 'quoted-lines-v2-deterministic' | 'quoted-lines-v3-local' | 'stage-content-v1-insertion-only'; original_hash: string; repaired_hash: string; escape_offsets: number[] }
  correction_request?: { base_input_hash: string; input_hash: string; prompt: string;
    contract: import('./model-output.js').OutputContract }
  /** A bounded continuation of retained successful patches; the parent and its
   * original paid correction remain immutable and independently replayable. */
  automatic_next?: StructuredOutputCheckpoint
  local_repair?: z.infer<typeof localRepairProgressSchema>
}
export type StructuredOutputPersistence = { checkpoint?: StructuredOutputCheckpoint; persistCheckpoint?: () => void; guardInitialDispatch?: boolean;
  /** Code-owned historical initial contracts; completed bytes only, never dispatch. */
  completedInputs?: Array<{ schema: Record<string, unknown>; prompt: string }>;
  preserveInputIdentity?: boolean; freezeCorrection?: boolean; normalize?: (value: unknown) => unknown }
export type StructuredOutputCheckpointFactory = (name: string, prompt: string, schema: unknown) => StructuredOutputPersistence
const factories = new AsyncLocalStorage<StructuredOutputCheckpointFactory>()
export const currentStructuredOutputCheckpointFactory = () => factories.getStore()
export function withStructuredOutputCheckpoints<T>(factory: StructuredOutputCheckpointFactory, work: () => T): T {
  return factories.run(factory, work)
}
