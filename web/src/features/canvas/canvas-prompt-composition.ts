import { extractPromptBody } from '@video-studio/shared/visuals/prompt-document'
import { rebasePromptDraft } from './canvas-prompt-draft'
import { isPromptSectionDocument, type PromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'

/** References have the same identity in authored text and its source snapshots. */
export function rewriteCanvasPromptSections(document: PromptSectionDocument | undefined, rewrite: (text: string) => string): PromptSectionDocument | undefined {
  if (!isPromptSectionDocument(document)) return undefined
  return { ...document, blocks: document.blocks.map(block => ({ ...block, text: rewrite(block.text),
    ...(block.sourceText !== undefined ? { sourceText: rewrite(block.sourceText) } : {}),
    ...(block.pendingSourceText !== undefined ? { pendingSourceText: rewrite(block.pendingSourceText) } : {}),
  })) }
}

/** Keep the latest authored body while controls and reference sections rebuild. */
export function canvasPromptBody(input: { prompt: string; prompt_body?: string; prompt_template?: string }, nextBody?: string): string {
  const body = extractPromptBody(input)
  if (!body.trim() || nextBody === undefined || !input.prompt_template) return body
  const previousBody = extractPromptBody({ prompt: input.prompt_template, prompt_template: input.prompt_template })
  return rebasePromptDraft(previousBody, body, nextBody)
}
