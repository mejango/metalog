'use client'

import { useEffect, useState } from 'react'
import { createConnectController, passkeyOption, type ConnectOption } from '@me.jango/signa/core'
import { JBConnectModal } from '@me.jango/signa/react'
import { useConnect } from 'wagmi'
import { SIGNA_ENABLED } from '@/providers/Providers'

export function WalletDialog({ externalOnly, onClose }: { externalOnly?: boolean; onClose: () => void }) {
  const { connectors, connectAsync } = useConnect()
  const [controller] = useState(() => {
    const options: ConnectOption[] = []
    if (SIGNA_ENABLED && !externalOnly) {
      let runtime: typeof import('@/lib/wallet-signa')
      options.push({ ...passkeyOption({
        wallet: async () => { runtime = await import('@/lib/wallet-signa'); return runtime.signaWallet() },
        beforeLaunch: () => runtime.saveWalletReturnPath(),
        connected: async () => {
          const connector = connectors.find(item => item.id === 'juicebox-center')
          if (!connector) throw new Error('Signa is not configured.')
          await connectAsync({ connector })
          onClose()
        },
      }), name: 'Signa' })
    }
    const announced = connectors.some(item => item.id !== 'juicebox-center' && item.id !== 'injected')
    const external = connectors.filter(item => item.id !== 'juicebox-center' && (item.id !== 'injected' || !announced))
    for (const connector of external) options.push({
      id: connector.uid, name: connector.name,
      connect: async () => { await connectAsync({ connector }); onClose() },
    })
    return createConnectController(options)
  })
  useEffect(() => () => controller.cancel(), [controller])
  return <JBConnectModal open controller={controller} onClose={onClose} title="Connect" passkeyLabel="Signa" className="metalog-connect">
    {externalOnly && <p>Defifa transactions need an external wallet.</p>}
  </JBConnectModal>
}
