'use client'

import { useEffect, useState } from 'react'
import { connect } from '@wagmi/core'
import { wagmiConfig } from '@/providers/Providers'
import { walletCallbackUrl } from '@/providers/wallet-callback'

let completing: Promise<string | null> | undefined
let callbackResolved = false
async function complete() {
  const callback = walletCallbackUrl()
  const [{ deliverCenterCallback, completeCenterCallback }, runtime] = await Promise.all([
    import('@me.jango/signa/core'), import('@/lib/wallet-signa'),
  ])
  if (!callbackResolved && new URL(callback).search && await deliverCenterCallback(callback, { window })) {
    callbackResolved = true
    return null
  }
  if (!callbackResolved) {
    await completeCenterCallback(runtime.signaWallet(), callback)
    callbackResolved = true
  }
  const connector = wagmiConfig.connectors.find(item => item.id === 'juicebox-center')
  if (!connector) throw new Error('Signa is not configured for this site.')
  if (wagmiConfig.state.current !== connector.uid) await connect(wagmiConfig, { connector })
  return runtime.originalWalletPage()
}

export default function WalletCallback() {
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [done, setDone] = useState(false)
  useEffect(() => {
    let active = true
    completing ??= complete().catch(cause => { completing = undefined; throw cause })
    void completing.then(path => {
      if (!active) return
      if (path) window.location.replace(path)
      else setDone(true)
    }, cause => { if (active) setError(cause instanceof Error ? cause.message : 'Sign-in could not be restored.') })
    return () => { active = false }
  }, [attempt])
  return <main>
    <h1>Signa</h1>
    <p role={error ? 'alert' : 'status'}>{error ?? (done ? 'Signed in. You can close this window.' : 'Signing in…')}</p>
    {error && <button type="button" onClick={() => { setError(null); setAttempt(value => value + 1) }}>Retry</button>}
  </main>
}
