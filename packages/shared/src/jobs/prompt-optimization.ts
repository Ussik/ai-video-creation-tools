/** Explicit moderation refusals; transport, quota and generic failures do not match. */
export function isContentPolicyRejection(error: string | null | undefined): boolean {
  return !!error && /(?:\b(?:content[_ -]policy[_ -](?:violation|rejection)|content[_ -]filter|safety[_ -](?:violation|rejection)|moderation[_ -]blocked)\b|(?:violate|violates|violated|violating|against)[\s\S]{0,80}(?:content|safety) polic(?:y|ies)|(?:blocked|rejected|refused)[\s\S]{0,80}(?:content policy|safety policy|moderation)|(?:提示词|内容|请求)[^。\n]{0,35}(?:违规|违反[^。\n]{0,15}(?:政策|规则)|审核未通过|未通过[^。\n]{0,10}审核)|(?:内容审核|安全审核)[^。\n]{0,20}(?:拒绝|不通过|失败))/i.test(error)
}

export function jobPromptRequest(request: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(request)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return {} }
}

export function canOptimizeImagePrompt(job: { status: string; job_type: string; error: string | null; request: string; recovery_available?: boolean;
  recovery_action?: 'verify' | 'query' | 'download' | null }, modality?: string): boolean {
  const prompt = jobPromptRequest(job.request).prompt
  return modality === 'image' && job.job_type === 'generation' && job.status === 'failed' && !job.recovery_available
    && job.recovery_action !== 'query' && job.recovery_action !== 'download' &&
    isContentPolicyRejection(job.error) && typeof prompt === 'string' && !!prompt.trim() && prompt.length <= 80_000
}

export type PromptOptimizationResult = { prompt: string; changes: string[] }
