import { keccak256, stringToHex, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { createWriteHold, RECEIPT_RETRY_MS, ReviewLineError, writeIntentKey, type ReviewedAction, type ReviewedResult } from '@bananapus/nana-sdk-core/review'
import { REVIEWED_RUN_BUSY_LINE, type ReviewedRunFailed, type ReviewedRunReceipt } from '@bananapus/nana-sdk-core/review/react'
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

/**
 * One handoff at a time to the app's one runner, claimed synchronously in `open`: a form whose write would replace
 * another form's open review is refused with the SDK's busy line, so neither is left waiting.
 */
export async function exclusive<T>(open: { current: boolean }, run: () => Promise<T>): Promise<T> {
  if (open.current) throw new ReviewLineError(REVIEWED_RUN_BUSY_LINE)
  open.current = true
  try { return await run() } finally { open.current = false }
}

/** How `useReviewedRun` ends a run. */
export type RunEnd = ReviewedResult | ReviewedRunReceipt | ReviewedRunFailed | null

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

/**
 * What a run means for its form: the mined receipt, or null when nothing mined yet. A write still confirming is handed
 * back at once (its hold refuses the same intent until it settles); its later receipt applies then and goes to `later`. A mined write
 * is the outcome, as the hold settled it from the exact call's receipt (no app effect check, as in jbm and revnet);
 * `apply` runs its effects, and a failed receipt read is reported, never thrown, so the form never offers to send it again.
 */
export async function runOutcome(ran: RunEnd, client: Pick<PublicClient, 'getTransactionReceipt'>,
  apply: (receipt: TransactionReceipt) => Promise<void>, report: (line: string) => void,
  /** The submitting form's completion, for a receipt that arrives after the write was handed back. */
  later?: (receipt: TransactionReceipt) => void | Promise<void>): Promise<TransactionReceipt | null> {
  if (ran?.status === 'receipt') {
    void ran.ended().then(done => runOutcome(done, client, apply, report))
      .then(receipt => receipt && later?.(receipt), cause => report(uncheckedLine(cause)))
    return null
  }
  const done = ran
  if (done?.status !== 'done') return null
  let receipt: TransactionReceipt
  try { receipt = done.receipts.at(-1) ?? await client.getTransactionReceipt({ hash: done.hashes.at(-1)! }) }
  catch (cause) { report(uncheckedLine(cause)); return null }
  await apply(receipt)
  return receipt
}
