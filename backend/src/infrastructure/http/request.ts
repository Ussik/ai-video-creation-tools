import { z } from 'zod'

export const idParams = z.object({ id: z.string().min(1) })

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const diagnostics = z.prettifyError(result.error)
    if (result.error.issues.some(issue => issue.path.includes('activity'))) throw Object.assign(
      new Error('历史任务记录格式不兼容，本次尚未请求模型；已保存内容保留，请刷新后重试。'),
      { statusCode: 422, code: 'script_activity_history_invalid', diagnostics })
    throw Object.assign(new Error(diagnostics), { statusCode: 422 })
  }
  return result.data
}

export function invalid(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 422 })
}
