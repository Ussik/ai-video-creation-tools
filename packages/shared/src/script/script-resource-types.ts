export type VisualDraftValue = { kind: 'character' | 'location' | 'prop'; name: string; variant: string; definition: string; view_requirements: string; scene_ids: string[] }
export type ShotDraftValue = { title: string; prompt: string; image_prompt: string; video_prompt: string; duration: number; start_state: string; end_state: string; cut_note: string }
export type BindingDraftValue = { profile_id: string; required: boolean; usage?: import('../visuals/visual-binding-usage.js').VisualBindingUsage }
export type ResourceChange =
  | { type: 'visual_profile'; id: string; title: string; base_version: string; original: VisualDraftValue | null; value: VisualDraftValue }
  | { type: 'shot'; id: string; title: string; base_version: string; original: ShotDraftValue; value: ShotDraftValue }
  | { type: 'new_shot'; id: string; title: string; source_scene_id: string; base_version: string; original: null; value: ShotDraftValue }
  | { type: 'visual_binding'; id: string; title: string; target_type: 'scene' | 'shot'; base_version: string; original: BindingDraftValue[]; value: BindingDraftValue[]; refresh_profile_ids: string[] }
