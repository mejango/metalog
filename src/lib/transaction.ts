import { keccak256, stringToHex, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { createWriteHold, writeIntentKey, type ReviewedAction, type ReviewedResult } from '@bananapus/nana-sdk-core/review'
import type { ReviewedRunFailed, ReviewedRunReceipt } from '@bananapus/nana-sdk-core/review/react'
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
  /** The Defifa effects the confirmed receipt must show, read once the write settled; a failure is reported, not a resend. */
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

/** How `useReviewedRun` ends a run. */
export type RunEnd = ReviewedResult | ReviewedRunReceipt | ReviewedRunFailed | null

/** The line for a mined write whose receipt or effects could not be checked here: the write still went through. */
export const uncheckedLine = (cause: unknown) =>
  `Transaction confirmed. Its result could not be checked here: ${cause instanceof Error ? cause.message : 'the check failed.'}`

/**
 * What a run means for its form: the mined receipt, or null when nothing mined yet. A write still confirming is handed
 * back at once (its hold refuses the same intent until it settles) and its later settlement applied then. A mined write
 * is the outcome; `apply` runs its effects, and a failed receipt read or effect check is reported, never thrown, so the
 * form never offers to send it again.
 */
export async function runOutcome(ran: RunEnd, prepared: PreparedTransaction, client: Pick<PublicClient, 'getTransactionReceipt'>,
  apply: (receipt: TransactionReceipt) => Promise<void>, report: (line: string) => void): Promise<TransactionReceipt | null> {
  if (ran?.status === 'receipt') {
    void ran.ended().then(done => runOutcome(done, prepared, client, apply, report)).catch(cause => report(uncheckedLine(cause)))
    return null
  }
  const done = ran
  if (done?.status !== 'done') return null
  let receipt: TransactionReceipt
  try { receipt = done.receipts.at(-1) ?? await client.getTransactionReceipt({ hash: done.hashes.at(-1)! }) }
  catch (cause) { report(uncheckedLine(cause)); return null }
  await apply(receipt)
  await Promise.resolve().then(() => prepared.verifyReceipt?.(receipt)).catch(cause => report(uncheckedLine(cause)))
  return receipt
}
