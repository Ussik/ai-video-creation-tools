import { createHash } from 'node:crypto'

/** Document identity includes replacement time; identical reuploads are distinct. */
export const scriptDocumentVersion = (source: { filename: string; content: string; updated_at: string }) =>
  createHash('sha256').update(JSON.stringify([source.filename, source.content, source.updated_at])).digest('hex')

/** Preserve semantic-map identity and existing analysis checkpoints. */
export const scriptSourceVersion = (source: { filename: string; content: string }) =>
  createHash('sha256').update(`map-v2\n${source.filename}\n${source.content}`).digest('hex')
