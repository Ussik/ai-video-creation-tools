/** Existing workflow fixtures explicitly declare their reference decisions.
 * Coverage validation tests supply hand-written decisions instead. */
export function withFixtureVisualCoverage(raw: string, prompt: string) {
  const draft = JSON.parse(raw)
  if (draft.visual_coverage) return raw
  const scenes = JSON.parse(prompt.split('选定场次：').at(-1)!.split('\n选定场次已规划镜头：')[0]!)
  const shots = JSON.parse(prompt.split('选定场次已规划镜头：').at(-1)!)
  draft.visual_coverage = fixtureVisualCoverage(draft.profiles, scenes, shots)
  return JSON.stringify(draft)
}
export function fixtureVisualCoverage(profiles: any[], scenes: any[], shots: any[]) {
  const targets = scenes.flatMap((scene: any) => {
    const planned = shots.filter((shot: any) => shot.scene_id === scene.id)
    return planned.length ? planned.map((shot: any) => ({ scene_id: scene.id, shot_id: shot.shot_id,
      source_excerpt: shot.image_prompt || shot.video_prompt || shot.prompt || shot.title }))
      : [{ scene_id: scene.id, shot_id: null, source_excerpt: scene.action || scene.heading }]
  })
  return targets.map((target: any) => {
    const objects = profiles.filter((profile: any) => profile.scene_ids.includes(target.scene_id))
      .flatMap((profile: any) => {
        const usage = target.shot_id ? profile.shot_usage?.find((item: any) => item.shot_id === target.shot_id)?.usage || 'none' : 'both'
        return usage === 'none' ? [] : [{ kind: profile.kind, name: profile.name, variant: profile.variant || '默认', usage,
          requires_profile: true, reason: '本回归场景明确使用该档案维持画面对象的一致性。' }]
      })
    return { ...target, objects, no_reference_reason: objects.length ? '' : '该测试画面仅使用普通环境，不依赖固定身份或关键道具参考。' }
  })
}
