import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatTokenQuantity, parseTokenQuantity } from '../src/features/models/token-quantity'

test('token quantities accept decimal K/M units and preserve exact integer counts', () => {
  for (const [input, expected] of [
    ['128K', 128_000], ['128k', 128_000], ['1M', 1_000_000], ['1m', 1_000_000],
    ['1.5M', 1_500_000], ['0.5K', 500], ['1.001K', 1_001], ['0.000001M', 1],
    [' 128 K ', 128_000], ['128000', 128_000], ['1,048,576', 1_048_576],
    ['1,000.25K', 1_000_250], ['000128k', 128_000], ['1.000000000K', 1_000],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ] as const) assert.equal(parseTokenQuantity(input), expected, input)
})

test('token quantities reject malformed, fractional, unsafe and nonpositive counts', () => {
  for (const input of [
    '', ' ', 'K', '1G', '1KB', '1e3', '1_000', '-1', '+128K', '0', '0M', '0.000M',
    '1.5', '1.0', '.5K', '1.K', '1,28K', '1,0000', '1,,000', '1234,567',
    '0.0001K', '1.0000001M', '9007199254740992', '9007199254740.992K',
    '9007199254.740992M', '128K extra', '1 000K',
  ]) assert.equal(parseTokenQuantity(input), null, input)
})

test('token formatting keeps compact values readable without losing precision', () => {
  for (const [value, expected] of [
    [128_000, '128K'], [1_000_000, '1M'], [1_500_000, '1.5M'], [1_001_000, '1.001M'],
    [16_384, '16.384K'], [1_048_576, '1,048,576'], [999, '999'], [1_001, '1.001K'],
    [Number.MAX_SAFE_INTEGER, '9,007,199,254,740,991'],
  ] as const) {
    assert.equal(formatTokenQuantity(value), expected)
    assert.equal(parseTokenQuantity(formatTokenQuantity(value)), value)
  }
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(formatTokenQuantity(value), '')
})
