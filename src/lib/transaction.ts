import { keccak256, stringToHex, type Address, type Hex, type TransactionReceipt } from 'viem'
import { createWriteHold, writeIntentKey, type ReviewedAction } from '@bananapus/nana-sdk-core/review'
import { encodeMarketDefinition, type MarketDefinition } from '@/domain/market'

/** A product adapter owns calldata, current-state checks and its receipt effects. */
export type PreparedTransaction = {
  chainId: number
  account: Address
  to: Address
  data: Hex
  value: bigint
  title: string
  details: readonly { label: string; value: string }[]
  reverify?: () => Promise<void>
  /** The Defifa effects the confirmed receipt must show, read once the write settled. */
  verifyReceipt?: (receipt: TransactionReceipt) => void | Promise<void>
}

/** The app's one write hold: storage, cross-tab locks, recovery and exits live in the SDK. */
export const holds = createWriteHold()

/** Every action on one market shares a hold: one unresolved write there refuses another, other markets proceed. */
export function marketIntent(market: { chainId: number; projectId: string }): string {
  return writeIntentKey('metalog-market', { chainId: market.chainId, projectId: market.projectId })
}

/** A creation is held by its definition: the same market twice is refused, a different one proceeds. */
export function creationIntent(chainId: number, definition: MarketDefinition): string {
  return writeIntentKey('metalog-create', { chainId, definition: keccak256(stringToHex(encodeMarketDefinition(definition))) })
}

/** The reviewed action core sends for a prepared write under its intent. */
export function reviewedAction(prepared: PreparedTransaction, intent: string): ReviewedAction {
  const { chainId, account, to, data, value, title, details, reverify } = prepared
  return {
    account,
    calls: [{ chainId, to, data, value, intent, label: title }],
    title,
    context: details.map(detail => ({ ...detail })),
    ...(reverify ? { reverify: () => reverify() } : {}),
  }
}
