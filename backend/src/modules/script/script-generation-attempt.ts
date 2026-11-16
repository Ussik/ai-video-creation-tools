type CheckpointIdentity = Record<string, unknown>

/** Bind stage checkpoints to one task attempt; only explicit resume may read pre-attempt identities. */
export function scriptGenerationCheckpointAttempt<T extends CheckpointIdentity>(identity: T, attemptId: string,
  explicitResume: boolean, compatibleIdentities: readonly T[] = []) {
  if (!attemptId.trim() || attemptId.length > 200) throw new Error('剧本生成尝试标识无效')
  const withAttempt = (value: T) => ({ ...value, generation_attempt_id: attemptId })
  return {
    identity: withAttempt(identity),
    compatibleIdentities: [
      ...compatibleIdentities.map(withAttempt),
      ...(explicitResume ? [identity, ...compatibleIdentities] : []),
    ],
  }
}
