import type { PromptRefinementSemanticReview } from '../../src/modules/skills/prompt-refinement-semantics.js'

export function semanticReviewFixture(): PromptRefinementSemanticReview {
  return { content_review: null, dialogue: [], request_conflicts: [], checks: ['facts', 'reference_identity', 'character_presence', 'board_views', 'requested_changes'].map(category => ({
    category: category as PromptRefinementSemanticReview['checks'][number]['category'], status: 'not_applicable', description: '不适用或已核对保留。',
    source_evidence: '', adjustment_evidence: '', candidate_evidence: '',
  })) }
}

export function semanticIssueFixture(category: PromptRefinementSemanticReview['checks'][number]['category'], description: string,
  evidence: { source?: string; adjustment?: string; candidate?: string }): PromptRefinementSemanticReview {
  const review = semanticReviewFixture()
  review.checks = review.checks.map(check => check.category === category ? { ...check, status: 'missing', description,
    source_evidence: evidence.source || '', adjustment_evidence: evidence.adjustment || '', candidate_evidence: evidence.candidate || '' } : check)
  return review
}
