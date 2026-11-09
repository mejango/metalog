import { describe, expect, it } from 'vitest'
import { forecastPreview, positionsForBudget } from '../src/lib/forecast'
import { EXAMPLE_MARKET } from '../src/lib/example'
import { marketData } from '../src/lib/market-data'
import type { MarketSnapshot } from '../src/lib/defifa'
import { POST } from '../src/app/api/preview/route'

describe('forecast data and payment boundary', () => {
  it('pays for integer positions only and preserves the unspent remainder', () => {
    expect(positionsForBudget('0.0001004', '1000000000000')).toEqual({ count: 100, valueWei: 100000000000000n, remainderWei: 400000000000n })
    for (const value of ['0', '-1', 'Infinity', '1e-3', '0.0000000000000000001', '', '.', '1000000.000001']) {
      expect(() => positionsForBudget(value, '1000000000000')).toThrow()
    }
    expect(positionsForBudget('.0001', '1000000000000').count).toBe(100)
  })
  it('exports original probability and rounded holdings as different datasets', () => {
    const preview = forecastPreview({ market: EXAMPLE_MARKET, coefficients: [0, 1], positions: 3 })
    expect(preview.kind).toBe('draft')
    expect(preview.payment.valueWei).toBe('3000000000000000')
    expect(preview.allocation.quantities.reduce((sum, n) => sum + n, 0)).toBe(3)
    expect(preview.allocation.actualProbabilities).not.toEqual(preview.allocation.probabilities)
    expect(preview.tradingDistribution).toBeNull()
    expect(preview.settlement).toBe('defifa-scorecard')
  })
  it('uses custom equal-width boundaries consistently in exports and the public preview', async () => {
    const payload = { market: { ...EXAMPLE_MARKET, rangeCount: 5, rangeWidth: 2.5 }, coefficients: [0, 1], positions: 20 }
    const preview = forecastPreview(payload)
    expect(preview.market.rangeWidth).toBe(2.5)
    expect(preview.ranges.map(range => [range.lower, range.upper])).toEqual([
      [null, -3.75], [-3.75, -1.25], [-1.25, 1.25], [1.25, 3.75], [3.75, null],
    ])
    const logistic = (x: number) => 1 / (1 + Math.exp(-x))
    expect(preview.allocation.probabilities[2]).toBeCloseTo(logistic(1.25) - logistic(-1.25), 14)
    expect(preview.allocation.count).toBe(20)
    expect(preview.payment.valueWei).toBe('20000000000000000')
    const response = await POST(new Request('http://localhost/api/preview', { method: 'POST', body: JSON.stringify(payload) }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(preview)
    const invalid = await POST(new Request('http://localhost/api/preview', {
      method: 'POST', body: JSON.stringify({ ...payload, market: { ...payload.market, rangeWidth: .001 } }),
    }))
    expect(invalid.status).toBe(400)
  })
  it('allocates and exports uneven custom ranges without changing cutoffs or losing overflow mass', async () => {
    const { rangeCount, rangeWidth, ...definition } = EXAMPLE_MARKET
    const market = { ...definition, rangeBoundaries: [-5, -1, 0, .5, 3] }
    const payload = { market, coefficients: [0, 1], positions: 100 }
    const preview = forecastPreview(payload)
    expect(preview.market).toEqual(market)
    expect(preview.ranges.map(range => [range.tierId, range.lower, range.upper])).toEqual([
      [1, null, -5], [2, -5, -1], [3, -1, 0], [4, 0, .5], [5, .5, 3], [6, 3, null],
    ])
    const cumulative = [0, ...market.rangeBoundaries.map(x => 1 / (1 + Math.exp(-x))), 1]
    preview.allocation.probabilities.forEach((probability, index) => {
      expect(probability).toBeCloseTo(cumulative[index + 1] - cumulative[index], 14)
    })
    expect(preview.allocation.quantities).toEqual([1, 26, 23, 12, 33, 5])
    expect(preview.payment.valueWei).toBe('100000000000000000')

    const manual = { market, coefficients: [0, 1], quantities: [2, 0, 3, 0, 0, 5] }
    expect(forecastPreview(manual).allocation).toMatchObject({
      mode: 'manual', count: 10, tierIds: [1, 2, 3, 4, 5, 6], actualProbabilities: [.2, 0, .3, 0, 0, .5],
    })
    for (const valid of [payload, manual]) {
      const response = await POST(new Request('http://localhost/api/preview', { method: 'POST', body: JSON.stringify(valid) }))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(forecastPreview(valid))
    }
    for (const invalid of [
      { ...payload, market: { ...market, rangeCount } },
      { ...payload, market: { ...market, rangeWidth } },
      { ...payload, market: { ...market, rangeBoundaries: [-5, 0, -1, .5, 3] } },
      { ...manual, quantities: [2, 3, 5] },
    ]) {
      const response = await POST(new Request('http://localhost/api/preview', { method: 'POST', body: JSON.stringify(invalid) }))
      expect(response.status).toBe(400)
    }
  })
  it('derives manual stake from exact exported counts and rejects a conflicting total', async () => {
    const market = { ...EXAMPLE_MARKET, rangeCount: 3 }
    const payload = { market, coefficients: [0, 1], quantities: [7, 0, 3] }
    const preview = forecastPreview(payload)
    expect(preview.allocation).toMatchObject({ mode: 'manual', quantities: [7, 0, 3], actualProbabilities: [.7, 0, .3], count: 10 })
    expect(preview.payment.valueWei).toBe('10000000000000000')
    expect(preview.distribution.coefficients).toEqual([0, 1, 0, 0, 0, 0])
    expect(forecastPreview({ ...payload, positions: 10 })).toEqual(preview)
    expect(() => forecastPreview({ ...payload, positions: 9 })).toThrow('does not match')
    const response = await POST(new Request('http://localhost/api/preview', { method: 'POST', body: JSON.stringify(payload) }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(preview)
    for (const patch of [{ quantities: null }, { quantities: [1.5, 0, 1] }, { quantities: [0, 0, 0] }, { positions: 9 }]) {
      const invalid = await POST(new Request('http://localhost/api/preview', { method: 'POST', body: JSON.stringify({ ...payload, ...patch }) }))
      expect(invalid.status).toBe(400)
    }
  })
  it('uses null for an unobserved distribution and includes snapshot provenance', () => {
    const base = { tiers: [{ supply: '0' }, { supply: '0' }], blockNumber: '7', blockTimestamp: 100 } as MarketSnapshot
    expect(marketData(base).positionDistribution.probabilities).toBeNull()
    const snapshot = marketData({ ...base, tiers: [{ supply: '1' }, { supply: '3' }] as MarketSnapshot['tiers'] })
    expect(snapshot.positionDistribution).toMatchObject({ probabilities: [.25, .75], totalSupply: '4', asOfBlock: '7', asOfTimestamp: 100, historicalEntrySnapshot: false })
    expect(snapshot.tradingDistribution).toBeNull()
  })
  it('offers the same stateless preview to API consumers and rejects malformed/large input', async () => {
    const payload = { market: EXAMPLE_MARKET, coefficients: [0, 1], positions: 100 }
    const response = await POST(new Request('http://localhost/api/preview', { method: 'POST', body: JSON.stringify(payload) }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(forecastPreview(payload))
    for (const body of ['null', '{}', '{', JSON.stringify({ ...payload, positions: 1_000_001 })]) {
      expect((await POST(new Request('http://localhost/api/preview', { method: 'POST', body }))).status).toBe(400)
    }
    expect((await POST(new Request('http://localhost/api/preview', { method: 'POST', body: ' '.repeat(32_769) }))).status).toBe(413)
  })
})
