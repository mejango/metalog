import { decodeAbiParameters, getAddress, type Address, type Hex } from 'viem'
import type { MarketSnapshot } from './defifa'
import { bendystraw } from './bendystraw'

export type ActivityEvent = {
  kind: 'entry' | 'exit'
  transactionHash: Hex
  timestamp: number
  account: Address
  /** positions minted (entry) or burned (exit) per range, in market range order. */
  quantities: number[]
}
export type ActivityPage = {
  schema: 'metalog.activity.v2'
  events: ActivityEvent[]
  complete: boolean
  nextCursor: string | null
}
const PAGE = 100
const QUERY = `query Activity($chainId: Int!, $projectId: Int!, $before: Int!) {
  defifaEvents(where: { chainId: $chainId, projectId: $projectId, type: minted, timestamp_lt: $before },
    orderBy: "timestamp", orderDirection: "desc", limit: ${PAGE}) {
    items { txHash timestamp account tierId count } pageInfo { hasNextPage } }
  cashOutTokensEvents(where: { chainId: $chainId, projectId: $projectId, version: 6, timestamp_lt: $before },
    orderBy: "timestamp", orderDirection: "desc", limit: ${PAGE}) {
    items { txHash timestamp holder metadata } pageInfo { hasNextPage } } }`

type Mint = { txHash: Hex; timestamp: number; account: string; tierId: number; count: number }
type CashOut = { txHash: Hex; timestamp: number; holder: string; metadata: Hex }
type Result = { defifaEvents: { items: Mint[]; pageInfo: { hasNextPage: boolean } }; cashOutTokensEvents: { items: CashOut[]; pageInfo: { hasNextPage: boolean } } }

/** Burned positions per range from cash-out metadata: (uint256[] ids, uint256[] amounts) after the lookup table. */
function burned(market: MarketSnapshot, metadata: Hex): number[] {
  try {
    const [ids, amounts] = decodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], `0x${metadata.slice(130)}`)
    return market.ranges.map(range => ids.reduce((sum, id, index) => id === BigInt(range.tierId) ? sum + Number(amounts[index]) : sum, 0))
  } catch { return market.ranges.map(() => 0) }
}

/**
 * Entries and exits from Bendystraw, newest first. Display only: no stake, curve or payout is attributed,
 * and an entry's curve is verified from its receipt when opened. Cursor is a unix timestamp.
 */
export async function readActivity(market: MarketSnapshot, cursor?: number): Promise<ActivityPage> {
  const data = await bendystraw<Result>(market.chainId, QUERY,
    { chainId: market.chainId, projectId: Number(market.projectId), before: cursor ?? 2 ** 31 - 1 })
  const mints = data.defifaEvents, exits = data.cashOutTokensEvents
  // A full list may continue past its oldest row, so the page ends there for both lists.
  // ponytail: rows sharing that boundary second beyond the 100-row limit are skipped; a few per second is the ceiling.
  const boundary = Math.max(...[mints, exits].filter(list => list.pageInfo.hasNextPage).map(list => list.items.at(-1)!.timestamp), 0)
  const events = new Map<string, ActivityEvent>()
  for (const mint of mints.items) {
    if (mint.timestamp < boundary) continue
    const event = events.get(`${mint.txHash}:entry`) ?? { kind: 'entry', transactionHash: mint.txHash, timestamp: mint.timestamp,
      account: getAddress(mint.account), quantities: market.ranges.map(() => 0) }
    const index = market.ranges.findIndex(range => range.tierId === mint.tierId)
    if (index >= 0) event.quantities[index] += mint.count
    events.set(`${mint.txHash}:entry`, event)
  }
  for (const exit of exits.items) {
    if (exit.timestamp < boundary) continue
    events.set(`${exit.txHash}:exit`, { kind: 'exit', transactionHash: exit.txHash, timestamp: exit.timestamp,
      account: getAddress(exit.holder), quantities: burned(market, exit.metadata) })
  }
  const complete = boundary === 0
  return {
    schema: 'metalog.activity.v2', complete, nextCursor: complete ? null : String(boundary),
    events: [...events.values()].sort((a, b) => b.timestamp - a.timestamp),
  }
}
