import { parseUnits } from 'viem'

export const SCORECARD_WEIGHT_TOTAL = 1_000_000_000_000_000_000n
export type TierWeight = { tierId: number; weight: string }

/** Percentages have 16 fractional places because 100% equals 1e18 native scorecard units. */
export function scorecardWeightsFromPercentages(
  ranges: readonly { tierId: number }[], values: readonly string[],
): TierWeight[] {
  if (values.length !== ranges.length || !values.length) throw new Error('Enter a percentage for every range.')
  const weights = values.map((raw, i) => {
    const value = raw.trim() || '0'
    if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,16})?$/.test(value)) {
      throw new Error('Result percentages must be nonnegative decimals with at most 16 decimal places.')
    }
    return { tierId: ranges[i].tierId, weight: parseUnits(value, 16).toString() }
  })
  if (weights.reduce((sum, item) => sum + BigInt(item.weight), 0n) !== SCORECARD_WEIGHT_TOTAL) {
    throw new Error('Result percentages must add to exactly 100%.')
  }
  return weights.filter(item => item.weight !== '0')
}
