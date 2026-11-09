import { describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, getAddress, type Address, type Hex } from 'viem'
import { createHookMetadata, hookMetadataId } from '@bananapus/nana-sdk-core'
import { marketRanges, type MarketDefinition } from '../src/domain/market'
import type { MarketSnapshot } from '../src/lib/defifa'
import { readActivity } from '../src/lib/activity'

const mocks = vi.hoisted(() => ({ bendystraw: vi.fn() }))
vi.mock('../src/lib/bendystraw', () => ({ bendystraw: mocks.bendystraw }))

const alice = getAddress('0x0000000000000000000000000000000000000123')
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex
const definition: MarketDefinition = { schemaVersion: 1, settlement: 'defifa-scorecard', prompt: 'BTC?', source: 'S', resolutionRule: 'R',
  entryOpensAt: 100, entryClosesAt: 1_000, resolvesAt: 2_000, rangeCount: 3, rangeWidth: 1, unitPriceWei: '1000' }
const market = { chainId: 8453, projectId: '27', definition, ranges: marketRanges(definition) } as MarketSnapshot
const cashOut = (ids: bigint[], amounts: bigint[]) => createHookMetadata([hookMetadataId(alice as Address, 'cashOut')],
  [encodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], [ids, amounts])])
const page = (mints: unknown[], exits: unknown[], more = [false, false]) => ({
  defifaEvents: { items: mints, pageInfo: { hasNextPage: more[0] } }, cashOutTokensEvents: { items: exits, pageInfo: { hasNextPage: more[1] } },
})

describe('readActivity', () => {
  it('groups mints per transaction, reads burns from cash-out metadata and merges newest first', async () => {
    mocks.bendystraw.mockResolvedValueOnce(page([
      { txHash: hash(1), timestamp: 500, account: alice.toLowerCase(), tierId: 2, count: 2 },
      { txHash: hash(1), timestamp: 500, account: alice.toLowerCase(), tierId: 3, count: 1 },
    ], [{ txHash: hash(3), timestamp: 900, holder: alice.toLowerCase(), metadata: cashOut([3n], [1n]) }]))
    const result = await readActivity(market)
    expect(result.events.map(event => [event.kind, event.account, event.quantities])).toEqual([
      ['exit', alice, [0, 0, 1]],
      ['entry', alice, [0, 2, 1]],
    ])
    expect(result).toMatchObject({ complete: true, nextCursor: null })
    expect(mocks.bendystraw).toHaveBeenCalledWith(8453, expect.any(String), { chainId: 8453, projectId: 27, before: 2 ** 31 - 1 })
  })

  it('ends a page at the oldest row of a list that continues, so the lists never skip each other', async () => {
    mocks.bendystraw.mockResolvedValueOnce(page(
      [{ txHash: hash(1), timestamp: 800, account: alice, tierId: 1, count: 1 }, { txHash: hash(2), timestamp: 700, account: alice, tierId: 1, count: 1 }],
      [{ txHash: hash(3), timestamp: 600, holder: alice, metadata: cashOut([1n], [1n]) }],
      [true, false],
    ))
    const result = await readActivity(market, 1_000)
    expect(result.events.map(event => event.timestamp)).toEqual([800, 700])
    expect(result).toMatchObject({ complete: false, nextCursor: '700' })
    expect(mocks.bendystraw).toHaveBeenLastCalledWith(8453, expect.any(String), expect.objectContaining({ before: 1_000 }))
  })
})
