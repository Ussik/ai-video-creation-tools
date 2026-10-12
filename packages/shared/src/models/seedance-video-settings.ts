import { videoRatios, videoResolutions } from '../media/video-parameters.js'

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

/** Applying the preset must also remove overrides that would shadow its request contract. */
export function applySeedance2VideoSettings(previous: Record<string, unknown>): Record<string, unknown> {
  const obsolete = new Set([
    'request_templates', 'mode_variables', 'draft_variables', 'supports_draft',
    // The image-reference preset does not submit video references or draft
    // fields, so inherited controls for these cannot remain enabled silently.
    'video_reference_template',
  ])
  const retained = Object.fromEntries(Object.entries(previous).filter(([key]) => !obsolete.has(key)))
  return { ...retained, ...seedance2VideoSettings() }
}
