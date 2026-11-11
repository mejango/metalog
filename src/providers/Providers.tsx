'use client'

import './wallet-callback'
import { createContext, lazy, Suspense, useCallback, useContext, useMemo, useState, type PropsWithChildren } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createConfig, injected, useAccount, useDisconnect, WagmiProvider, type CreateConnectorFn } from 'wagmi'
import { centerAccountConnector } from '@me.jango/signa/wagmi'
import type { Transport } from 'viem'
import { hasSavedSignaConnection, rpcTransport, SUPPORTED_CHAINS, publicClientForChain } from '@/lib/wallet'
import { Transactions } from './Transactions'

export const SIGNA_ENABLED = process.env.NEXT_PUBLIC_SIGNA_ENABLED === 'true'
function signaConnector(): CreateConnectorFn {
  const build = centerAccountConnector({
    wallet: async () => (await import('@/lib/wallet-signa')).signaWallet(),
    read: input => publicClientForChain(8453).request(input as never),
  })
  return config => {
    const connector = build(config)
    return { ...connector, async isAuthorized() {
      try {
        if (typeof window === 'undefined' || !hasSavedSignaConnection(window.sessionStorage, window.location.origin)) return false
        return await connector.isAuthorized()
      } catch { return false }
    } }
  }
}
export const wagmiConfig = createConfig({
  chains: SUPPORTED_CHAINS,
  transports: Object.fromEntries(SUPPORTED_CHAINS.map(chain => [chain.id, rpcTransport(chain.id)])) as Record<(typeof SUPPORTED_CHAINS)[number]['id'], Transport>,
  connectors: [injected({ shimDisconnect: true }), ...(SIGNA_ENABLED ? [signaConnector()] : [])],
  multiInjectedProviderDiscovery: true,
  ssr: true,
})

type ConnectOptions = { externalOnly?: boolean }
const WalletContext = createContext<{ connect: (options?: ConnectOptions) => void }>({ connect: () => {} })
const WalletDialog = lazy(() => import('@/components/WalletDialog').then(module => ({ default: module.WalletDialog })))

export function useWallet() {
  const { address, chainId, connector } = useAccount()
  const { disconnect } = useDisconnect()
  const { connect } = useContext(WalletContext)
  return { address, chainId, isSigna: connector?.id === 'juicebox-center', connect, disconnect }
}

export function Providers({ children }: PropsWithChildren) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: {
    staleTime: 30_000, gcTime: 600_000, retry: 1, refetchOnWindowFocus: false,
  } } }))
  const [chooser, setChooser] = useState<ConnectOptions | null>(null)
  const connect = useCallback((options?: ConnectOptions) => setChooser(options ?? {}), [])
  const close = useCallback(() => setChooser(null), [])
  const context = useMemo(() => ({ connect }), [connect])
  return <QueryClientProvider client={queryClient}>
    <WagmiProvider config={wagmiConfig}>
      <WalletContext.Provider value={context}>
        <Transactions>{children}</Transactions>
        {chooser && <Suspense fallback={<p role="status">Loading wallets…</p>}>
          <WalletDialog key={chooser.externalOnly ? 'external' : 'all'} externalOnly={chooser.externalOnly} onClose={close} />
        </Suspense>}
      </WalletContext.Provider>
    </WagmiProvider>
  </QueryClientProvider>
}
