import type { Shot } from '../../shared/api/api'
import type { CanvasGraph } from './ProjectCanvas'
import { shotImagePrompt, shotVideoPrompt } from '@video-studio/shared/storyboard/shot-prompts'
import { escapeManagedPromptMarkers, validateManagedPromptDocument } from '@video-studio/shared/visuals/prompt-document'
import { isPromptSectionDocument, recoverLegacyPromptSectionDocument, serializePromptSectionDocument } from '@video-studio/shared/visuals/prompt-section-document'

/** Restore only exact shot-source inheritance, before the normal canvas save.
 * The server revision and every unrelated node/edge remain authoritative. */
export function recoverCanvasShotPrompts(graph: CanvasGraph, shots: Shot[]): CanvasGraph {
  const byId = new Map(shots.map(shot => [shot.id, shot]))
  let changed = false
  const nodes = graph.nodes.map(node => {
    const shot = node.shot_id && byId.get(node.shot_id)
    if (node.type !== 'generation' || !shot || node.settings.visual_profile_id) return node
    const modality = node.settings.modality || 'image'
    if (modality !== 'image' && modality !== 'video') return node
    const source = modality === 'video' ? shotVideoPrompt(shot) : shotImagePrompt(shot)
    try { validateManagedPromptDocument(source); return node } catch { /* Source headings are literal facts. */ }
    if (node.prompt !== source) return node
    const escaped = escapeManagedPromptMarkers(source)
    if (!node.settings.prompt_is_final && !node.settings.prompt_document) {
      if (node.settings.prompt_override && node.text !== source) return node
      changed = true
      return { ...node, prompt: escaped, text: node.text === source ? escaped : node.text }
    }
    const settings = node.settings, document = settings.prompt_sections
    if (!isPromptSectionDocument(document) || serializePromptSectionDocument(document) !== node.text
      || settings.prompt_base !== source || settings.prompt_body !== source || !settings.prompt_template) return node
    const recovered = recoverLegacyPromptSectionDocument(document, settings.prompt_template,
      { sourceBody: source, sourceBase: settings.prompt_base })
    if (recovered === document) return node
    changed = true
    return { ...node, text: serializePromptSectionDocument(recovered), prompt: escaped,
      settings: { ...settings, prompt_sections: recovered, prompt_base: escaped, prompt_body: escaped,
        prompt_template: escaped + settings.prompt_template.slice(source.length) } }
  })
  return changed ? { ...graph, nodes } : graph
}
