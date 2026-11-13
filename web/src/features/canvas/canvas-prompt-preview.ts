import { parsePromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'

const bodyStart = '【主要创作内容】'
const bodyEnd = '【主要创作内容结束】'

/** Read-only presentation labels. Never use this text for persistence or generation. */
export function promptPreviewText(prompt: string): string {
  return parsePromptSectionDocument(prompt).blocks.map(block => {
    if (block.kind !== 'body' || !block.text.trim()) return block.text
    const [, leading, content, trailing] = /^(\s*)([\s\S]*?)(\s*)$/.exec(block.text)!
    if (content!.startsWith(bodyStart) && content!.endsWith(bodyEnd)) return block.text
    return `${leading}${bodyStart}\n${content}\n${bodyEnd}${trailing}`
  }).join('')
}
