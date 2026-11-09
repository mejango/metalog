'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react'
import Link from 'next/link'
import { useQueryClient } from '@tanstack/react-query'
import { getAccount, getWalletClient, switchChain } from '@wagmi/core'
import { useAccount } from 'wagmi'
import type { Address, Hex, TransactionReceipt, WalletClient } from 'viem'
import {
  followHeldWrite, registerReviewHandler, REVIEWED_ACCOUNT_CHANGED_LINE, ReviewLineError, viemWalletAdapter,
  type ReviewedRunStatus, type ReviewModel, type WriteHoldClient,
} from '@bananapus/nana-sdk-core/review'
import { HeldWritesNotice, useHeldWrites, useReviewedRun } from '@bananapus/nana-sdk-core/review/react'
import { holds, reviewedAction, type PreparedTransaction } from '@/lib/transaction'
import { chainForId, publicClientForChain, SUPPORTED_CHAINS } from '@/lib/wallet'
import { rememberMarket } from '@/lib/recent-markets'
import { TransactionReview } from '@/components/TransactionReview'
import { wagmiConfig } from './Providers'

type TransactionContextValue = {
  /** Review and send a prepared write under its intent's hold; the confirmed receipt once its effects check, else null. */
  execute: (prepared: PreparedTransaction, intent: string) => Promise<TransactionReceipt | null>
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
 * until the receipt's effects are applied, `preparing` (the copy) ends at the hand-off.
 */
export function usePreparedWrite() {
  const [preparing, setPreparing] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const active = useRef(false)
  const run = useCallback(async <T,>(prepare: () => Promise<T>, send: (prepared: T) => Promise<TransactionReceipt | null>,
    settle: (receipt: TransactionReceipt) => void | Promise<void>, fallback: string) => {
    if (active.current) return
    active.current = true
    setError('')
    setPreparing(true)
    setRunning(true)
    try {
      const prepared = await prepare()
      setPreparing(false)
      const receipt = await send(prepared)
      if (receipt) await settle(receipt)
    } catch (cause) { setError(cause instanceof Error ? cause.message : fallback) }
    finally { active.current = false; setPreparing(false); setRunning(false) }
  }, [])
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

  const settledHash = useCallback(async (chainId: number, hash: Hex) => {
    await settled(chainId, await publicClientForChain(chainId).getTransactionReceipt({ hash }))
  }, [settled])

  const execute = useCallback(async (prepared: PreparedTransaction, intent: string) => {
    const uid = connector()?.uid
    const abort = new AbortController()
    aborts.current.add(abort)
    setCreated(null)
    setRunChain(prepared.chainId)
    try {
      const ran = await runner.run({
        ...reviewedAction(prepared, intent),
        signal: abort.signal,
        assertWriteState: () => {
          refuseSigna()
          if (connector()?.uid !== uid) throw new ReviewLineError(REVIEWED_ACCOUNT_CHANGED_LINE)
        },
      })
      const done = ran?.status === 'receipt' ? await ran.ended() : ran
      if (done?.status !== 'done') return null
      const receipt = done.receipts.at(-1) ?? await publicClientForChain(prepared.chainId).getTransactionReceipt({ hash: done.hashes.at(-1)! })
      await prepared.verifyReceipt?.(receipt)
      await settled(prepared.chainId, receipt)
      return receipt
    } finally { aborts.current.delete(abort) }
  }, [runner, settled])

  const line = runner.status === 'held' ? runner.held?.line : runner.status === 'failed' ? null : STATUS_LINES[runner.status]
  const hash = runner.hash
  const explorer = hash && runChain ? chainForId(runChain).blockExplorers.default.url : undefined
  return <TransactionContext.Provider value={{ execute, busy: runner.busy }}>
    {children}
    {review && <TransactionReview model={review.model} decide={review.decide} />}
    {address && SUPPORTED_CHAINS.map(chain => <HeldOnChain key={chain.id} chainId={chain.id} account={address} onSettled={settledHash}
      running={runner.busy} shown={runner.held?.state && runner.held.state.status !== 'clear' ? runner.held.state.record.id : undefined} />)}
    {(line || runner.error || created) && <aside id="transaction-status" tabIndex={-1} className="transaction-status" aria-label="Transaction status">
      {line && <p role="status">{line}</p>}
      {runner.status === 'failed' && runner.error && <p role="alert">{runner.error}</p>}
      {hash && explorer && <p><a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">View transaction</a></p>}
      {created && <p><Link href={created}>Open created market</Link></p>}
      {runner.exitAction && <button type="button" onClick={() => void runner.exitAction?.run().then(released => { if (released) runner.reset() })}>{runner.exitAction.label}</button>}
      {runner.sendAgainAction && <button type="button" onClick={() => void runner.sendAgainAction?.run()}>{runner.sendAgainAction.label}</button>}
    </aside>}
  </TransactionContext.Provider>
}

/**
 * Every write held for the account on one chain, after a reload or from another tab: the SDK's line and exit for the
 * ones that need the user, and each followed until it settles, so its effects apply here too. The open run follows and
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
        if (end?.status === 'clear' && end.settled && 'hash' in end.settled && end.settled.result === 'success') void onSettled(chainId, end.settled.hash).catch(() => undefined)
      }, () => undefined)
    }
    return () => stop.abort()
  }, [keys, running, account, chainId, client, onSettled])
  const held = items.filter(item => item.view.phase === 'held' && !(item.view.state && item.view.state.status !== 'clear' && item.view.state.record.id === shown))
  return <HeldWritesNotice items={held} className="transaction-status" />
}
