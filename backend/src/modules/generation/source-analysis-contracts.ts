/** Fixed atomic analysis contracts; neither tool sessions nor creative/media
 * operations gain permission to discard incomplete output through a prefix. */
const sourceContracts = new Set([
  'script_source_map', 'script_source_map_boundary_repair', 'script_source_evidence_repair',
  'script_source_quality', 'script_source_quality_repair', 'script_source_quality_repair_batch', 'script_source_story',
  'script_source_story_character_repair', 'script_source_story_overview', 'script_source_story_characters',
  'script_source_story_characters_merge', 'script_source_story_timeline', 'script_source_story_threads',
  'script_source_story_uncertainties',
])

export function isSourceAnalysisContract(name?: string): boolean {
  if (!name) return false
  const base = name.replace(/_(?:structure|local)_repair$/, '').replace(/_page$/, '')
  return sourceContracts.has(base)
}
