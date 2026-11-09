'use client'

import { useEffect, useId, useRef } from 'react'
import type { ReviewModel } from '@bananapus/nana-sdk-core/review'
import { chainForId } from '@/lib/wallet'

export function TransactionReview({ model, decide }: { model: ReviewModel; decide: (approved: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useId()
  useEffect(() => {
    const element = dialog.current
    const opener = document.activeElement
    element?.showModal()
    return () => { element?.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus() }
  }, [])
  return <dialog ref={dialog} className="transaction-dialog" aria-labelledby={title} onCancel={event => { event.preventDefault(); decide(false) }}>
    <h2 id={title}>{model.title}</h2>
    {model.context.length > 0 && <dl>{model.context.map((row, index) => <div key={index}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>}
    {model.calls.map((call, index) => <div key={index}>
      <dl>
        <div><dt>Network</dt><dd>{chainForId(call.chainId).name}</dd></div>
        <div><dt>Payment</dt><dd>{call.valueText}</dd></div>
        {call.gas !== null && <div><dt>Gas limit</dt><dd>{call.gas.toString()}</dd></div>}
      </dl>
      <details>
        <summary>Transaction</summary>
        <dl>
          {call.from && <div><dt>From</dt><dd><code>{call.from}</code></dd></div>}
          <div><dt>To</dt><dd><code>{call.to}</code></dd></div>
          <div><dt>Calldata</dt><dd><code>{call.data}</code></dd></div>
        </dl>
      </details>
    </div>)}
    {model.warnings.map((warning, index) => <p key={index} role="alert">{warning.text}</p>)}
    <div className="actions">
      <button type="button" onClick={() => decide(false)}>Cancel</button>
      <button type="button" onClick={() => decide(true)}>{model.confirmLabel ?? 'Continue to wallet'}</button>
    </div>
  </dialog>
}
