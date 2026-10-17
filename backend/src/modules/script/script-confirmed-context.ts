import type { StructuredGenerator } from '../generation/model-output.js'

type Document = { id: string; artifact_type: string; title: string; content: string; episode_number?: number; version?: string }
export type PreparedScriptContext = {
  documents: Array<Omit<Document, 'content'> & { length: number }>;
  facts: Array<{ document_id: string; quote: string; meaning: string }>
}

/** Retain the old preparation hook for callers without summarizing, truncating
 * or billing a separate model request. Callers pass the complete documents. */
export async function prepareConfirmedScriptContext(_documents: Document[], _generate: StructuredGenerator, signal?: AbortSignal): Promise<PreparedScriptContext | undefined> {
  signal?.throwIfAborted()
  return undefined
}
