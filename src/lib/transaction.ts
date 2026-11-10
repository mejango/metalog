import { keccak256, stringToHex, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { createWriteHold, RECEIPT_RETRY_MS, writeIntentKey, type ReviewedAction } from '@bananapus/nana-sdk-core/review'
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

/** The line for a mined write whose receipt could not be read here: the write still went through. */
const uncheckedLine = (cause: unknown) =>
  `Transaction confirmed. Its receipt could not be read here: ${cause instanceof Error ? cause.message : 'the read failed.'}`

/**
 * A settled write's receipt, read again every few seconds until it reads: a settlement is never dropped for a failed
 * read. Each failure is reported, and a read that succeeds clears the report.
 */
export async function settledReceipt(client: Pick<PublicClient, 'getTransactionReceipt'>, hash: Hex, report: (line: string) => void,
  retryMs = RECEIPT_RETRY_MS): Promise<TransactionReceipt> {
  for (;;) {
    try {
      const receipt = await client.getTransactionReceipt({ hash })
      report('')
      return receipt
    } catch (cause) {
      report(uncheckedLine(cause))
      await new Promise(resolve => setTimeout(resolve, retryMs))
    }
  }
}
