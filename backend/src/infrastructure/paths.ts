import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Source and compiled files have the same depth within backend/{src,dist}.
export const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
export const dataDir = process.env.VIDEO_STUDIO_DATA_DIR || resolve(projectRoot, 'data')
export const webDist = resolve(projectRoot, 'web/dist')
