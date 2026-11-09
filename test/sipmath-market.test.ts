import { beforeEach, describe, expect, it, vi } from 'vitest'
import { marketRanges, validateMarket } from '../src/domain/market'
import { createRanges } from '../src/domain/ranges'
import type { MarketSnapshot } from '../src/lib/defifa'
import { EXAMPLE_MARKET } from '../src/lib/example'
import { marketData } from '../src/lib/market-data'
import * as sipmath from '../src/lib/sipmath'
import { marketSIPmath } from '../src/lib/sipmath-market'
import { GET } from '../src/app/api/markets/[chainId]/[projectId]/route'

const mocks = vi.hoisted(() => ({ readMarket: vi.fn() }))
vi.mock('../src/lib/defifa', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/defifa')>(), readMarket: mocks.readMarket,
}))
const build = vi.spyOn(sipmath, 'buildSIPmath')

function snapshot(): MarketSnapshot {
  const definition = validateMarket({ ...EXAMPLE_MARKET, rangeCount: 3, rangeWidth: 2 })
  const ranges = createRanges(definition.rangeCount, definition.rangeWidth)
  return {
    chainId: 8453, projectId: '7', hook: '0x0000000000000000000000000000000000000123',
    governor: '0x0000000000000000000000000000000000000456', referee: '0x0000000000000000000000000000000000000456', definition, ranges,
    phase: 4, stage: 'complete', blockNumber: '321', blockTimestamp: 1_800_000_000, potWei: '8000000000000',
    tiers: ranges.map((range, index) => ({
      tierId: range.tierId, supply: ['0', '2', '6'][index], entrySupply: ['2', '4', '6'][index],
      priceWei: definition.unitPriceWei, remainingSupply: '999999990',
    })),
    ratifiedScorecardId: '42', cashOutWeightTotal: '1000000000000000000',
    ratifiedWeights: ranges.map((range, index) => ({ tierId: range.tierId, weight: index === 0 ? '1000000000000000000' : '0' })),
    commitmentsFulfilled: true, noContestTriggered: false,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readMarket.mockResolvedValue(snapshot())
})

describe('SIPmath observed market exports', () => {
  it('exports separate circulating/opening tier categories and keeps settlement and overflow evidence in audit', () => {
    const source = snapshot()
    const before = structuredClone(source)
    const result = marketSIPmath(source)
    const input = build.mock.calls.at(-1)![0]
    expect(input.variables).toMatchObject([
      { name: 'circulating_tier', kind: 'discrete', tierIds: [1, 2, 3], counts: [0n, 2n, 6n],
        metadata: { source: 'circulating-supply', weighting: 'stake', unit: 'tier-id', asOfBlock: '321' } },
      { name: 'opening_tier', kind: 'discrete', tierIds: [1, 2, 3], counts: [2n, 4n, 6n],
        metadata: { source: 'entry-close-supply', weighting: 'stake', unit: 'tier-id', asOfBlock: '321', reconstructedFromRedemptions: true } },
    ])
    for (const variable of input.variables) {
      expect(variable.metadata!.ranges).toEqual(source.ranges)
      expect(variable.metadata!.interpretation).toContain('Tier IDs are categories')
    }
    expect(input.audit).toEqual({ native: marketData(source), availability: { circulating: 'available', opening: 'available' } })
    expect(input.source).toEqual({ kind: 'market-snapshot', chainId: source.chainId, projectId: source.projectId, hook: source.hook,
      blockNumber: source.blockNumber, blockTimestamp: source.blockTimestamp, definition: source.definition })
    expect(source.ranges.map(range => [range.lower, range.upper])).toEqual([[null, -1], [-1, 1], [1, null]])
    expect(source).toEqual(before)
    const repeated = marketSIPmath(source)
    expect({ ...repeated, dateCreated: result.dateCreated }).toEqual(result)
    expect(() => JSON.stringify(result)).not.toThrow()
  })

  it('binds observed custom tier categories to exact metadata cutoffs and rejects tampered evidence', async () => {
    const source = snapshot()
    const { rangeCount, rangeWidth, ...definition } = source.definition
    source.definition = { ...definition, rangeBoundaries: [-5, -1, 0, .5, 3] }
    source.ranges = marketRanges(source.definition)
    source.tiers = source.ranges.map(range => ({
      tierId: range.tierId, supply: ['0', '1', '2', '0', '3', '4'][range.tierId - 1],
      entrySupply: ['1', '2', '3', '1', '4', '5'][range.tierId - 1],
      priceWei: source.definition.unitPriceWei, remainingSupply: '999999990',
    }))
    source.ratifiedWeights = source.ranges.map(range => ({ tierId: range.tierId, weight: range.tierId === 2 ? source.cashOutWeightTotal : '0' }))
    const result = marketSIPmath(source)
    expect(result.metadata.source).toMatchObject({ definition: source.definition })
    expect(result.metadata.audit).toEqual({ native: marketData(source), availability: { circulating: 'available', opening: 'available' } })
    expect(source.ranges.map(range => [range.lower, range.upper])).toEqual([
      [null, -5], [-5, -1], [-1, 0], [0, .5], [.5, 3], [3, null],
    ])
    expect(build.mock.calls.at(-1)![0].variables).toMatchObject([
      { name: 'circulating_tier', tierIds: [1, 2, 3, 4, 5, 6], counts: [0n, 1n, 2n, 0n, 3n, 4n] },
      { name: 'opening_tier', tierIds: [1, 2, 3, 4, 5, 6], counts: [1n, 2n, 3n, 1n, 4n, 5n] },
    ])
    expect(result.sips[0].arguments).toEqual({ value: [[.1, 2], [.3, 3], [.6, 5], [1, 6]] })
    for (const sip of result.sips) expect(sip.metadata).toMatchObject({ ranges: source.ranges, unit: 'tier-id' })

    mocks.readMarket.mockResolvedValue(source)
    const context = { params: Promise.resolve({ chainId: '8453', projectId: '7' }) }
    const url = 'http://localhost/api/markets/8453/7'
    const native = await GET(new Request(url), context)
    expect(native.status).toBe(200)
    expect(await native.json()).toEqual(marketData(source))
    const response = await GET(new Request(`${url}?format=sipmath`), context)
    expect(response.status).toBe(200)
    const exported = await response.json()
    expect(exported).toEqual({ ...result, dateCreated: exported.dateCreated })

    const builds = build.mock.calls.length
    for (const mutate of [
      (copy: MarketSnapshot) => { copy.definition = { ...definition, rangeBoundaries: [-5, -1, 0, .75, 3] } },
      (copy: MarketSnapshot) => { copy.ranges[3].upper = .75 },
      (copy: MarketSnapshot) => { copy.ranges[3].label = '0% to < +1%' },
      (copy: MarketSnapshot) => { copy.tiers[5].tierId = 5 },
      (copy: MarketSnapshot) => { Object.assign(copy.definition, { rangeCount, rangeWidth }) },
    ]) {
      const copy = structuredClone(source)
      mutate(copy)
      expect(() => marketSIPmath(copy)).toThrow()
    }
    expect(build).toHaveBeenCalledTimes(builds)
  })

  it('keeps only explicit snapshot identity in seed context even when input carries extra derived fields', () => {
    const raw = snapshot()
    const original = marketSIPmath(raw)
    const augmented = marketSIPmath({ ...raw, derivedProbability: .3333333333333333 } as MarketSnapshot)
    expect(augmented.metadata.source).toEqual(original.metadata.source)
    expect(augmented.metadata.sourceSha256).toBe(original.metadata.sourceSha256)
    expect(augmented.U01).toEqual(original.U01)
    expect(augmented.metadata.auditSha256).not.toBe(original.metadata.auditSha256)
    const later = marketSIPmath({ ...raw, blockNumber: '322' })
    expect(later.metadata.sourceSha256).not.toBe(original.metadata.sourceSha256)
    expect(later.U01).not.toEqual(original.U01)
  })

  it('keeps exact large supplies and never turns missing or empty distributions into random categories', () => {
    const source = snapshot()
    source.tiers[0].supply = '9007199254740993'
    source.tiers.forEach(tier => { tier.entrySupply = null })
    marketSIPmath(source)
    let input = build.mock.calls.at(-1)![0]
    expect(input.variables).toHaveLength(1)
    expect(input.variables[0]).toMatchObject({ kind: 'discrete', counts: [9007199254740993n, 2n, 6n] })
    expect(input.audit).toMatchObject({ availability: { circulating: 'available', opening: 'unavailable' } })
    source.tiers.forEach(tier => { tier.supply = '0' })
    expect(() => marketSIPmath(source)).not.toThrow()
    input = build.mock.calls.at(-1)![0]
    expect(input.variables).toEqual([])
    expect(input.audit).toMatchObject({ availability: { circulating: 'empty', opening: 'unavailable' } })
    source.tiers.forEach(tier => { tier.entrySupply = '0' })
    marketSIPmath(source)
    expect(build.mock.calls.at(-1)![0]).toMatchObject({ variables: [], audit: { availability: { circulating: 'empty', opening: 'empty' } } })
    source.tiers[0].entrySupply = '5'
    source.tiers[1].entrySupply = null
    marketSIPmath(source)
    expect(build.mock.calls.at(-1)![0]).toMatchObject({ variables: [], audit: { availability: { opening: 'unavailable' } } })
  })

  it('rejects invalid supply and range/tier mismatches before building an export', () => {
    for (const value of ['-1', '1.5', '1e3', '', '01']) {
      const source = snapshot()
      source.tiers[0].supply = value
      expect(() => marketSIPmath(source)).toThrow('supply')
      source.tiers[0].supply = '0'
      source.tiers[0].entrySupply = value
      expect(() => marketSIPmath(source)).toThrow('supply')
    }
    for (const mutate of [
      (source: MarketSnapshot) => { source.ranges[0].upper = 0 },
      (source: MarketSnapshot) => { source.tiers[0].tierId = 2 },
      (source: MarketSnapshot) => { source.tiers.pop() },
      (source: MarketSnapshot) => { source.definition.rangeWidth = 3 },
    ]) {
      const source = snapshot()
      mutate(source)
      expect(() => marketSIPmath(source)).toThrow('ranges and tiers')
    }
    expect(build).not.toHaveBeenCalled()
  })

  it('uses the same snapshot adapter in GET and retains native JSON with explicit format errors', async () => {
    const context = { params: Promise.resolve({ chainId: '8453', projectId: '7' }) }
    const url = 'http://localhost/api/markets/8453/7'
    const result = await GET(new Request(`${url}?format=sipmath`), context)
    expect(result.status).toBe(200)
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(result.headers.get('content-disposition')).toBe('attachment; filename="metalog-market.SIPmath"')
    const exported = await result.json()
    expect(exported).toEqual({ ...marketSIPmath(snapshot()), dateCreated: exported.dateCreated })
    expect(mocks.readMarket).toHaveBeenCalledWith(8453, '7')
    for (const query of ['', '?format=json']) {
      const native = await GET(new Request(url + query), context)
      expect(native.status).toBe(200)
      expect(native.headers.get('content-disposition')).toBeNull()
      expect(await native.json()).toEqual(marketData(snapshot()))
    }
    const reads = mocks.readMarket.mock.calls.length
    for (const format of ['', 'csv', 'SIPmath']) {
      const unsupported = await GET(new Request(`${url}?format=${format}`), context)
      expect(unsupported.status).toBe(400)
    }
    expect(mocks.readMarket).toHaveBeenCalledTimes(reads)
    mocks.readMarket.mockRejectedValueOnce(new Error('Snapshot unavailable'))
    const unavailable = await GET(new Request(`${url}?format=sipmath`), context)
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({ error: 'Market data could not be verified. Try again.' })
  })
})
