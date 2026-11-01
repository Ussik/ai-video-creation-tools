import { scriptStageArtifacts, type StageArtifactType } from '@video-studio/shared/script/script-stage-content'

/** Mock the declared generation task, including providers using prompt-only JSON. */
export function workflowFixtureTypes(prompt: string, fallback: readonly StageArtifactType[] = scriptStageArtifacts.outline): StageArtifactType[] {
  const matches = [...prompt.matchAll(/本次文档类型必须且只允许 ([^，\n]+)/g)]
  return matches.length ? matches.at(-1)![1]!.split('、') as StageArtifactType[] : [...fallback]
}
