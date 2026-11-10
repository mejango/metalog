'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Hex, TransactionReceipt } from 'viem'
import { openStepHold, TransactionReviewCancelledError, WriteHeldError } from '@bananapus/nana-sdk-core/review'
import { useReviewedRun, type UseReviewedRunDeps } from '@bananapus/nana-sdk-core/review/react'
import { reviewedAction, type PreparedTransaction } from './transaction'

/** The form whose write a run sent: its chain, and what it does once that write succeeded and its effects applied. */
type Owner = { chainId: number; done: (receipt: TransactionReceipt) => void | Promise<void>; fallback: string }

export type FormWriteOptions = {
  /** Core's run dependencies; null (no wallet yet) refuses every run. */
  deps: UseReviewedRunDeps | null
  /** Reads a succeeded write's receipt and applies the app's effects; the same hash settles once however it is reported. */
  settle: (chainId: number, hash: Hex) => Promise<TransactionReceipt>
  /** Called as a run starts: the app's last gate before the wallet for that run. */
  gate?: () => () => void
}

/**
 * One form's writes over core's useReviewedRun, as revnet's forms run theirs: the form owns its run, and its run follows
 * the write it sent (in the run, still confirming, or a lost wallet reply recovered from its hash) until it shows `done`.
 * Then `settle` applies its receipt and the form's own `done` runs, once.
 *
 * A write the hold already holds never starts a run: core's run follows whatever its call's hold holds after any failure,
 * so a run refused by another write's hold would adopt that write as its own, and a retry would replace the run that
 * follows the form's own write. One refused in a race (another tab reserved first) is dropped from the form the same way.
 * A form whose write succeeded while its next one prepared, reviewed or applied effects sends nothing.
 */
export function useFormWrite({ deps, settle, gate }: FormWriteOptions) {
  const runner = useReviewedRun(deps)
  const latest = useRef({ runner, deps, settle, gate })
  useLayoutEffect(() => { latest.current = { runner, deps, settle, gate } })
  const [preparing, setPreparing] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [error, setError] = useState('')
  const [chainId, setChainId] = useState<number | null>(null)
  /** A run is open: preparing, in review, sending or following in place. */
  const active = useRef(false)
  /** This form's write succeeded and its effects are applying: it starts nothing until they are done. */
  const closing = useRef(false)
  /** The form whose write the run follows; cleared once completed, or when its run never reserved a write. */
  const owner = useRef<Owner | null>(null)
  /** Writes of this form that completed: a run begun before one is dropped. */
  const completed = useRef(0)

  const hash = runner.phase === 'done' ? runner.hash : null
  useEffect(() => {
    const form = owner.current
    if (!hash || !form) return
    owner.current = null
    completed.current += 1
    closing.current = true
    setCompleting(true)
    void (async () => {
      try { await form.done(await latest.current.settle(form.chainId, hash)) }
      catch (cause) { setError(cause instanceof Error ? cause.message : form.fallback) }
      finally { closing.current = false; setCompleting(false) }
    })()
  }, [hash])

  const run = useCallback(async (prepare: () => Promise<PreparedTransaction>, intent: string,
    done: (receipt: TransactionReceipt) => void | Promise<void>, fallback: string) => {
    if (active.current || closing.current) return
    active.current = true
    const generation = completed.current
    const stale = () => completed.current !== generation || closing.current
    setError('')
    setPreparing(true)
    try {
      const prepared = await prepare()
      setPreparing(false)
      if (stale()) return
      const { runner, deps } = latest.current
      const action = reviewedAction(prepared, intent)
      if (deps) {
        const held = openStepHold(deps.hold, prepared.account, false, action.calls[0]).peek()
        if (held.status !== 'clear') { setError(held.line); return }
      }
      const last = latest.current.gate?.()
      const form: Owner = { chainId: prepared.chainId, done, fallback }
      owner.current = form
      setChainId(prepared.chainId)
      const ran = await runner.run({
        ...action,
        assertWriteState: () => {
          last?.()
          if (stale()) throw new TransactionReviewCancelledError()
        },
      })
      if (ran?.status === 'failed' && ran.failure instanceof WriteHeldError && owner.current === form) owner.current = null
    } catch (cause) { setError(cause instanceof Error ? cause.message : fallback) }
    finally { active.current = false; setPreparing(false) }
  }, [])

  return { runner, run, preparing, completing, error, setError, chainId, busy: preparing || completing || runner.busy }
}
