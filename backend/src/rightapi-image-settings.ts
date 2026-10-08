/** RightAPI Images contract:
 * https://docs.rightapi.ai/docs/rc_draw/images-generations.html
 * https://docs.rightapi.ai/docs/rc_draw/tasks.html
 * The shared provider can retain its text/video endpoint and credentials. */
export function rightApiImageSettings(existing: Record<string, unknown> = {}): Record<string, unknown> {
  const request = {
    model: '{{model}}', prompt: '{{prompt}}', n: 1, size: '{{ratio}}',
    image: '{{images}}', async: true,
  }
  return {
    ...existing,
    api_base_url: 'https://www.rightapi.ai',
    async_image: true,
    request_path: 'draw/v1/images/generations',
    request_template: request,
    request_templates: { text: request, reference: request },
    get_path: 'v1/tasks/{id}',
    id_path: 'task_id', status_path: 'status', error_path: 'error.message',
    success_statuses: ['completed'], failure_statuses: ['failed', 'cancelled', 'canceled', 'expired'],
    image_base64_path: 'data.0.b64_json', image_url_path: 'data.0.url',
    poll_seconds: 5,
  }
}
