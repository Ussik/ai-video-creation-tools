import { z } from 'zod'

export const idParams = z.object({ id: z.string().min(1) })

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw Object.assign(new Error(z.prettifyError(result.error)), { statusCode: 422 })
  return result.data
}

export function invalid(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 422 })
}
