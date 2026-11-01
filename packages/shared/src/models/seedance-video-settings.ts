import { seedance25VideoResolutions, videoRatios, videoResolutions } from '../media/video-parameters.js'

/** Explicitly applied preset; a remote model name never activates these limits. */
export function seedance2VideoSettings(): Record<string, unknown> {
  return {
    create_path: 'contents/generations/tasks', get_path: 'contents/generations/tasks/{id}',
    id_path: 'id', status_path: 'status', result_path: 'content.video_url', poll_seconds: 10,
    success_statuses: ['succeeded'], failure_statuses: ['failed', 'expired', 'cancelled'],
    video_reference_profile: 'seedance_2_0', max_reference_images: 9,
    supported_modes: ['text', 'first_frame', 'first_last_frame', 'reference'],
    ratios: [...videoRatios], resolutions: [...videoResolutions], default_resolution: '480p',
    min_duration: 4, max_duration: 15,
    request_template: {
      model: '{{model}}', content: '{{content}}', ratio: '{{ratio}}', resolution: '{{resolution}}',
      duration: '{{duration}}', generate_audio: '{{generate_audio}}',
    },
    content_template: [{ type: 'text', text: '{{prompt}}' }, '{{image_references}}'],
    image_reference_template: { type: 'image_url', image_url: { url: '{{image}}' }, role: '{{role}}' },
    reference_roles: { first_frame: ['first_frame'], first_last_frame: ['first_frame', 'last_frame'], reference: ['reference_image'] },
  }
}

/** Volcano Ark Seedance 2.5 contract, explicitly selected by the user. */
export function seedance25VideoSettings(): Record<string, unknown> {
  return {
    create_path: 'contents/generations/tasks', get_path: 'contents/generations/tasks/{id}',
    id_path: 'id', status_path: 'status', result_path: 'content.video_url', poll_seconds: 10,
    success_statuses: ['succeeded'], failure_statuses: ['failed', 'expired', 'cancelled'],
    video_reference_profile: 'seedance_2_5', max_reference_images: 30,
    reference_video_schemes: ['asset:'],
    supported_modes: ['text', 'first_frame', 'first_last_frame', 'reference', 'edit', 'extend'],
    ratios: [...videoRatios], resolutions: [...seedance25VideoResolutions], default_resolution: '720p',
    min_duration: 4, max_duration: 30, supports_draft: true,
    request_template: {
      model: '{{model}}', content: '{{content}}', ratio: '{{ratio}}', resolution: '{{resolution}}',
      duration: '{{duration}}', generate_audio: '{{generate_audio}}', draft: '{{draft}}',
      omni_reference_task_type: '{{omni_reference_task_type}}',
    },
    content_template: [{ type: 'text', text: '{{prompt}}' }, '{{image_references}}', '{{video_references}}'],
    image_reference_template: { type: 'image_url', image_url: { url: '{{image}}' }, role: '{{role}}' },
    video_reference_template: { type: 'video_url', video_url: { url: '{{reference_video_url}}' }, role: 'reference_video' },
    reference_roles: {
      first_frame: ['first_frame'], first_last_frame: ['first_frame', 'last_frame'],
      reference: ['reference_image'], edit: ['reference_image'], extend: ['reference_image'],
    },
    mode_variables: {
      text: { omni_reference_task_type: null },
      first_frame: { ratio: 'adaptive', omni_reference_task_type: null },
      first_last_frame: { ratio: 'adaptive', omni_reference_task_type: null },
      reference: { omni_reference_task_type: 'reference' },
      edit: { ratio: 'adaptive', duration: -1, omni_reference_task_type: 'edit' },
      extend: { ratio: 'adaptive', omni_reference_task_type: 'extend' },
    },
    draft_variables: { resolution: '480p' },
  }
}

function retainConnectionSettings(previous: Record<string, unknown>): Record<string, unknown> {
  const obsolete = new Set([
    'request_templates', 'mode_variables', 'draft_variables', 'supports_draft', 'supports_auto_duration',
    'video_reference_template', 'reference_video_schemes',
  ])
  return Object.fromEntries(Object.entries(previous).filter(([key]) => !obsolete.has(key)))
}

/** Applying the preset must also remove overrides that would shadow its request contract. */
export function applySeedance2VideoSettings(previous: Record<string, unknown>): Record<string, unknown> {
  return { ...retainConnectionSettings(previous), ...seedance2VideoSettings() }
}

export function applySeedance25VideoSettings(previous: Record<string, unknown>): Record<string, unknown> {
  return { ...retainConnectionSettings(previous), ...seedance25VideoSettings() }
}
