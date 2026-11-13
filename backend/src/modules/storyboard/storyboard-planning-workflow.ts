import type { StoryboardPlanningResult } from '@video-studio/shared/storyboard/storyboard-planning-types'
import type { StoryboardPlanningControl } from './storyboard-planning-tasks.js'

/** Each accepted stage is durable before the next paid request. Recovery
 * revalidates saved values and never repeats an already completed review. */
export async function runStoryboardPlanningWorkflow<Preparation, Candidate, Report>(control: StoryboardPlanningControl, options: {
  prepare(): Promise<Preparation>; restorePreparation(value: unknown): Preparation
  generate(preparation: Preparation): Promise<Candidate>; restoreCandidate(value: unknown): Candidate
  serializeCandidate?(candidate: Candidate): unknown
  review(candidate: Candidate): Promise<Report>; restoreReport(value: unknown, candidate: Candidate): Report
  hasErrors(report: Report): boolean
  repair(preparation: Preparation, candidate: Candidate, report: Report): Promise<Candidate>
  projection(preparation: Preparation, candidate: Candidate, repaired: boolean): StoryboardPlanningResult
  finish(preparation: Preparation, candidate: Candidate, report: Report, repaired: boolean): StoryboardPlanningResult
}) {
  const { steps } = control
  let preparation: Preparation
  if ('preparation' in steps) preparation = options.restorePreparation(steps.preparation)
  else { control.stage('preparing'); preparation = await options.prepare(); control.retain('preparation', preparation) }
  let candidate: Candidate
  if ('candidate' in steps) candidate = options.restoreCandidate(steps.candidate)
  else { control.stage('generating'); candidate = await options.generate(preparation); control.retain('candidate', options.serializeCandidate?.(candidate) ?? candidate, options.projection(preparation, candidate, false)) }
  let report: Report
  if ('report' in steps) report = options.restoreReport(steps.report, candidate)
  else { control.stage('reviewing'); report = await options.review(candidate); control.retain('report', report) }
  const repaired = options.hasErrors(report)
  if (repaired) {
    if ('revised_candidate' in steps) candidate = options.restoreCandidate(steps.revised_candidate)
    else { control.stage('repairing'); candidate = await options.repair(preparation, candidate, report)
      control.retain('revised_candidate', options.serializeCandidate?.(candidate) ?? candidate, options.projection(preparation, candidate, true)) }
    if ('revised_report' in steps) report = options.restoreReport(steps.revised_report, candidate)
    else { control.stage('rechecking'); report = await options.review(candidate); control.retain('revised_report', report) }
  }
  return options.finish(preparation, candidate, report, repaired)
}
