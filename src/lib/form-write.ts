'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Hex, TransactionReceipt } from 'viem'
import { useReviewedRun, type UseReviewedRunDeps } from '@bananapus/nana-sdk-core/review/react'
import { reviewedAction, type PreparedTransaction } from './transaction'

/** What a form does once its run shows its write done: on that write's chain, after the app's receipt effects. */
type Done = { chainId: number; done: (receipt: TransactionReceipt) => void | Promise<void>; fallback: string }

export type FormWriteOptions = {
  /** Core's run dependencies; null (no wallet yet) refuses every run. */
  deps: UseReviewedRunDeps | null
  /** Reads a succeeded write's receipt and applies the app's effects; the same hash settles once however it is reported. */
  settle: (chainId: number, hash: Hex) => Promise<TransactionReceipt>
  /** Called as a run starts: the app's last gate before the wallet for that run. */
  gate?: () => () => void
}

/**
 * One form's writes over core's useReviewedRun, as revnet's forms run theirs: the form prepares, its own run reviews,
 * sends and follows its write (in the run, still confirming, or a lost wallet reply recovered from its hash), and once
 * the run shows it done, `settle` applies its receipt and the form's `done` runs. Core decides what the run follows and
 * when a retry closes as done or is refused instead of sending.
 *
 * Core cannot see two windows outside its run, so the form covers them: it starts nothing while its success applies
 * (the run already showed it done, so a new run would send again), and a retry whose preparation began before its
 * write completed sends nothing.
 */
export function useFormWrite({ deps, settle, gate }: FormWriteOptions) {
  const runner = useReviewedRun(deps)
  const latest = useRef({ runner, settle, gate })
  useLayoutEffect(() => { latest.current = { runner, settle, gate } })
  const [preparing, setPreparing] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [error, setError] = useState('')
  const [chainId, setChainId] = useState<number | null>(null)
  /** The latest run's form: what runs once that run shows its write done. */
  const pending = useRef<Done | null>(null)

  const busy = preparing || completing || runner.busy
  const busyNow = useRef(busy)
  /** Writes of this form shown done: a retry prepared across one is dropped. */
  const completed = useRef(0)
  useLayoutEffect(() => { busyNow.current = busy })

  const hash = runner.phase === 'done' ? runner.hash : null
  useEffect(() => {
    const form = pending.current
    if (!hash || !form) return
    pending.current = null
    completed.current += 1
    busyNow.current = true
    setCompleting(true)
    void latest.current.settle(form.chainId, hash).then(form.done)
      .catch(cause => setError(cause instanceof Error ? cause.message : form.fallback))
      .finally(() => setCompleting(false))
  }, [hash])

  const run = useCallback(async (prepare: () => Promise<PreparedTransaction>, intent: string,
    done: (receipt: TransactionReceipt) => void | Promise<void>, fallback: string) => {
    if (busyNow.current) return
    busyNow.current = true
    const generation = completed.current
    setError('')
    setPreparing(true)
    try {
      const prepared = await prepare()
      setPreparing(false)
      if (completed.current !== generation) return
      const { runner, gate } = latest.current
      pending.current = { chainId: prepared.chainId, done, fallback }
      setChainId(prepared.chainId)
      await runner.run({ ...reviewedAction(prepared, intent), ...(gate ? { assertWriteState: gate() } : {}) })
    } catch (cause) { setError(cause instanceof Error ? cause.message : fallback) }
    finally {
      setPreparing(false)
      // Until the next render says otherwise: a run that changed nothing renders nothing.
      busyNow.current = latest.current.runner.busy
    }
  }, [])

  return { runner, run, preparing, error, setError, chainId, busy }
}
