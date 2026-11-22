/** Error traceability for cascading failures in multi-stage generation */

export interface ErrorTrace {
  origin_stage: string        // Stage where error originated
  detected_stage: string      // Stage where error was detected
  propagation_path: string[]  // How error propagated through stages
  root_cause: string         // Human-readable root cause
  remediation?: string       // Suggested fix
}

export interface BoundaryMismatchError extends Error {
  code: 'source_boundary_mismatch'
  errorTrace: ErrorTrace
  mismatch_details: {
    unit_id: number
    expected_section_id: number
    actual_section_id: number
    expected_section_title: string
    actual_section_title: string
  }
}

/** Detect if a unit reference belongs to an adjacent section (boundary mismatch) */
export function detectBoundaryMismatch(
  unitId: number,
  currentSectionId: number,
  sections: Array<{ id: number; title: string; start_unit: number; end_unit?: number }>,
  units: Map<number, { id: number; offset: number; text: string }>
): ErrorTrace | null {
  const unit = units.get(unitId)
  if (!unit) return null

  const currentSection = sections[currentSectionId]
  if (!currentSection) return null

  // Find which section this unit actually belongs to
  const actualSection = sections.find((section, index) => {
    const nextSection = sections[index + 1]
    const start = units.get(section.start_unit)?.offset ?? 0
    const end = nextSection ? (units.get(nextSection.start_unit)?.offset ?? Infinity) : Infinity
    return unit.offset >= start && unit.offset < end
  })

  if (!actualSection || actualSection.id === currentSectionId) return null

  // Boundary mismatch detected
  return {
    origin_stage: 'outline_generation',
    detected_stage: 'evidence_validation',
    propagation_path: [
      'outline_generation → boundary_saved',
      'boundary_saved → evidence_validation',
      'evidence_validation → local_repair'
    ],
    root_cause: `unit ${unitId} 应属于章节 ${actualSection.id}「${actualSection.title}」，但当前章节边界将其划给了章节 ${currentSectionId}「${currentSection.title}」`,
    remediation: actualSection.id < currentSectionId
      ? `建议：扩展章节 ${currentSectionId} 的起始边界，或重新生成目录`
      : `建议：收缩章节 ${currentSectionId} 的结束边界，或重新生成目录`
  }
}

/** Create a boundary mismatch error with full trace */
export function createBoundaryMismatchError(
  unitId: number,
  currentSectionId: number,
  sections: Array<{ id: number; title: string; start_unit: number }>,
  units: Map<number, { id: number; offset: number; text: string }>
): BoundaryMismatchError {
  const trace = detectBoundaryMismatch(unitId, currentSectionId, sections, units)
  const currentSection = sections[currentSectionId]!
  const actualSection = sections.find((section, index) => {
    const nextSection = sections[index + 1]
    const unit = units.get(unitId)!
    const start = units.get(section.start_unit)?.offset ?? 0
    const end = nextSection ? (units.get(nextSection.start_unit)?.offset ?? Infinity) : Infinity
    return unit.offset >= start && unit.offset < end
  })!

  const error = new Error(
    trace?.root_cause || `unit ${unitId} 边界不匹配`
  ) as BoundaryMismatchError

  error.code = 'source_boundary_mismatch'
  error.errorTrace = trace || {
    origin_stage: 'outline_generation',
    detected_stage: 'evidence_validation',
    propagation_path: [],
    root_cause: 'Unknown boundary mismatch'
  }
  error.mismatch_details = {
    unit_id: unitId,
    expected_section_id: actualSection.id,
    actual_section_id: currentSectionId,
    expected_section_title: actualSection.title,
    actual_section_title: currentSection.title
  }

  return error
}
