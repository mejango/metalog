import { keccak256, stringToHex, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import {
  createWriteHold, followHeldWrite, RECEIPT_RETRY_MS, ReviewLineError, TransactionReviewCancelledError, writeIntentKey,
  type ReviewedAction, type ReviewedResult, type WriteHoldClient, type WriteHoldHandle, type WriteHoldSettled, type WriteHoldState,
} from '@bananapus/nana-sdk-core/review'
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
 * How a handed-back write's own reservation settled, taken when the hold settles it (its event, or this follow's own
 * read), before anything acknowledges it or another reservation replaces it: the hash of a success, else null (a
 * failure, a release, or `signal` aborted). `onSuccess` hears a success at that moment.
 */
export async function heldSuccess(handle: WriteHoldHandle, client: WriteHoldClient,
  options: { signal: AbortSignal; pollMs?: number; onSuccess?: () => void }): Promise<Hex | null> {
  const reservation = handle.peek().reservation
  if (!reservation) return null
  const stop = new AbortController()
  let settled: WriteHoldSettled | undefined
  const take = (state: WriteHoldState | null) => {
    if (settled || state?.status !== 'clear' || state.reservation !== reservation || !state.settled) return
    settled = state.settled
    if (settled.result === 'success') options.onSuccess?.()
    stop.abort()
  }
  const unsubscribe = handle.subscribe(take)
  try { take(await followHeldWrite(handle, client, { signal: AbortSignal.any([options.signal, stop.signal]), pollMs: options.pollMs })) }
  finally { unsubscribe() }
  const success = settled as WriteHoldSettled | undefined // set by `take`, which TypeScript's narrowing can't see
  if (!success || !('hash' in success) || success.result !== 'success') return null
  // Its form completes with it, so it is shown, as the run would have acknowledged it. If that write fails, the hold
  // keeps offering "Send it again" for the user to answer, as the SDK shows any success seen while away.
  await handle.acknowledge(success).catch(() => null)
  return success.hash
}

/**
 * The form a run came from: told when its write was sent, completed when a handed-back write settles (`complete`, at once)
 * and its receipt arrives (`later`). A send it began before that completion is `stale`.
 */
export type SubmittingForm = {
  sent: () => void
  complete: () => void
  stale: () => boolean
  later: (receipt: TransactionReceipt) => void | Promise<void>
}

/**
 * What a run means for its form: the mined receipt, or null when nothing mined yet. A write still confirming is handed
 * back at once (its hold refuses the same intent until it settles). `follow` waits on that write's own reservation, not
 * on the replaceable run, so a refused retry keeps it: once it settles its receipt applies and completes `form`. A mined
 * write is the outcome, as the hold settled it from the exact call's receipt (no app effect check, as in jbm and revnet);
 * `apply` runs its effects, and a failed receipt read is reported, never thrown, so the form never offers to send it again.
 */
export async function runOutcome(ran: RunEnd, client: Pick<PublicClient, 'getTransactionReceipt'>,
  apply: (receipt: TransactionReceipt) => Promise<void>, report: (line: string) => void,
  form?: SubmittingForm, follow?: (onSuccess: () => void) => Promise<Hex | null>): Promise<TransactionReceipt | null> {
  if (ran?.status === 'receipt' || ran?.status === 'done') form?.sent()
  if (ran?.status === 'receipt') {
    void follow?.(() => form?.complete()).then(async hash => {
      if (!hash) return
      const receipt = await settledReceipt(client, hash, report)
      // Its form completes even when this tab's effects fail to apply: the write already succeeded.
      await apply(receipt).catch(cause => report(uncheckedLine(cause)))
      await form?.later(receipt)
    }).catch(cause => report(uncheckedLine(cause)))
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

/**
 * The form side of usePreparedWrite, outside React: prepare a write, hand it to `send`, then apply its confirmed receipt.
 * `succeeded` closes the form's draft the moment its write succeeds, before its receipt is read and `settle` applies it.
 * One run at a time: `running` lasts until the receipt's effects are applied or the write is handed back still
 * confirming, `preparing` ends at the hand-off. A handed-back write completes the form when it mines, unless the form has
 * started another since.
 */
export function formRuns(show: { preparing: (on: boolean) => void; running: (on: boolean) => void; error: (line: string) => void }) {
  let active = false
  /** Operations started, and the latest whose write was sent: a refused or cancelled retry leaves the earlier one current. */
  let started = 0
  let sent = 0
  /** Handed-back writes that completed the form: a send begun before one is dropped. */
  let completed = 0
  /** A handed-back write succeeded and its receipt is still being read: the form starts nothing until it completes. */
  let closing = false
  return async <T,>(prepare: () => Promise<T>, send: (prepared: T, form: SubmittingForm) => Promise<TransactionReceipt | null>,
    settle: (receipt: TransactionReceipt) => void | Promise<void>, fallback: string, succeeded?: () => void) => {
    if (active || closing) return
    active = true
    const id = ++started
    const generation = completed
    // A receipt that arrives after hand-back completes this operation, unless the form has sent a newer write since.
    const form: SubmittingForm = {
      sent: () => { sent = id },
      // At the success itself, before any receipt read: the draft that sent it is closed and never sendable again.
      complete: () => {
        if (sent !== id) return
        completed += 1
        closing = true
        show.running(true)
        succeeded?.()
      },
      stale: () => completed !== generation,
      later: async receipt => {
        if (sent !== id) return
        try { await settle(receipt) } catch (cause) { if (sent === id) show.error(cause instanceof Error ? cause.message : fallback) }
        finally { closing = false; show.running(false) }
      },
    }
    show.error('')
    show.preparing(true)
    show.running(true)
    try {
      const prepared = await prepare()
      show.preparing(false)
      if (form.stale()) return
      const receipt = await send(prepared, form)
      if (!receipt) return
      succeeded?.()
      await settle(receipt)
    } catch (cause) { show.error(cause instanceof Error ? cause.message : fallback) }
    finally { active = false; show.preparing(false); show.running(false) }
  }
}

/** The last gate before the wallet: a form whose earlier write completed meanwhile sends nothing. */
export function refuseStale(form?: SubmittingForm) {
  if (form?.stale()) throw new TransactionReviewCancelledError()
}
