import { cdf, validateCoefficients, type Coefficients } from './distribution'
import { MAX_RANGE_COUNT, type RangeBin } from './ranges'

// ERC-1155 positions mint one balance per range, so entry gas does not grow with the count (measured on a
// Base Sepolia fork, see the integration suite). The cap only bounds a mistyped stake; 10,000 ETH at the minimum price,
// and one range's supply (999,999,999) still bounds what a single range can take.
export const MAX_POSITIONS = 1_000_000_000

export type Allocation = {
  mode: 'curve' | 'manual'
  tierIds: number[]
  quantities: number[]
  probabilities: number[]
  actualProbabilities: number[]
  totalVariationError: number
  count: number
}

export type PositionDensity = { range: RangeBin; quantity: number; share: number; density: number | null }

/** Normalize the whole position set; overflow has a share but no finite density. */
export function positionDensities(ranges: readonly RangeBin[], quantities: readonly number[]): PositionDensity[] {
  validateRanges(ranges)
  validateQuantities(quantities, ranges.length)
  // Display can include an over-budget or empty draft without authorizing it for minting.
  const total = quantities.reduce((sum, quantity) => sum + BigInt(quantity), 0n)
  return ranges.map((range, index) => {
    const quantity = quantities[index]
    const share = total === 0n ? 0 : quantity / Number(total)
    const density = range.lower === null || range.upper === null ? null : share / (range.upper - range.lower)
    return { range, quantity, share, density }
  })
}

/** Integrate each range, then apportion indivisible positions by largest remainder. */
export function allocatePositions(coefficients: Coefficients, ranges: readonly RangeBin[], count: number, limit = MAX_POSITIONS): Allocation {
  const a = validateCoefficients(coefficients)
  validatePositionCount(count, limit)
  const probabilities = rangeProbabilities(a, ranges)
  const quotas = probabilities.map(probability => probability * count)
  const quantities = quotas.map(Math.floor)
  const remaining = count - quantities.reduce((sum, quantity) => sum + quantity, 0)
  const remainderOrder = ranges.map((range, index) => ({
    index,
    tierId: range.tierId,
    remainder: quotas[index] - quantities[index],
  })).sort((left, right) => right.remainder - left.remainder || left.tierId - right.tierId)
  for (let i = 0; i < remaining; i++) quantities[remainderOrder[i].index]++
  return allocationForQuantities('curve', ranges, probabilities, quantities, count)
}

/** Explicit bucket counts own the stake; the curve remains a comparison only. */
export function allocateManualPositions(coefficients: Coefficients, ranges: readonly RangeBin[], quantities: readonly number[], limit = MAX_POSITIONS): Allocation {
  const probabilities = rangeProbabilities(validateCoefficients(coefficients), ranges)
  validateQuantities(quantities, ranges.length)
  const count = quantities.reduce((sum, quantity) => sum + quantity, 0)
  validatePositionCount(count, limit)
  return allocationForQuantities('manual', ranges, probabilities, [...quantities], count)
}

function validateQuantities(quantities: readonly number[], length: number): void {
  if (!Array.isArray(quantities) || quantities.length !== length
    || Array.from(quantities).some(quantity => !Number.isSafeInteger(quantity) || quantity < 0)) {
    throw new Error('Enter one non-negative whole position count for every range.')
  }
}

function validatePositionCount(count: number, limit: number): void {
  if (!Number.isInteger(count) || count < 1 || count > limit) {
    throw new Error(`Choose 1 to ${limit} positions.`)
  }
}

function rangeProbabilities(a: Coefficients, ranges: readonly RangeBin[]): number[] {
  validateRanges(ranges)
  let previous = 0
  return ranges.map(range => {
    const cumulative = range.upper === null ? 1 : cdf(a, range.upper)
    const probability = cumulative - previous
    previous = cumulative
    return probability
  })
}

function validateRanges(ranges: readonly RangeBin[]): void {
  if (ranges.length < 1 || ranges.length > MAX_RANGE_COUNT
    || ranges[0].lower !== null || ranges.at(-1)!.upper !== null) {
    throw new Error('Ranges must cover both tails.')
  }
  const tierIds = new Set<number>()
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i]
    if (!Number.isSafeInteger(range.tierId) || range.tierId < 1 || tierIds.has(range.tierId)) {
      throw new Error('Every range must have a unique positive tier ID.')
    }
    tierIds.add(range.tierId)
    if ((range.lower !== null && !Number.isFinite(range.lower))
      || (range.upper !== null && !Number.isFinite(range.upper))
      || (i > 0 && (range.lower === null || range.lower !== ranges[i - 1].upper))
      || (i < ranges.length - 1 && range.upper === null)
      || (range.lower !== null && range.upper !== null && range.lower >= range.upper)) {
      throw new Error('Ranges must be ordered, contiguous and non-overlapping.')
    }
  }

}

function allocationForQuantities(mode: Allocation['mode'], ranges: readonly RangeBin[], probabilities: number[], quantities: number[], count: number): Allocation {
  const actualProbabilities = quantities.map(quantity => quantity / count)
  const totalVariationError = probabilities.reduce((sum, probability, index) =>
    sum + Math.abs(probability - actualProbabilities[index]), 0) / 2

  return { mode, tierIds: ranges.map(range => range.tierId), quantities, probabilities, actualProbabilities, totalVariationError, count }
}
