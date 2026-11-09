'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react'
import Link from 'next/link'
import { getAccount, getWalletClient, switchChain } from '@wagmi/core'
import { useAccount } from 'wagmi'
import { type Hex, type TransactionReceipt, type WalletClient } from 'viem'
import { TransactionReviewCancelledError, transactionMessage } from '@bananapus/nana-sdk-core/review'
import {
  executeTransaction, matchesPrepared, readPendingTransaction, recoverTransaction, TRANSACTION_STORAGE_KEY, TRANSACTION_JOURNAL_STORAGE_KEY, readPendingAttempts, creationAttemptStorage, marketAttemptStorage, marketIntentId, pendingBlocksMarket, pendingBlocksNewCreation, selectedTransactionStatus,
  type PendingTransaction, type PendingAttempt, type PreparedTransaction, type TransactionRuntime, type TransactionStatus,
} from '@/lib/transaction'
import { chainForId, publicClientForChain } from '@/lib/wallet'
import { TransactionReview } from '@/components/TransactionReview'
import { wagmiConfig } from './Providers'
import { classifyTransactionScope, transactionMatchesMarketScope, type MarketTransactionScope } from '@/lib/transaction-scope'

type TransactionContextValue = {
  execute: (prepared: PreparedTransaction) => Promise<TransactionReceipt | null>
  executeNewMarket: (prepared: PreparedTransaction, attemptId: string) => Promise<TransactionReceipt | null>
  executeMarket: (prepared: PreparedTransaction, scope: MarketTransactionScope) => Promise<TransactionReceipt | null>
  hasPendingForMarket: (scope: MarketTransactionScope) => boolean
  canCreateNewMarket: boolean
  isCreationPending: (attemptId: string) => boolean
  recover: (hash?: Hex, prepared?: PreparedTransaction) => Promise<TransactionReceipt | null>
  pending: PendingTransaction | null
  status: TransactionStatus
  error: string | null
  busy: boolean
}
const TransactionContext = createContext<TransactionContextValue | null>(null)

export function useTransactions() {
  const value = useContext(TransactionContext)
  if (!value) throw new Error('Transactions must be inside Providers.')
  return value
}

/** Prepare a write, hand it to the transaction runner, then apply its confirmed receipt. One run at a time; `preparing` ends at the hand-off. */
export function usePreparedWrite() {
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState('')
  const active = useRef(false)
  const run = useCallback(async <T,>(prepare: () => Promise<T>, send: (prepared: T) => Promise<TransactionReceipt | null>,
    settle: (receipt: TransactionReceipt) => void | Promise<void>, fallback: string) => {
    if (active.current) return
    active.current = true
    setError('')
    setPreparing(true)
    try {
      const prepared = await prepare()
      setPreparing(false)
      const receipt = await send(prepared)
      if (receipt) await settle(receipt)
    } catch (cause) { setError(cause instanceof Error ? cause.message : fallback) }
    finally { active.current = false; setPreparing(false) }
  }, [])
  return { preparing, error, setError, run }
}

const identity = () => {
  const current = getAccount(wagmiConfig)
  return { address: current.address, chainId: current.chainId, connectorUid: current.connector?.uid, isSigna: current.connector?.id === 'juicebox-center' }
}

/** Native cross-tab locks and the durable record prevent a second send during uncertainty. */
async function withTransactionLock<T>(action: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('This browser cannot preserve transaction coordination. Use a current browser to transact.')
  return navigator.locks.request('metalog:transaction', { ifAvailable: true }, lock => {
    if (!lock) throw new Error('Another Metalog tab is handling a transaction. Continue there.')
    return action()
  })
}

export function Transactions({ children }: PropsWithChildren) {
  const [attempts, setAttempts] = useState<PendingAttempt[]>([])
  const [selectedAttempt, setSelectedAttempt] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = attempts[0]?.transaction ?? null
  const selected = attempts.find(attempt => attempt.attemptId === selectedAttempt) ?? (!busy ? attempts[0] : undefined)
  const selectedPending = selected?.transaction ?? null
  const [status, setStatus] = useState<TransactionStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [review, setReview] = useState<{ request: PreparedTransaction; gas: bigint } | null>(null)
  const [recoveryHash, setRecoveryHash] = useState('')
  const deciding = useRef<((approved: boolean) => void) | null>(null)
  const locked = useRef(false)
  const preparedRef = useRef<PreparedTransaction | undefined>(undefined)
  const [lastSent, setLastSent] = useState<{ hash: Hex; chainId: number } | null>(null)
  const [recoveredMarket, setRecoveredMarket] = useState<string | null>(null)
  const reviewIdentity = useRef<ReturnType<typeof identity> | null>(null)
  const { address, chainId, connector } = useAccount()

  const decide = useCallback((approved: boolean) => {
    const resolve = deciding.current
    const expected = reviewIdentity.current
    const current = identity()
    deciding.current = null
    reviewIdentity.current = null
    setReview(null)
    resolve?.(approved && !!expected && current.address === expected.address && current.chainId === expected.chainId && current.connectorUid === expected.connectorUid)
  }, [])

  useEffect(() => {
    const expected = reviewIdentity.current
    if (expected && (address !== expected.address || chainId !== expected.chainId || connector?.uid !== expected.connectorUid)) decide(false)
  }, [address, chainId, connector?.uid, decide])
  useEffect(() => () => { deciding.current?.(false); deciding.current = null }, [])
  useEffect(() => {
    const restore = () => {
      try {
        const saved = readPendingAttempts(window.localStorage)
        setAttempts(saved)
        if (!locked.current) setStatus(saved[0]?.transaction.phase ?? 'idle')
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'The saved transaction is unavailable.'); setStatus('error') }
    }
    restore()
    const changed = (event: StorageEvent) => { if (event.key === TRANSACTION_STORAGE_KEY || event.key === TRANSACTION_JOURNAL_STORAGE_KEY || event.key === null) restore() }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [])

  const onStatus = useCallback((next: TransactionStatus, saved?: PendingTransaction | null) => {
    setStatus(next)
    if (saved !== undefined) setAttempts(readPendingAttempts(window.localStorage))
    if (saved?.hash) setLastSent({ hash: saved.hash, chainId: saved.chainId })
  }, [])

  async function run(action: () => Promise<TransactionReceipt>): Promise<TransactionReceipt | null> {
    if (locked.current) return null
    locked.current = true
    setBusy(true)
    setError(null)
    try { return await withTransactionLock(action) }
    catch (cause) {
      if (cause instanceof TransactionReviewCancelledError) setStatus('idle')
      else setError(transactionMessage(cause instanceof Error ? cause.message : 'The transaction could not be checked.'))
      try {
        const saved = readPendingAttempts(window.localStorage)
        setAttempts(saved)
        if (!(cause instanceof TransactionReviewCancelledError)) setStatus(saved.find(attempt => attempt.attemptId === selectedAttempt)?.transaction.phase ?? saved[0]?.transaction.phase ?? 'error')
      } catch { setStatus('error') }
      return null
    } finally { locked.current = false; setBusy(false) }
  }

  async function execute(prepared: PreparedTransaction, attemptId?: string, marketScope?: MarketTransactionScope) {
    return run(async () => {
      const previous = readPendingAttempts(window.localStorage)
      if (attemptId && (classifyTransactionScope(prepared).kind !== 'creation' || pendingBlocksNewCreation(previous))) throw new Error('Check the unrecognized earlier transaction before creating a market.')
      if (marketScope && (!transactionMatchesMarketScope(prepared, marketScope) || pendingBlocksMarket(previous, marketScope))) throw new Error('Check the pending transaction for this market before submitting another action.')
      const storage = attemptId ? creationAttemptStorage(window.localStorage, attemptId) : marketScope ? marketAttemptStorage(window.localStorage, marketScope) : window.localStorage
      setSelectedAttempt(marketScope ? marketIntentId(marketScope) : attemptId ?? null)
      setRecoveryHash('')
      preparedRef.current = prepared
      setLastSent(null)
      setRecoveredMarket(null)
      let wallet: WalletClient | undefined
      const runtime: TransactionRuntime = {
        storage,
        client: publicClientForChain(prepared.chainId),
        identity,
        review: (request, gas) => new Promise(resolve => {
          reviewIdentity.current = identity()
          deciding.current = resolve
          setReview({ request, gas })
        }),
        switchChain: async target => {
          if (getAccount(wagmiConfig).chainId !== target) await switchChain(wagmiConfig, { chainId: chainForId(target).id })
          wallet = await getWalletClient(wagmiConfig, { chainId: chainForId(target).id })
        },
        send: request => {
          if (!wallet) throw new Error('Reconnect your wallet before sending.')
          return wallet.sendTransaction({ account: request.account, chain: chainForId(request.chainId), to: request.to, data: request.data, value: request.value, gas: request.gas })
        },
        onStatus,
      }
      return executeTransaction(prepared, runtime)
    })
  }

  async function recover(hash?: Hex, prepared?: PreparedTransaction) {
    return run(async () => {
      const storage = selected?.transaction.marketScope ? marketAttemptStorage(window.localStorage, selected.transaction.marketScope) : selected?.attemptId ? creationAttemptStorage(window.localStorage, selected.attemptId) : window.localStorage
      const saved = readPendingTransaction(storage)
      if (!saved) throw new Error('There is no pending transaction.')
      if (prepared && !matchesPrepared(saved, prepared)) throw new Error('This action differs from the saved transaction.')
      let verifier = prepared ?? (preparedRef.current && matchesPrepared(saved, preparedRef.current) ? preparedRef.current : undefined)
      if (!verifier?.verifyReceipt) {
        const { verifyDefifaTransactionReceipt } = await import('@/lib/defifa')
        const request = { chainId: saved.chainId, account: saved.account, to: saved.to, data: saved.data,
          value: BigInt(saved.value), title: saved.title, details: saved.details }
        verifier = { ...request, verifyReceipt: receipt => verifyDefifaTransactionReceipt(request, receipt) }
      }
      const receipt = await recoverTransaction({ storage, client: publicClientForChain(saved.chainId), onStatus }, hash, verifier)
      setRecoveryHash('')
      // A creation recovered after reload must return the user to its new game.
      const { createdMarketId } = await import('@/lib/defifa')
      try { setRecoveredMarket(`/markets/${saved.chainId}/${createdMarketId(receipt)}`) }
      catch { setRecoveredMarket(null) } // Other verified actions do not launch a game.
      return receipt
    })
  }

  const messages: Partial<Record<TransactionStatus, string>> = {
    simulating: 'Checking transaction…', signing: 'Confirm in your wallet…', pending: busy ? 'Checking confirmation…' : 'Submitted. Check confirmation.',
    unknown: 'Submission is unconfirmed. Check the original transaction before sending again.', success: 'Transaction confirmed.',
  }
  const shownStatus = selectedTransactionStatus(status, busy, selectedPending)
  const shownHash = selectedPending?.hash ?? (!selectedPending ? lastSent?.hash : undefined)
  const shownChain = selectedPending?.chainId ?? lastSent?.chainId
  const explorer = shownChain ? chainForId(shownChain).blockExplorers.default.url : undefined
  return <TransactionContext.Provider value={{ execute: prepared => execute(prepared), executeNewMarket: (prepared, attemptId) => execute(prepared, attemptId), executeMarket: (prepared, scope) => execute(prepared, undefined, scope), hasPendingForMarket: scope => pendingBlocksMarket(attempts, scope), canCreateNewMarket: !pendingBlocksNewCreation(attempts), isCreationPending: attemptId => attempts.some(attempt => attempt.attemptId === attemptId), recover, pending, status, error, busy }}>
    {children}
    {review && <TransactionReview request={review.request} gas={review.gas} decide={decide} />}
    {(pending || error || messages[status]) && <aside id="transaction-status" tabIndex={-1} className="transaction-status" aria-label="Transaction status">
      {attempts.length > 1 && <label>Pending transaction<select aria-label="Pending transaction" value={selected?.attemptId ?? 'legacy'} onChange={event => { const id = event.target.value === 'legacy' ? null : event.target.value; setSelectedAttempt(id); setRecoveryHash(''); setRecoveredMarket(null); setLastSent(null); setError(null); setStatus(attempts.find(attempt => attempt.attemptId === id)?.transaction.phase ?? 'idle') }} disabled={busy}>{attempts.map(attempt => <option key={attempt.attemptId ?? 'legacy'} value={attempt.attemptId ?? 'legacy'}>{attempt.transaction.title} — {new Date(attempt.transaction.createdAt).toISOString()} — {attempt.transaction.id.slice(0, 8)}</option>)}</select></label>}
      {messages[shownStatus] && <p role="status">{messages[shownStatus]}</p>}
      {error && <p role="alert">{error}</p>}
      {shownHash && explorer && <p><a href={`${explorer}/tx/${shownHash}`} target="_blank" rel="noreferrer">View transaction</a></p>}
      {recoveredMarket && <p><Link href={recoveredMarket}>Open created market</Link></p>}
      {pending && !busy && <>
        {!shownHash && <label>Original transaction hash<input value={recoveryHash} onChange={event => setRecoveryHash(event.target.value)} autoComplete="off" spellCheck={false} /></label>}
        <button type="button" onClick={() => void recover(shownHash ?? (recoveryHash as Hex))}>Check transaction</button>
      </>}
    </aside>}
  </TransactionContext.Provider>
}
