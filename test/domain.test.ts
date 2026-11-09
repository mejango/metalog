import { describe, expect, it } from 'vitest'
import { allocateManualPositions, allocatePositions, MAX_POSITIONS, positionDensities } from '../src/domain/allocation'
import { cdf, coefficientsFromMoments, densityBuckets, parseCoefficientFields, parseCoefficients, pdf, quantile, validateCoefficients } from '../src/domain/distribution'
import { decodeMarketDefinition, encodeMarketDefinition, marketRanges, MAX_ENTRY_DURATION_SECONDS, MAX_RESOLUTION_DURATION_SECONDS, MAX_TIMESTAMP_SECONDS, MAX_UNIT_PRICE_WEI, parseDefaultDelegate, validateMarket, type MarketDefinition } from '../src/domain/market'
import { binForOutcome, createCustomRanges, createRanges, formatPercentage, MAX_RANGE_BOUNDARY, MAX_RANGE_COUNT, MAX_RANGE_WIDTH, MIN_RANGE_WIDTH, parseRangeBoundary, parseRangeBoundaries, rangeBoundaryIssues, redistributeRangeBoundaries, validateRangeWidth } from '../src/domain/ranges'

const definition: MarketDefinition = {
  schemaVersion: 1,
  settlement: 'defifa-scorecard',
  prompt: 'What will BTC/USD’s change be over this observation period?',
  source: 'BTC/USD reference feed',
  resolutionRule: 'Use the observations at the two timestamps; the ratified Defifa scorecard controls payouts.',
  entryOpensAt: 1_800_000_000,
  entryClosesAt: 1_800_086_400,
  resolvesAt: 1_800_172_800,
  rangeCount: 21,
  rangeWidth: 1,
  unitPriceWei: '10000000000000',
}

describe('Metalog distributions', () => {
  it('uses the exact logistic mean and deviation and agrees with its analytic CDF/PDF', () => {
    const mean = 3.25
    const sigma = 4
    const a = coefficientsFromMoments(mean, sigma)
    const scale = sigma * Math.sqrt(3) / Math.PI
    expect(a).toEqual([mean, scale, 0, 0, 0, 0])
    expect(quantile(a, 0.5)).toBe(mean)
    expect(pdf(a, mean)).toBeCloseTo(1 / (4 * scale), 14)
    for (const x of [-100, -5, 0, mean, 9, 100]) {
      expect(cdf(a, x)).toBeCloseTo(1 / (1 + Math.exp(-(x - mean) / scale)), 14)
    }
    for (const p of [1e-10, 0.001, 0.05, 0.25, 0.5, 0.9, 0.999, 1 - 1e-10]) {
      expect(cdf(a, quantile(a, p))).toBeCloseTo(p, 14)
    }
    expect(quantile(a, 0)).toBe(-Infinity)
    expect(quantile(a, 1)).toBe(Infinity)
    expect(cdf(a, -Infinity)).toBe(0)
    expect(cdf(a, Infinity)).toBe(1)
    expect(pdf(a, Infinity)).toBe(0)
  })

  it('evaluates a six-term curve using the published quantile basis', () => {
    const a = validateCoefficients([3, 2, 0.5, 1, 0.1, 0.3])
    const p = 0.8
    const z = p - 0.5
    const l = Math.log(p / (1 - p))
    const x = 3 + 2 * l + 0.5 * z * l + z + 0.1 * z ** 2 + 0.3 * z ** 2 * l
    const derivative = 2 / (p * (1 - p)) + 0.5 * (l + z / (p * (1 - p))) + 1
      + 0.2 * z + 0.3 * (2 * z * l + z ** 2 / (p * (1 - p)))
    expect(quantile(a, p)).toBeCloseTo(x, 14)
    expect(pdf(a, x)).toBeCloseTo(1 / derivative, 14)
    expect(cdf(a, x)).toBeCloseTo(p, 14)
  })

  it('rejects precision-losing spreads and keeps accepted large-offset curves drawable', () => {
    expect(() => coefficientsFromMoments(1_000_000, 1e-9)).toThrow('could not be verified')
    const a = coefficientsFromMoments(1_000_000, 1e-6)
    const lower = quantile(a, 0.001)
    const upper = quantile(a, 0.999)
    expect(upper - lower).toBeGreaterThan(1_000 * Number.EPSILON * Math.abs(a[0]))
    expect(Number.isFinite(pdf(a, a[0]))).toBe(true)
    expect(cdf(a, a[0])).toBeCloseTo(0.5, 14)
  })

  it('preserves visible probability when a valid raw curve has a sub-pixel spike', () => {
    const a = validateCoefficients([0, 1, 1e-8, -3.99999996, 0, 0])
    const display = densityBuckets(a)
    const area = display.buckets.reduce((sum, bucket) => sum + bucket.density * (bucket.upper - bucket.lower), 0)
    expect(area).toBeCloseTo(0.99, 12)
    expect(display.visibleMass).toBeCloseTo(area, 14)
    expect(display.buckets.reduce((sum, bucket) => sum + bucket.mass, 0)).toBeCloseTo(area, 14)
    expect(display.buckets.every(bucket => Number.isFinite(bucket.density) && bucket.density >= 0)).toBe(true)
    // The displayed ordinate is an interval average, not an undersampled claim about the pointwise peak.
    expect(display.peak).toBeLessThan(pdf(a, quantile(a, 0.5)))
  })

  it('keeps a smooth logistic density profile symmetric with accurate average heights', () => {
    const a = coefficientsFromMoments(0, 2)
    const display = densityBuckets(a)
    expect(display.buckets).toHaveLength(240)
    expect(display.low).toBeCloseTo(-display.high, 12)
    expect(display.visibleMass).toBeCloseTo(0.99, 14)
    expect(display.buckets[119].density).toBeCloseTo(display.buckets[120].density, 12)
    expect(display.peak).toBeLessThan(pdf(a, 0))
    expect(display.peak).toBeGreaterThan(pdf(a, 0) * 0.999)
    for (let i = 1; i < display.buckets.length; i++) {
      expect(display.buckets[i].lower).toBe(display.buckets[i - 1].upper)
    }
    for (const count of [0, 1, 2.5, Infinity, 1_025]) expect(() => densityBuckets(a, count)).toThrow()
  })

  it('preserves the actual probability inside a fixed viewport, including narrow spikes', () => {
    const bounds = { low: -9.5, high: 9.5 }
    for (const a of [coefficientsFromMoments(3, 5), validateCoefficients([0, 1, 1e-8, -3.99999996, 0, 0])]) {
      const display = densityBuckets(a, 600, bounds)
      const area = display.buckets.reduce((sum, bucket) => sum + bucket.density * (bucket.upper - bucket.lower), 0)
      expect(display.low).toBe(bounds.low)
      expect(display.high).toBe(bounds.high)
      expect(display.buckets[0].lower).toBe(bounds.low)
      expect(display.buckets.at(-1)!.upper).toBe(bounds.high)
      expect(display.visibleMass).toBeCloseTo(cdf(a, bounds.high) - cdf(a, bounds.low), 14)
      expect(area).toBeCloseTo(display.visibleMass, 14)
    }
    const outside = densityBuckets(coefficientsFromMoments(1000, 1), 240, bounds)
    expect(outside.visibleMass).toBe(0)
    expect(outside.peak).toBe(0)
    expect(outside.buckets.every(bucket => bucket.mass === 0 && bucket.density === 0)).toBe(true)
    for (const invalid of [
      { low: 0, high: 0 }, { low: 1, high: -1 }, { low: NaN, high: 1 },
      { low: -Infinity, high: 1 }, { low: 0, high: Infinity }, { low: -1e308, high: 1e308 },
    ]) expect(() => densityBuckets(coefficientsFromMoments(0, 1), 240, invalid)).toThrow('finite and increasing')
  })

  it('accepts basic and screenshot-shaped vectors and rejects nonmonotonic or uncertifiable curves honestly', () => {
    expect(parseCoefficients('[0, 1]')).toEqual([0, 1, 0, 0, 0, 0])
    expect(() => validateCoefficients([0, 0.0020171, 0, 0.01662741, 0, 0.00510748])).not.toThrow()
    expect(() => validateCoefficients([0, 1, 0, -4.00001])).toThrow('could not be verified')
    // This is feasible, but deliberately outside the conservative certificate.
    expect(() => validateCoefficients([0, 1, 1.5])).toThrow('could not be verified')
    for (const input of ['[0]', '[0,1,2,3,4,5,6]', '[0,"1"]', '[null,1]', '[0,1e309]', '{}', '0,1']) {
      expect(() => parseCoefficients(input)).toThrow()
    }
    expect(() => validateCoefficients(new Array<number>(2))).toThrow('finite')
    for (const [mean, sigma] of [[NaN, 1], [0, 0], [0, -1], [0, Infinity], [1e9, 1]]) {
      expect(() => coefficientsFromMoments(mean, sigma)).toThrow()
    }
    const a = coefficientsFromMoments(0, 1)
    expect(() => cdf(a, NaN)).toThrow()
    expect(() => quantile(a, 1.1)).toThrow()
  })

  it('parses individual signed decimal and scientific coefficients without rounding', () => {
    expect(parseCoefficientFields(['+.25', '1.1026577908435842', '1.e-2', ' 0. ', '-.003', '2E-4']))
      .toEqual([.25, 1.1026577908435842, .01, 0, -.003, .0002])
    const original = coefficientsFromMoments(-2.543210987654321, .753210987654321)
    expect(parseCoefficientFields(original.map(String))).toEqual(original)
  })

  it('identifies incomplete or malformed coefficient fields and accepts their completed drafts', () => {
    for (const draft of ['', ' ', '-', '+', '.', '-.', '1e', '1e-', '0x10', 'NaN', 'Infinity', '1e309', '1,2']) {
      const fields = ['0', '1', draft, '0', '0', '0']
      expect(() => parseCoefficientFields(fields)).toThrow('a3')
      fields[2] = '-.25'
      expect(parseCoefficientFields(fields)).toEqual([0, 1, -.25, 0, 0, 0])
    }
  })

  it('requires six complete fields and retains coefficient bounds and shape validation', () => {
    for (const fields of [[], ['0', '1'], ['0', '1', '0', '0', '0', '0', '0']]) {
      expect(() => parseCoefficientFields(fields)).toThrow('all six')
    }
    expect(() => parseCoefficientFields(new Array<string>(6))).toThrow('a1')
    for (const median of ['-1000000', '1000000']) {
      expect(parseCoefficientFields([median, '1', '0', '0', '0', '0'])[0]).toBe(Number(median))
    }
    for (const median of ['-1000001', '1000001']) {
      expect(() => parseCoefficientFields([median, '1', '0', '0', '0', '0'])).toThrow('between')
    }
    expect(() => parseCoefficientFields(['0', '1', '0', '-4', '0', '0'])).toThrow('could not be verified')
    expect(() => parseCoefficientFields(['0', '-1', '0', '0', '0', '0'])).toThrow('could not be verified')
  })
})

describe('Ranges and indivisible positions', () => {
  it('centers equal-width ranges on zero and covers overflow and exact edges', () => {
    const ranges = createRanges()
    expect(ranges).toHaveLength(21)
    expect(ranges[0].lower).toBeNull()
    expect(ranges[20].upper).toBeNull()
    expect(ranges[0].upper).toBe(-9.5)
    expect(ranges[20].lower).toBe(9.5)
    expect(ranges[10].lower).toBe(-0.5)
    expect(ranges[10].upper).toBe(0.5)
    for (const range of ranges.slice(1, -1)) expect(range.upper! - range.lower!).toBe(1)
    expect(binForOutcome(ranges, -1e100)).toBe(ranges[0])
    expect(binForOutcome(ranges, 1e100)).toBe(ranges[20])
    expect(binForOutcome(ranges, 0)).toBe(ranges[10])
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].lower).toBe(ranges[i - 1].upper)
      expect(binForOutcome(ranges, ranges[i].lower!)).toBe(ranges[i])
      expect(ranges[i].lower).toBeCloseTo(-ranges[ranges.length - i - 1].upper!, 12)
    }
    expect(formatPercentage(-0.0001)).toBe('0%')
    expect(formatPercentage(2.5)).toBe('+2.5%')
    for (const count of [0, 2, 4, 62, 3.5, NaN]) expect(() => createRanges(count)).toThrow()
    expect(() => binForOutcome(ranges, Infinity)).toThrow()
  })

  it('uses the exact advertised precision for range membership and allocation', () => {
    const ranges = createRanges()
    expect(ranges[10].label).toBe('-0.5% to < +0.5%')
    expect(binForOutcome(ranges, 0.49999)).toBe(ranges[10])
    expect(binForOutcome(ranges, 0.5)).toBe(ranges[11])
    expect(binForOutcome(ranges, -0.5)).toBe(ranges[10])
    const a = coefficientsFromMoments(0, 1)
    const allocation = allocatePositions(a, ranges, 100)
    expect(allocation.probabilities[10]).toBe(cdf(a, 0.5) - cdf(a, -0.5))
    for (const range of ranges) {
      for (const bound of [range.lower, range.upper]) {
        if (bound !== null) expect(bound).toBe(Number(bound.toFixed(4)))
      }
    }
  })

  it('uses custom widths consistently, including two-decimal values and half-width boundaries', () => {
    for (const count of [3, 21, MAX_RANGE_COUNT]) {
      for (const width of [MIN_RANGE_WIDTH, 0.07, 0.29, 1, 2.55, MAX_RANGE_WIDTH]) {
        const ranges = createRanges(count, width)
        const center = ranges[(count - 1) / 2]
        expect(center.lower).toBe(-width / 2)
        expect(center.upper).toBe(width / 2)
        for (const range of ranges.slice(1, -1)) {
          expect(range.upper! - range.lower!).toBeCloseTo(width, 11)
        }
        for (let i = 1; i < ranges.length; i++) {
          expect(ranges[i].lower).toBe(ranges[i - 1].upper)
          expect(ranges[i].lower).toBe(-ranges[ranges.length - i - 1].upper!)
        }
      }
    }
    const narrow = createRanges(3, 0.01)
    expect(narrow[1].label).toBe('-0.005% to < +0.005%')
    expect(binForOutcome(narrow, 0.00499)).toBe(narrow[1])
    expect(binForOutcome(narrow, 0.005)).toBe(narrow[2])
    for (const width of [0, -1, 0.001, 0.009, 0.011, 1.001, 100.01, Infinity, NaN]) {
      expect(() => validateRangeWidth(width)).toThrow('Range width')
      expect(() => createRanges(21, width)).toThrow('Range width')
    }
  })

  it('retains all tail mass and conserves counts across broad curves and entry sizes', () => {
    for (const rangeCount of [3, 21, MAX_RANGE_COUNT]) {
      const ranges = createRanges(rangeCount)
      for (const [mean, sigma] of [[0, 1], [90, 50], [-100, 0.001], [1000, 20]]) {
        for (const count of [1, 7, 101, MAX_POSITIONS]) {
          const allocation = allocatePositions(coefficientsFromMoments(mean, sigma), ranges, count)
          expect(allocation.probabilities.reduce((sum, p) => sum + p, 0)).toBeCloseTo(1, 14)
          expect(allocation.quantities.reduce((sum, quantity) => sum + quantity, 0)).toBe(count)
          expect(allocation.quantities.every(Number.isInteger)).toBe(true)
          expect(allocation.quantities.every(quantity => quantity >= 0)).toBe(true)
          expect(allocation.totalVariationError).toBeLessThanOrEqual(Math.min(1, rangeCount / (2 * count)) + 1e-12)
          allocation.probabilities.forEach((p, index) => {
            expect(p).toBeGreaterThanOrEqual(0)
            expect(Math.abs(p - allocation.actualProbabilities[index])).toBeLessThanOrEqual(1 / count + 1e-12)
          })
        }
      }
    }
  })

  it('uses stable tier-ID ties and shows the actual rounding error', () => {
    const ranges = [
      { tierId: 9, lower: null, upper: 0, label: 'Below zero' },
      { tierId: 3, lower: 0, upper: null, label: 'Zero and above' },
    ]
    const allocation = allocatePositions(coefficientsFromMoments(0, 1), ranges, 1)
    expect(allocation.probabilities).toEqual([0.5, 0.5])
    expect(allocation.tierIds).toEqual([9, 3])
    expect(allocation.quantities).toEqual([0, 1])
    expect(allocation.actualProbabilities).toEqual([0, 1])
    expect(allocation.totalVariationError).toBe(0.5)
  })

  it('rejects invalid allocation sizes and malformed range coverage', () => {
    const a = coefficientsFromMoments(0, 1)
    const ranges = createRanges()
    for (const count of [0, -1, 0.5, Infinity, MAX_POSITIONS + 1]) {
      expect(() => allocatePositions(a, ranges, count)).toThrow()
    }
    expect(() => allocatePositions(a, ranges.slice(1), 10)).toThrow('both tails')
    expect(() => allocatePositions(a, [{ ...ranges[0], upper: null }, ...ranges.slice(1)], 10)).toThrow('contiguous')
    expect(() => allocatePositions(a, [ranges[0], { ...ranges[1], lower: 50 }, ...ranges.slice(2)], 10)).toThrow('contiguous')
    expect(() => allocatePositions(a, [ranges[0], { ...ranges[1], tierId: 1 }, ...ranges.slice(2)], 10)).toThrow('unique')
  })

  it('preserves exact manual counts and keeps source probabilities separate from position shares', () => {
    const ranges = createRanges(3)
    const a = coefficientsFromMoments(0, 1)
    const quantities = [7, 0, 3]
    const allocation = allocateManualPositions(a, ranges, quantities)
    expect(allocation).toMatchObject({ mode: 'manual', tierIds: [1, 2, 3], quantities, count: 10, actualProbabilities: [.7, 0, .3] })
    const curve = allocatePositions(a, ranges, 10)
    expect(curve.mode).toBe('curve')
    expect(allocation.probabilities).toEqual(curve.probabilities)
    expect(allocation.quantities).not.toEqual(curve.quantities)
    expect(allocation.totalVariationError).toBeCloseTo(allocation.probabilities[1], 14)
    quantities[0] = 0
    expect(allocation.quantities).toEqual([7, 0, 3])
    const maximum = allocateManualPositions(a, createRanges(MAX_RANGE_COUNT), [MAX_POSITIONS, ...Array<number>(MAX_RANGE_COUNT - 1).fill(0)])
    expect(maximum.actualProbabilities[0]).toBe(1)
    expect(maximum.count).toBe(MAX_POSITIONS)
  })

  it('rejects malformed manual counts and retains shared range validation', () => {
    const ranges = createRanges(3)
    const a = coefficientsFromMoments(0, 1)
    for (const quantities of [
      null, {}, '1,2,3', [], [1, 2], [1, 2, 3, 4], new Array<number>(3),
      ['1', 0, 0], [null, 0, 1], [NaN, 0, 1], [Infinity, 0, 1], [-1, 0, 2],
      [.5, 0, 1], [0, 0, 0], [MAX_POSITIONS, 0, 1], [Number.MAX_SAFE_INTEGER + 1, 0, 0],
    ]) expect(() => allocateManualPositions(a, ranges, quantities as number[])).toThrow()
    expect(() => allocateManualPositions(a, [ranges[0], { ...ranges[1], lower: 0 }, ranges[2]], [1, 2, 3])).toThrow('contiguous')
  })

  it('gives finite position bars their real density and retains both overflow shares', () => {
    const ranges = createRanges(5, 2)
    const densities = positionDensities(ranges, [1, 2, 3, 4, 5])
    const finite = densities.slice(1, -1)
    const finiteArea = finite.reduce((sum, bar) => sum + bar.density! * (bar.range.upper! - bar.range.lower!), 0)
    expect(finiteArea).toBeCloseTo(9 / 15, 14)
    expect(densities[0]).toMatchObject({ range: ranges[0], quantity: 1, share: 1 / 15, density: null })
    expect(densities[4]).toMatchObject({ range: ranges[4], quantity: 5, share: 5 / 15, density: null })
    expect(finite[1]).toMatchObject({ quantity: 3, share: 3 / 15, density: 3 / 15 / 2 })
    expect(finiteArea + densities[0].share + densities[4].share).toBeCloseTo(1, 14)
    const tailsOnly = positionDensities(ranges, [7, 0, 0, 0, 3])
    expect(tailsOnly.slice(1, -1).every(bar => bar.density === 0)).toBe(true)
    expect(tailsOnly[0].share + tailsOnly[4].share).toBe(1)
  })

  it('can display zero or over-budget whole counts without changing mint validity', () => {
    const ranges = createRanges(3)
    const empty = positionDensities(ranges, [0, 0, 0])
    expect(empty.map(bar => bar.share)).toEqual([0, 0, 0])
    expect(empty.map(bar => bar.density)).toEqual([null, 0, null])
    const excess = [0, MAX_POSITIONS + 1, 0]
    expect(positionDensities(ranges, excess)[1]).toMatchObject({ share: 1, density: 1 })
    expect(() => allocateManualPositions(coefficientsFromMoments(0, 1), ranges, excess)).toThrow('positions')
    const large = positionDensities(ranges, Array<number>(3).fill(Number.MAX_SAFE_INTEGER))
    for (const bar of large) expect(bar.share).toBeCloseTo(1 / 3, 15)
    expect(large.reduce((sum, bar) => sum + bar.share, 0)).toBeCloseTo(1, 15)
    for (const quantities of [[], [0, 0], new Array<number>(3), [-1, 0, 2], [.5, 0, 1], [NaN, 0, 1], [Infinity, 0, 1], [Number.MAX_SAFE_INTEGER + 1, 0, 0]]) {
      expect(() => positionDensities(ranges, quantities)).toThrow('whole position count')
    }
    expect(() => positionDensities([ranges[0], { ...ranges[1], lower: 0 }, ranges[2]], [1, 2, 3])).toThrow('contiguous')
  })
})

describe('Immutable market definitions', () => {
  it('validates and canonicalizes an optional default delegate in immutable metadata', () => {
    const address = '0x52908400098527886E0F7030069857D2E4169EE7'
    const market = validateMarket({ ...definition, defaultAttestationDelegate: address.toLowerCase() })
    expect(market.defaultAttestationDelegate).toBe(address)
    expect(decodeMarketDefinition(encodeMarketDefinition(market))).toEqual(market)
    for (const empty of [undefined, '', ' ', '0x0000000000000000000000000000000000000000']) {
      expect(parseDefaultDelegate(empty)).toBeUndefined()
      expect(validateMarket({ ...definition, defaultAttestationDelegate: empty })).not.toHaveProperty('defaultAttestationDelegate')
    }
    for (const invalid of [null, 1, 'jango.eth', '0x1234', '0x52908400098527886e0F7030069857D2E4169EE7']) {
      expect(() => validateMarket({ ...definition, defaultAttestationDelegate: invalid })).toThrow()
    }
  })
  it('round-trips explicit cutoffs without introducing a uniform range configuration', () => {
    const boundaries = [-10, -0.0003, 0, 0.5, 2.75]
    const market = validateMarket({ ...definition, rangeCount: undefined, rangeWidth: undefined, rangeBoundaries: boundaries })
    expect(Object.hasOwn(market, 'rangeCount')).toBe(false)
    expect(Object.hasOwn(market, 'rangeWidth')).toBe(false)
    expect(market.rangeBoundaries).toEqual(boundaries)
    expect(decodeMarketDefinition(encodeMarketDefinition(market))).toEqual(market)
    expect(marketRanges(market)).toEqual(createCustomRanges(boundaries))
    boundaries[1] = -1
    expect(market.rangeBoundaries?.[1]).toBe(-0.0003)
    for (const mixed of [
      { ...market, rangeCount: 6 }, { ...market, rangeWidth: 1 }, { ...definition, rangeBoundaries: [-1, 1] },
    ]) {
      expect(() => validateMarket(mixed)).toThrow('not both')
      expect(() => marketRanges(mixed as MarketDefinition)).toThrow('not both')
      expect(() => decodeMarketDefinition('data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(mixed)))).toThrow('not both')
    }
    for (const boundaries of [null, [], [-1, -1], [-1, '1'], [-1, 0.00001], [1, -1]]) {
      expect(() => validateMarket({ ...market, rangeBoundaries: boundaries })).toThrow()
    }
  })

  it('round-trips UTF-8 through a data URI and retains scorecard settlement authority', () => {
    const market = { ...definition, prompt: 'BTC, café, 東京: change 📈?', rangeWidth: 2.55 }
    const uri = encodeMarketDefinition(market)
    expect(uri.startsWith('data:application/json;charset=utf-8,')).toBe(true)
    expect(decodeMarketDefinition(uri)).toEqual(market)
    expect(validateMarket(market).settlement).toBe('defifa-scorecard')
    expect(() => validateMarket({ ...market, settlement: 'winning-tier' })).toThrow('settlement')
  })

  it('validates existing markets separately from entry availability', () => {
    expect(validateMarket(definition)).toEqual(definition)
    expect(validateMarket(definition, definition.entryOpensAt + 1)).toEqual(definition)
    expect(() => validateMarket(definition, definition.entryClosesAt)).toThrow('closed')
    expect(() => validateMarket(definition, NaN)).toThrow('Current time')
  })

  it('keeps every accepted date representable by the browser calendar', () => {
    const farFuture = {
      ...definition,
      entryOpensAt: MAX_TIMESTAMP_SECONDS - 172_800,
      entryClosesAt: MAX_TIMESTAMP_SECONDS - 86_400,
      resolvesAt: MAX_TIMESTAMP_SECONDS,
    }
    expect(validateMarket(farFuture)).toEqual(farFuture)
    expect(() => new Date(farFuture.resolvesAt * 1_000).toISOString()).not.toThrow()
    expect(() => new Intl.DateTimeFormat('en', { timeZone: 'UTC' }).format(farFuture.resolvesAt * 1_000)).not.toThrow()
    expect(() => validateMarket({ ...farFuture, resolvesAt: MAX_TIMESTAMP_SECONDS + 1 })).toThrow('calendar range')
  })

  it('rejects ambiguous numeric values, invalid phases and protocol-width overflow', () => {
    for (const value of ['0', '-1', '1.0', '01', '1e18', ' 1', (MAX_UNIT_PRICE_WEI + 1n).toString(), 1]) {
      expect(() => validateMarket({ ...definition, unitPriceWei: value })).toThrow('price')
    }
    expect(validateMarket({ ...definition, unitPriceWei: MAX_UNIT_PRICE_WEI.toString() }).unitPriceWei).toBe(MAX_UNIT_PRICE_WEI.toString())
    for (const patch of [
      { schemaVersion: 2 }, { prompt: ' ' }, { source: '' }, { rangeCount: '21' }, { rangeCount: 20 },
      { rangeWidth: undefined }, { rangeWidth: '1' }, { rangeWidth: 0 }, { rangeWidth: 1.001 },
      { entryOpensAt: 1.5 }, { entryOpensAt: '1800000000' }, { entryClosesAt: definition.entryOpensAt },
      { resolvesAt: definition.entryClosesAt }, { entryOpensAt: definition.entryClosesAt - MAX_ENTRY_DURATION_SECONDS - 1 },
      { resolvesAt: definition.entryClosesAt + MAX_RESOLUTION_DURATION_SECONDS + 1 },
    ]) expect(() => validateMarket({ ...definition, ...patch })).toThrow()
    for (const input of [null, [], '', 0]) expect(() => validateMarket(input)).toThrow()
    for (const uri of ['https://example.com/market', 'data:application/json;charset=utf-8,%ZZ', 'data:application/json;charset=utf-8,[]']) {
      expect(() => decodeMarketDefinition(uri)).toThrow()
    }
  })
})

describe('Explicit range cutoffs', () => {
  it('preserves exact labels, uneven widths, even bin counts and lower-inclusive edge membership', () => {
    const boundaries = [-10, -0.0003, 0, 0.5, 2.75]
    const ranges = createCustomRanges(boundaries)
    expect(ranges.map(range => range.label)).toEqual([
      '< -10%', '-10% to < -0.0003%', '-0.0003% to < 0%', '0% to < +0.5%', '+0.5% to < +2.75%', '≥ +2.75%',
    ])
    expect(ranges.map(range => range.tierId)).toEqual([1, 2, 3, 4, 5, 6])
    expect(binForOutcome(ranges, -Number.MAX_VALUE)).toBe(ranges[0])
    expect(binForOutcome(ranges, Number.MAX_VALUE)).toBe(ranges.at(-1))
    for (let index = 0; index < boundaries.length; index++) {
      expect(ranges[index].upper).toBe(boundaries[index])
      expect(ranges[index + 1].lower).toBe(boundaries[index])
      expect(binForOutcome(ranges, boundaries[index])).toBe(ranges[index + 1])
    }
    const allocation = allocatePositions([0, 1, 0, 0, 0, 0], ranges, 100)
    expect(allocation.quantities.reduce((sum, value) => sum + value, 0)).toBe(100)
    const densities = positionDensities(ranges, allocation.quantities)
    for (let index = 1; index < ranges.length - 1; index++) {
      expect(densities[index].density! * (ranges[index].upper! - ranges[index].lower!)).toBeCloseTo(allocation.actualProbabilities[index], 14)
    }
  })

  it('validates count, strict order, decimal precision and safely representable spans', () => {
    expect(createCustomRanges([-MAX_RANGE_BOUNDARY, MAX_RANGE_BOUNDARY])).toHaveLength(3)
    expect(createCustomRanges(Array.from({ length: 60 }, (_, index) => index / 10))).toHaveLength(61)
    expect(createCustomRanges([-0, 0.0003])[0].upper).toBe(0)
    for (const boundaries of [
      [], [0], Array.from({ length: 61 }, (_, index) => index), [0, 0], [1, -1], [-0, 0],
      [-1, NaN], [-1, Infinity], [-Infinity, 1], [-1, 0.00001], [-1, 0.30000000000000004],
      [-MAX_RANGE_BOUNDARY - 1, 1], [-1, MAX_RANGE_BOUNDARY + 1], [-1e308, 1e308], Array(2),
    ]) expect(() => createCustomRanges(boundaries)).toThrow()
  })

  it('retains incomplete text as invalid and accepts complete signed decimal cutoffs', () => {
    expect(parseRangeBoundaries([' -10 ', '-.0003', '-0', '+0.5', '2.7500'])).toEqual([-10, -0.0003, 0, 0.5, 2.75])
    for (const incomplete of ['', ' ', '-', '+', '.', '-.', '1.', '1e', '1e2', '0x10', 'Infinity', 'NaN', '1,2', '0.00001']) {
      expect(() => parseRangeBoundaries(['-10', incomplete])).toThrow('complete percentage')
    }
    expect(() => parseRangeBoundaries(['0', '0.0000'])).toThrow('increasing')
    expect(() => parseRangeBoundaries(['0'])).toThrow('cutoffs')
  })
})


describe('Range editor redistribution', () => {
  it('preserves deliberate boundaries and endpoints while filling untouched spans', () => {
    const original = [-9.5, -8.5, -7.5, -6.5, -5.5, -4.5]
    const edited = redistributeRangeBoundaries(original, 1, -6.5, [])
    expect(edited).toEqual([-9.5, -6.5, -6, -5.5, -5, -4.5])
    expect(original).toEqual([-9.5, -8.5, -7.5, -6.5, -5.5, -4.5])
    expect(redistributeRangeBoundaries(edited, 3, -5.9, [1])).toEqual([-9.5, -6.5, -6.2, -5.9, -5.2, -4.5])
    expect(redistributeRangeBoundaries(edited, 0, -10.5, [1])).toEqual([-10.5, -6.5, -6, -5.5, -5, -4.5])
    expect(redistributeRangeBoundaries(edited, 5, -3.5, [1])).toEqual([-9.5, -6.5, -5.75, -5, -4.25, -3.5])
  })

  it('rejects crossing deliberate anchors and insufficient precision without altering the layout', () => {
    const current = [-3, -2, -1, 0, 1, 2, 3]
    expect(() => redistributeRangeBoundaries(current, 1, 0, [3])).toThrow('Boundary 2 must be less than Boundary 4')
    expect(() => redistributeRangeBoundaries(current, 5, -3, [3])).toThrow('Boundary 4 must be less than Boundary 6')
    expect(() => redistributeRangeBoundaries(current, 1, 2.9999, [])).toThrow('need at least 0.0005')
    for (const index of [-1, 7, 1.5]) expect(() => redistributeRangeBoundaries(current, index, 0, [])).toThrow('existing boundary')
    expect(() => redistributeRangeBoundaries(current, 1, -2, [7])).toThrow('existing boundary')
    expect(() => redistributeRangeBoundaries(current, 1, -2.00001, [])).toThrow('decimal places')
    expect(current).toEqual([-3, -2, -1, 0, 1, 2, 3])
  })

  it('uses representable four-decimal cutoffs even for indivisible and maximal spans', () => {
    expect(redistributeRangeBoundaries([0, 1, 2, 3], 3, 0.001, [])).toEqual([0, 0.0003, 0.0007, 0.001])
    const result = redistributeRangeBoundaries([-MAX_RANGE_BOUNDARY, -1, 1, MAX_RANGE_BOUNDARY], 1, -MAX_RANGE_BOUNDARY + 1, [])
    expect(createCustomRanges(result)).toHaveLength(5)
    expect(result[0]).toBe(-MAX_RANGE_BOUNDARY)
    expect(result[1]).toBe(-MAX_RANGE_BOUNDARY + 1)
    expect(result[3]).toBe(MAX_RANGE_BOUNDARY)
  })

  it('locates incomplete text and both sides of duplicate or reversed pairs', () => {
    expect(parseRangeBoundary(' -.0003 ', 4)).toBe(-0.0003)
    expect(rangeBoundaryIssues(['-3', '-2', '-1', '0'])).toEqual({})
    const issues = rangeBoundaryIssues(['-3', '-1', '-2', '', '2'])
    expect(Object.keys(issues)).toEqual(['1', '2', '3'])
    expect(issues[1]).toContain('Boundary 2 must be less than Boundary 3')
    expect(issues[2]).toBe(issues[1])
    expect(issues[3]).toContain('complete percentage for Boundary 4')
    expect(Object.keys(rangeBoundaryIssues(['0', '-0']))).toEqual(['0', '1'])
    expect(rangeBoundaryIssues(['0', String(MAX_RANGE_BOUNDARY + 1)])[1]).toContain('finite percentage')
  })
})

describe('position caps', () => {
  it('bounds an entry at the stake-typo cap', async () => {
    const { allocatePositions, MAX_POSITIONS } = await import('../src/domain/allocation')
    const { marketRanges } = await import('../src/domain/market')
    const { EXAMPLE_MARKET } = await import('../src/lib/example')
    const ranges = marketRanges(EXAMPLE_MARKET)
    expect(() => allocatePositions([0, 1, 0, 0, 0, 0], ranges, MAX_POSITIONS + 1)).toThrow(`1 to ${MAX_POSITIONS}`)
    expect(allocatePositions([0, 1, 0, 0, 0, 0], ranges, MAX_POSITIONS).count).toBe(MAX_POSITIONS)
  })
})
