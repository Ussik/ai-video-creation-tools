import { z } from 'zod'
import type { TextTool } from '../../infrastructure/providers/text-tools.js'

export type StructuredOutputToolRepair = {
  /** The tool definition to pass to the model */
  tool: TextTool
  /** Extract and validate the repair from tool call arguments */
  apply: (toolArguments: unknown) => unknown
  /** Optional syntax audit for tracking insertions */
  syntaxAudit?: { policy: string; original_hash: string; repaired_hash: string; escape_offsets: number[] }
}

export type StructuredOutputToolPlanner = (candidate: unknown, failure: {
  issues: readonly z.ZodIssue[]
  error?: unknown
}) => StructuredOutputToolRepair | undefined

type Path = Array<string | number>
const unsafe = new Set(['__proto__', 'prototype', 'constructor'])

function at(value: unknown, path: Path): unknown {
  for (const key of path) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) {
      throw new Error('纠正目标不属于完整冻结提案')
    }
    value = (value as Record<string | number, unknown>)[key]
  }
  return value
}

/** Tool-based local repair with schema-level constraints.
 * The model calls a structured tool instead of generating free-form JSON,
 * allowing us to embed validation constraints directly in the tool schema. */
export function toolBasedLocalRepair(input: {
  candidate: unknown
  targets: Array<{
    key: string
    path: Path
    schema: z.ZodType
    /** Optional constraints to add to the tool schema (e.g., min/max for section_ids) */
    constraints?: {
      minimum?: number
      maximum?: number
      description?: string
    }
  }>
  prompt: string
  /** Additional context about validation constraints */
  constraintContext?: string
}): StructuredOutputToolRepair {
  const candidate = structuredClone(input.candidate)
  const paths = input.targets.map(target => [...target.path])

  if (!paths.length || paths.length > 200 || new Set(input.targets.map(target => target.key)).size !== paths.length) {
    throw new Error('局部纠正目标不能为空、重复或超过200项')
  }

  paths.forEach((path, index) => {
    if (!path.length || path.some(key => typeof key === 'number' ? !Number.isSafeInteger(key) || key < 0 : unsafe.has(key)) ||
        input.targets.some((target, other) => other !== index && (prefix(path, target.path) || prefix(target.path, path)))) {
      throw new Error('局部纠正目标路径不合法或互相重叠')
    }
    if (unsafe.has(input.targets[index]!.key)) {
      throw new Error('局部纠正键不合法')
    }
    at(candidate, path)
  })

  // Convert Zod schemas to JSON Schema with embedded constraints
  const repairsProperties: Record<string, any> = {}
  for (const target of input.targets) {
    let jsonSchema = zodToJsonSchema(target.schema)

    // Apply additional constraints if provided
    if (target.constraints) {
      jsonSchema = { ...jsonSchema, ...target.constraints }
    }

    repairsProperties[target.key] = jsonSchema
  }

  const toolSchema = {
    type: 'object',
    properties: {
      repairs: {
        type: 'object',
        properties: repairsProperties,
        required: Object.keys(repairsProperties),
        additionalProperties: false,
      },
      reason: {
        type: 'string',
        description: '本次修复的原因说明',
      }
    },
    required: ['repairs'],
    additionalProperties: false,
  }

  const tool: TextTool = {
    name: 'submit_local_repair',
    description: '提交局部纠正。' + (input.constraintContext || '仅修复指定的错误字段，保持其他内容不变。'),
    parameters: toolSchema,
  }

  return {
    tool,
    apply(toolArguments: unknown) {
      if (!toolArguments || typeof toolArguments !== 'object' || !('repairs' in toolArguments)) {
        throw new Error('工具调用参数必须包含 repairs 字段')
      }

      const args = toolArguments as { repairs: Record<string, unknown>; reason?: string }
      const merged = structuredClone(candidate)

      input.targets.forEach((target, index) => {
        if (!Object.hasOwn(args.repairs, target.key)) {
          throw new Error(`缺少必需的修复字段: ${target.key}`)
        }

        const path = paths[index]!
        const parent = at(merged, path.slice(0, -1))
        if (!parent || typeof parent !== 'object') {
          throw new Error('局部纠正目标父级已失效')
        }

        Object.defineProperty(parent, path.at(-1)!, {
          value: structuredClone(args.repairs[target.key]),
          enumerable: true,
          configurable: true,
          writable: true,
        })
      })

      return merged
    },
  }
}

const prefix = (left: Path, right: Path) =>
  left.length <= right.length && left.every((key, index) => key === right[index])

/** Simplified Zod to JSON Schema converter for tool parameters */
function zodToJsonSchema(schema: z.ZodType): any {
  if (schema instanceof z.ZodString) {
    const checks = (schema as any)._def.checks || []
    const result: any = { type: 'string' }
    for (const check of checks) {
      if (check.kind === 'min') result.minLength = check.value
      if (check.kind === 'max') result.maxLength = check.value
    }
    return result
  }

  if (schema instanceof z.ZodNumber) {
    const checks = (schema as any)._def.checks || []
    const result: any = { type: schema instanceof z.ZodNumber && (schema as any)._def.checks?.some((c: any) => c.kind === 'int') ? 'integer' : 'number' }
    for (const check of checks) {
      if (check.kind === 'min') result.minimum = check.value
      if (check.kind === 'max') result.maximum = check.value
    }
    return result
  }

  if (schema instanceof z.ZodArray) {
    const element = (schema as any)._def.type
    const result: any = {
      type: 'array',
      items: zodToJsonSchema(element),
    }
    const minLength = (schema as any)._def.minLength
    const maxLength = (schema as any)._def.maxLength
    if (minLength != null) result.minItems = minLength.value
    if (maxLength != null) result.maxItems = maxLength.value
    return result
  }

  if (schema instanceof z.ZodObject) {
    const shape = (schema as any)._def.shape()
    const properties: Record<string, any> = {}
    const required: string[] = []

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value as z.ZodType)
      if (!(value instanceof z.ZodOptional)) {
        required.push(key)
      }
    }

    return {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    }
  }

  if (schema instanceof z.ZodBoolean) {
    return { type: 'boolean' }
  }

  if (schema instanceof z.ZodNull) {
    return { type: 'null' }
  }

  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    const inner = zodToJsonSchema((schema as any)._def.innerType)
    return { ...inner, nullable: true }
  }

  // Fallback for unsupported types
  return { type: 'string', description: 'Schema类型暂不支持，请使用字符串' }
}
