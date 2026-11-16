/** Public transport evidence; never request bodies, credentials or reasoning. */
export const structuredStrategySources = ['configured', 'declared', 'default'] as const
export type TextStructuredObservation = {
  structured_strategy_source?: typeof structuredStrategySources[number]
  structured_enforcement?: 'unverified'
  request_prompt_hash?: string
  request_body_hash?: string
  response_body_hash?: string
  response_text_hash?: string
  response_json_valid?: boolean
}
