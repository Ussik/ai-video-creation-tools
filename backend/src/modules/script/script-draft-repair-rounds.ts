export type ScriptDraftRepairRoundState = {
  completed_rounds?: number
  run?: { completed_rounds?: number }
}

function normalizedRounds(value: number | undefined): number {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('候选稿修订轮次检查点无效，请检查已保存进度')
  return value
}

/** The pending candidate retains the count even when a new finding invalidates
 * its previous answers and removes the resumable run. Legacy candidates start at 0. */
export function completedScriptDraftRepairRounds(state?: ScriptDraftRepairRoundState): number {
  return Math.max(normalizedRounds(state?.completed_rounds), normalizedRounds(state?.run?.completed_rounds))
}

/** A new answer submission starts a new diagnostic count. Continuing an
 * existing authorization preserves its completed rounds without a ceiling. */
export function startScriptDraftRepairRounds(strategy: 'manual' | 'ai' | 'continue', previous?: ScriptDraftRepairRoundState): number {
  return strategy === 'continue' ? completedScriptDraftRepairRounds(previous) : 0
}

/** Call only after the repaired candidate has finished its independent review
 * and that review reports unresolved findings. */
export function completeScriptDraftRepairRound(previous?: ScriptDraftRepairRoundState): number {
  return completedScriptDraftRepairRounds(previous) + 1
}

export function canContinueScriptDraftRepair(state?: ScriptDraftRepairRoundState): boolean {
  completedScriptDraftRepairRounds(state)
  return true
}
