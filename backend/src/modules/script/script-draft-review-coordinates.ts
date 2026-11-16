import { createHash } from 'node:crypto'
import { z } from 'zod'
import { scriptArtifactTypes } from '@video-studio/shared/script/script-stage-content'
import { generateStructuredOutput, restoreOptionalNulls, type StructuredGenerator } from '../generation/model-output.js'
import { modelStepSignal } from '../generation/model-execution.js'
import { TextOutputLimitError } from '../../infrastructure/providers/text-errors.js'
import { scriptDraftFindingLimit } from './script-finding-state.js'
import type { GenerationSteps } from './script-generation-steps.js'
import { scriptSourcePassages } from './script-source-map.js'
import { generatePagedReviewItems } from './script-review-pagination.js'
import { recoverArrayStream } from './script-streamed-units.js'

type Source = { key: string; title: string; artifact_type: string; content: string }
const coordinateProtocol = 'draft_review_coordinates_v1'

/** Candidate text appears once, in complete, program-numbered units. IDs are
 * local to one immutable document; the content ref also binds their policy. */
export function createDraftReviewCoordinates(sources: Source[]) {
  if (!sources.length || new Set(sources.map(source => source.key)).size !== sources.length) {
    throw new Error('坐标审读必须提供非空且标识唯一的候选文档')
  }
  const documents = sources.map(source => ({ ...source,
    source_ref: createHash('sha256').update(JSON.stringify({ protocol: coordinateProtocol,
      unit_policy: 1, key: source.key, content: source.content })).digest('base64url').slice(0, 22),
    units: scriptSourcePassages(source.content).flatMap(passage => passage.units),
  }))
  const findingSchema = z.object({
    topic: z.string().trim().min(1).max(160).optional(),
    source_key: z.enum(documents.map(source => source.key)),
    source_ref: z.enum(documents.map(source => source.source_ref)),
    first_unit: z.number().int().nonnegative(), last_unit: z.number().int().nonnegative(),
    kind: z.enum(['unresolved_setting', 'missing_core_setting', 'contradiction']),
    severity: z.enum(['blocking', 'suggestion']),
    explanation: z.string().trim().min(1).max(2000), suggestion: z.string().trim().min(1).max(2000),
  }).strict()
  const schema = z.object({ facts: z.array(z.unknown()).max(0),
    checked_artifacts: z.array(z.enum(scriptArtifactTypes)).min(1).max(scriptArtifactTypes.length),
    findings: z.array(findingSchema).max(scriptDraftFindingLimit),
  }).strict()
  const expected = [...new Set(sources.map(source => source.artifact_type))]
  const hydrateFinding = (value: unknown) => {
    const finding = findingSchema.parse(value)
    const source = documents.find(source => source.key === finding.source_key)!
    if (source.source_ref !== finding.source_ref) throw new Error('审读证据的来源版本必须与 source_key 对应的当前候选文档一致')
    const first = source.units.find(unit => unit.id === finding.first_unit)
    const last = source.units.find(unit => unit.id === finding.last_unit)
    if (!first || !last || first.id > last.id) throw new Error('审读证据必须选择对应候选文档中存在且有序的连续句段编号')
    const quote = source.content.slice(first.offset, last.offset + last.text.length).trim()
    if (!quote || quote.length > 4000) throw new Error('审读证据必须是非空且不超过4000字的连续候选原文')
    const { source_ref: _ref, first_unit: _first, last_unit: _last, ...semantic } = finding
    return { ...semantic, quote }
  }
  const hydrate = (value: unknown) => {
    const result = schema.parse(value)
    if (result.checked_artifacts.length !== expected.length || new Set(result.checked_artifacts).size !== expected.length ||
      expected.some(type => !result.checked_artifacts.includes(type as typeof scriptArtifactTypes[number]))) {
      throw new Error('设定核对必须准确覆盖本次送审的全部文档类型')
    }
    return { facts: [], checked_artifacts: result.checked_artifacts, findings: result.findings.map(hydrateFinding) }
  }
  return { protocol: coordinateProtocol, schema, findingSchema, hydrateFinding, hydrate,
    material: documents.map(({ content: _content, units, ...source }) => ({ ...source, units: units.map(({ id, text }) => ({ id, text })) })),
  }
}

export type DraftReviewCoordinates = ReturnType<typeof createDraftReviewCoordinates>

/** Fresh reports never copy quotes. Partial pages retain the same strict wire
 * contract; only program-resolved text reaches the ordinary business schema. */
export async function generateDraftReviewCoordinates<T>(prompt: string, coordinates: DraftReviewCoordinates,
  generate: StructuredGenerator, validate: (value: unknown) => T,
  options: { signal?: AbortSignal; steps?: GenerationSteps; parentId?: string; answerMode?: boolean; paged?: boolean;
    onRetainedFindings?: (findings: ReturnType<DraftReviewCoordinates['hydrateFinding']>[]) => void } = {}): Promise<T> {
  const input = { version: 1, protocol: coordinates.protocol, prompt }
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const id = `review:coordinate-response:${hash}`, seedId = `${id}:seed`
  const saved = options.steps?.checkpoint.steps[seedId]
  const initialItems = saved?.input_hash === hash ? z.array(coordinates.findingSchema).parse(saved.value) : []
  for (const item of initialItems) coordinates.hydrateFinding(item)
  const reviewGenerate: StructuredGenerator = (text, contract) => generate(text, contract && {
    ...contract, request_policy: options.answerMode ? 'script_review_answer' : 'script_review',
  })
  modelStepSignal(options.signal)?.throwIfAborted()
  if (options.paged) {
    const findings = await generatePagedReviewItems({ id: `${id}:pages`, name: 'script_draft_completeness_coordinates',
      itemSchema: coordinates.findingSchema, prompt, generate: reviewGenerate, ...options,
      initialItems, maxItems: scriptDraftFindingLimit, validateItem: item => { coordinates.hydrateFinding(item) },
    })
    return validate(coordinates.hydrate({ facts: [], checked_artifacts: [...new Set(coordinates.material.map(source => source.artifact_type))], findings }))
  }
  try {
    const wire = await generateStructuredOutput('script_draft_completeness_coordinates', coordinates.schema,
      reviewGenerate, prompt, { signal: options.signal, validate: value => { validate(coordinates.hydrate(value)) } })
    return validate(coordinates.hydrate(wire))
  } catch (issue) {
    modelStepSignal(options.signal)?.throwIfAborted()
    if (issue instanceof TextOutputLimitError) {
      const findingInput = z.toJSONSchema(coordinates.findingSchema, { io: 'input', unrepresentable: 'any' })
      const findings = recoverArrayStream(issue.partialText, 'findings').map(item =>
        coordinates.findingSchema.parse(restoreOptionalNulls(item, findingInput)))
      const hydrated = findings.map(coordinates.hydrateFinding)
      if (findings.length) {
        options.steps?.retain(seedId, '保留坐标审读中已完成的问题', input, findings, value => {
          const items = z.array(coordinates.findingSchema).parse(value)
          items.forEach(coordinates.hydrateFinding)
          return items
        }, options.parentId)
        options.onRetainedFindings?.(hydrated)
      }
    }
    throw issue
  }
}

export function retainedDraftCoordinateFindings(prompt: string, coordinates: DraftReviewCoordinates, steps?: GenerationSteps) {
  const input = { version: 1, protocol: coordinates.protocol, prompt }
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const saved = steps?.checkpoint.steps[`review:coordinate-response:${hash}:seed`]
  return saved?.input_hash === hash ? z.array(coordinates.findingSchema).parse(saved.value).map(coordinates.hydrateFinding) : undefined
}

/** Keep both generations of private state intact; new protocol steps cannot
 * overwrite old reasoning, pagination or provider delivery chains. */
export function draftCoordinateSteps(steps?: GenerationSteps): GenerationSteps | undefined {
  if (!steps) return undefined
  const prefix = 'review:coordinates:v1:'
  return {
    get checkpoint() { return { ...steps.checkpoint, steps: Object.fromEntries(Object.entries(steps.checkpoint.steps)
      .filter(([id]) => id.startsWith(prefix)).map(([id, value]) => [id.slice(prefix.length), value])) } },
    readStructuredResponse: (id, input, name, prompt, schema) => steps.readStructuredResponse?.(prefix + id, input, name, prompt, schema),
    retain: (id, label, input, value, validate, parentId) => steps.retain(prefix + id, label, input, value, validate, parentId),
    forget: id => steps.forget(prefix + id),
    run: (id, label, input, work, validate, parentId) => steps.run(prefix + id, label, input, work, validate, parentId),
  }
}
