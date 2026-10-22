import { scriptDraftRepairRoundLimit } from '@video-studio/shared/script/script-draft-resolution'

export { scriptDraftRepairRoundLimit }

export type ScriptDraftRepairRoundState = {
  completed_rounds?: number
  run?: { completed_rounds?: number }
}

function normalizedRounds(value: number | undefined): number {
  if (value === undefined) return 0
  // An invalid persisted value must not silently reopen an automatic loop.
  return Number.isSafeInteger(value) && value >= 0 ? value : scriptDraftRepairRoundLimit
}

/** The pending candidate retains the count even when a new finding invalidates
 * its previous answers and removes the resumable run. Legacy candidates start at 0. */
export function completedScriptDraftRepairRounds(state?: ScriptDraftRepairRoundState): number {
  return Math.max(normalizedRounds(state?.completed_rounds), normalizedRounds(state?.run?.completed_rounds))
}

/** Only an explicit manual answer submission or AI delegation starts a new
 * allowance. Continuing an existing authorization preserves its completed rounds. */
export function startScriptDraftRepairRounds(strategy: 'manual' | 'ai' | 'continue', previous?: ScriptDraftRepairRoundState): number {
  return strategy === 'continue' ? completedScriptDraftRepairRounds(previous) : 0
}

/** Call only after the repaired candidate has finished its independent review
 * and that review reports unresolved findings. */
export function completeScriptDraftRepairRound(previous?: ScriptDraftRepairRoundState): number {
  return completedScriptDraftRepairRounds(previous) + 1
}

export function canContinueScriptDraftRepair(state?: ScriptDraftRepairRoundState): boolean {
  return completedScriptDraftRepairRounds(state) < scriptDraftRepairRoundLimit
}

export const scriptDraftRepairRoundLimitMessage = '已完成 4 轮修订但复核仍未通过，当前草稿和处理方案均已保留。请手动调整处理方案，或重新明确交给 AI 处理。'
