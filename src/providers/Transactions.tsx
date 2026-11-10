'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react'
import Link from 'next/link'
import { useQueryClient } from '@tanstack/react-query'
import { getAccount, getWalletClient, switchChain } from '@wagmi/core'
import { useAccount } from 'wagmi'
import { isHash, type Address, type Hex, type TransactionReceipt, type WalletClient } from 'viem'
import {
  followHeldWrite, openStepHold, registerReviewHandler, REVIEWED_ACCOUNT_CHANGED_LINE, ReviewLineError, viemWalletAdapter,
  type ReviewedRunStatus, type ReviewModel, type WriteHoldClient, type WriteHoldState,
} from '@bananapus/nana-sdk-core/review'
import { HeldWritesNotice, useHeldWrites, useReviewedRun } from '@bananapus/nana-sdk-core/review/react'
import { exclusive, formRuns, heldSuccess, holds, refuseStale, reviewedAction, runOutcome, settledReceipt, type PreparedTransaction, type SubmittingForm } from '@/lib/transaction'
import { chainForId, publicClientForChain, SUPPORTED_CHAINS } from '@/lib/wallet'
import { rememberMarket } from '@/lib/recent-markets'
import { TransactionReview } from '@/components/TransactionReview'
import { wagmiConfig } from './Providers'

type TransactionContextValue = {
  /**
   * Review and send a prepared write under its intent's hold: the mined receipt once its effects apply, else null. A write
   * handed back still confirming completes `form` once its own reservation settles.
   */
  execute: (prepared: PreparedTransaction, intent: string, form?: SubmittingForm) => Promise<TransactionReceipt | null>
  busy: boolean
}
const TransactionContext = createContext<TransactionContextValue | null>(null)

export function useTransactions() {
  const value = useContext(TransactionContext)
  if (!value) throw new Error('Transactions must be inside Providers.')
  return value
}

/**
 * Prepare a write, hand it to the transaction runner, then apply its confirmed receipt. One run at a time: `running` lasts
 * until the receipt's effects are applied or the write is handed back still confirming, `preparing` (the copy) ends at
 * the hand-off. A handed-back write completes the form when it mines, unless the form has started another since.
 */
export function usePreparedWrite() {
  const [preparing, setPreparing] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [run] = useState(() => formRuns({ preparing: setPreparing, running: setRunning, error: setError }))
  return { preparing, running, error, setError, run }
}

export const EXTERNAL_WALLET_LINE = 'Defifa transactions need an external wallet. Signa currently provides sign-in only.'
const connector = () => getAccount(wagmiConfig).connector
const refuseSigna = () => { if (connector()?.id === 'juicebox-center') throw new ReviewLineError(EXTERNAL_WALLET_LINE) }

const deps = {
  adapter: viemWalletAdapter({
    walletClient: () => {
      const { address, chainId, connector } = getAccount(wagmiConfig)
      return getWalletClient(wagmiConfig, { account: address, chainId: chainId as never, connector }) as Promise<WalletClient>
    },
    account: () => getAccount(wagmiConfig).address,
    chainId: () => getAccount(wagmiConfig).chainId,
    isSafe: () => false,
    switchChain: chainId => switchChain(wagmiConfig, { chainId: chainForId(chainId).id }),
    connector: () => connector()?.uid,
  }),
  clientFor: publicClientForChain,
  hold: holds,
  engine: () => import('@bananapus/nana-sdk-core/review'),
  guard: refuseSigna,
}

const STATUS_LINES: Partial<Record<ReviewedRunStatus, string>> = {
  simulating: 'Checking transaction…', signing: 'Confirm in your wallet…', receipt: 'Checking confirmation…', done: 'Transaction confirmed.',
}

export function Transactions({ children }: PropsWithChildren) {
  const queryClient = useQueryClient()
  const { address, connector: connected } = useAccount()
  const runner = useReviewedRun({ ...deps, account: address })
  const [review, setReview] = useState<{ model: ReviewModel; decide: (approved: boolean) => void } | null>(null)
  const [created, setCreated] = useState<string | null>(null)
  const [runChain, setRunChain] = useState<number | null>(null)
  /** A mined write whose receipt or effects could not be checked here. */
  const [unchecked, setUnchecked] = useState('')
  /** A run is reviewing, sending or following its write in place; a write handed back still confirming is not. */
  const [sending, setSending] = useState(false)
  /** A run reviewed for one account or connector sends nothing once either changes. */
  const aborts = useRef(new Set<AbortController>())
  useEffect(() => { for (const abort of aborts.current) abort.abort() }, [address, connected?.uid])

  useEffect(() => registerReviewHandler(prompt => new Promise(resolve => {
    const decide = (approved: boolean) => { setReview(null); resolve(approved ? prompt.confirmation : null) }
    prompt.signal.addEventListener('abort', () => decide(false), { once: true })
    setReview({ model: prompt.model, decide })
  })), [])

  /** What every confirmed write changes here, however it settled: the market's reads, and a created market's place in Recently opened. */
  const settled = useCallback(async (chainId: number, receipt: TransactionReceipt) => {
    void queryClient.invalidateQueries({ queryKey: ['market-play'] })
    void queryClient.invalidateQueries({ queryKey: ['market-activity'] })
    void queryClient.invalidateQueries({ queryKey: ['markets', chainId] })
    const { createdMarketId } = await import('@/lib/defifa')
    let projectId: string
    try { projectId = createdMarketId(receipt) } catch { return } // Only a creation launches a game.
    rememberMarket(chainId, projectId)
    void queryClient.invalidateQueries({ queryKey: ['recent-markets'] })
    setCreated(`/markets/${chainId}/${projectId}`)
  }, [queryClient])

  /** Settlements applied from a hash, by chain and hash: a follow, a hash entry and a view can each report one. */
  const applied = useRef(new Set<string>())
  /** Never rejects: its receipt is read until it reads, and a failure to apply is reported and left for the next report. */
  const settledHash = useCallback(async (chainId: number, hash: Hex) => {
    const key = `${chainId}:${hash.toLowerCase()}`
    if (applied.current.has(key)) return
    applied.current.add(key)
    try { await settled(chainId, await settledReceipt(publicClientForChain(chainId), hash, setUnchecked)) }
    catch (cause) {
      applied.current.delete(key)
      setUnchecked(cause instanceof Error ? cause.message : 'This transaction’s result could not be applied here.')
    }
  }, [settled])

  /** A form's write is in review or sending: another form's handoff is refused, not left behind a replaced review. */
  const handing = useRef(false)
  const execute = useCallback((prepared: PreparedTransaction, intent: string, form?: SubmittingForm) => exclusive(handing, async () => {
    const uid = connector()?.uid
    const abort = new AbortController()
    aborts.current.add(abort)
    setSending(true)
    setCreated(null)
    setUnchecked('')
    setRunChain(prepared.chainId)
    const action = reviewedAction(prepared, intent)
    const client = publicClientForChain(prepared.chainId)
    try {
      const ran = await runner.run({
        ...action,
        signal: abort.signal,
        assertWriteState: () => {
          refuseSigna()
          if (connector()?.uid !== uid) throw new ReviewLineError(REVIEWED_ACCOUNT_CHANGED_LINE)
          refuseStale(form)
        },
      })
      return await runOutcome(ran, client, receipt => settled(prepared.chainId, receipt), setUnchecked, form,
        onSuccess => heldSuccess(openStepHold(holds, prepared.account, false, action.calls[0]), client as unknown as WriteHoldClient,
          { signal: new AbortController().signal, onSuccess }))
    } finally { aborts.current.delete(abort); setSending(false) }
  }), [runner, settled])

  const line = runner.status === 'held' ? runner.held?.line : runner.status === 'failed' ? null : STATUS_LINES[runner.status]
  const hash = runner.hash
  const explorer = hash && runChain ? chainForId(runChain).blockExplorers.default.url : undefined
  return <TransactionContext.Provider value={{ execute, busy: sending }}>
    {children}
    {review && <TransactionReview model={review.model} decide={review.decide} />}
    {address && SUPPORTED_CHAINS.map(chain => <HeldOnChain key={chain.id} chainId={chain.id} account={address} onSettled={settledHash}
      running={runner.busy} shown={runner.held?.state && runner.held.state.status !== 'clear' ? runner.held.state.record.id : undefined} />)}
    {(line || runner.error || created || unchecked) && <aside id="transaction-status" tabIndex={-1} className="transaction-status" aria-label="Transaction status">
      {line && <p role="status">{line}</p>}
      {runner.status === 'failed' && runner.error && <p role="alert">{runner.error}</p>}
      {unchecked && <p role="alert">{unchecked}</p>}
      {hash && explorer && <p><a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">View transaction</a></p>}
      {created && <p><Link href={created}>Open created market</Link></p>}
      {runner.exitAction && <button type="button" onClick={() => void runner.exitAction?.run().then(released => { if (released) runner.reset() })}>{runner.exitAction.label}</button>}
      {runner.sendAgainAction && <button type="button" onClick={() => void runner.sendAgainAction?.run()}>{runner.sendAgainAction.label}</button>}
    </aside>}
  </TransactionContext.Provider>
}

/**
 * Every write held for the account on one chain, after a reload or from another tab: the SDK's line and exit for each,
 * one still confirming too, and each followed until it settles, so its effects apply here too. The open run follows and
 * shows its own write.
 */
function HeldOnChain({ chainId, account, onSettled, running, shown }: {
  chainId: number; account: Address; onSettled: (chainId: number, hash: Hex) => Promise<void>; running: boolean; shown?: string
}) {
  const client = publicClientForChain(chainId) as unknown as WriteHoldClient
  const items = useHeldWrites({ hold: holds, chainId, account, client })
  const keys = items.map(item => item.key).join('|')
  useEffect(() => {
    if (!keys || running) return
    const stop = new AbortController()
    for (const { handle } of holds.list({ account, chainId })) {
      void followHeldWrite(handle, client, { signal: stop.signal }).then(end => {
        if (end?.status === 'clear' && end.settled && 'hash' in end.settled && end.settled.result === 'success') void onSettled(chainId, end.settled.hash)
      }, () => undefined)
    }
    return () => stop.abort()
  }, [keys, running, account, chainId, client, onSettled])
  // A write that settled before this list followed it (mined while away): its view still carries the success.
  const successes = items.flatMap(({ view }) => view.settled && 'hash' in view.settled && view.settled.result === 'success' ? [view.settled.hash] : []).join('|')
  useEffect(() => {
    for (const hash of successes ? successes.split('|') as Hex[] : []) void onSettled(chainId, hash)
  }, [successes, chainId, onSettled])
  // As revnet lists them: every state the hold shows; the open run's write is in its own card.
  const listed = items.filter(item => !(item.view.state && item.view.state.status !== 'clear' && item.view.state.record.id === shown))
  // A lost wallet reply, the open run's too: the hold settles it from the hash the wallet shows.
  const noHash = items.filter(item => item.view.state?.status === 'held-no-hash')
  return <>
    <HeldWritesNotice items={listed} className="transaction-status" />
    {noHash.map(item => <AttachHash key={item.key} attach={hash => {
      const handle = holds.list({ account, chainId }).find(entry => entry.key === item.key)?.handle
      if (!handle) throw new Error('This transaction is no longer held.')
      return handle.attachHash(client, hash)
    }} onSettled={hash => onSettled(chainId, hash)} />)}
  </>
}

/** The original hash of a write whose wallet reply was lost, as revnet's recovery attaches one; nothing is sent. */
function AttachHash({ attach, onSettled }: { attach: (hash: Hex) => Promise<WriteHoldState>; onSettled: (hash: Hex) => Promise<void> }) {
  const [hash, setHash] = useState('')
  const [line, setLine] = useState('')
  const [checking, setChecking] = useState(false)
  const check = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!isHash(hash)) { setLine('Enter the complete transaction hash.'); return }
    setChecking(true)
    setLine('')
    try {
      const state = await attach(hash)
      if (state.status !== 'clear') setLine(state.line)
      else if (state.settled && 'hash' in state.settled && state.settled.result === 'success') await onSettled(state.settled.hash)
    } catch (cause) { setLine(cause instanceof Error ? cause.message : 'This transaction could not be checked.') }
    finally { setChecking(false) }
  }
  return <form className="transaction-status" onSubmit={event => void check(event)}>
    <label className="field"><span>Original transaction hash</span><input value={hash} onChange={event => setHash(event.target.value.trim())} autoComplete="off" spellCheck={false} /></label>
    <button type="submit" disabled={checking}>Check transaction</button>
    {line && <p role="alert">{line}</p>}
  </form>
}
