import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'
import { setTimeout as pause } from 'node:timers/promises'
import type { Page } from '@playwright/test'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import { startFork, unusedPort, type LocalFork } from '../integration/fork'
import { metadataCid, validateProjectMetadata } from '../../src/domain/market-metadata'

export async function startBrowserFork() {
  const fork = await startFork(84532)
  const port = await unusedPort()
  const baseURL = `http://127.0.0.1:${port}`
  const server = spawn(process.execPath, ['scripts/start.mjs'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), METALOG_RPC_URLS: JSON.stringify({ [fork.chainId]: fork.url }) },
  })
  let diagnostic = ''
  for (const output of [server.stdout, server.stderr]) output.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-8_000) })
  let processError: Error | undefined
  server.on('error', error => { processError = error })
  const stop = async () => {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit')
      server.kill('SIGTERM')
      await Promise.race([exited, pause(3_000)])
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL')
    }
    await fork.stop()
  }
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (processError || server.exitCode !== null) throw new Error(`The built app did not start: ${processError?.message || diagnostic}`)
      try {
        if ((await fetch(`${baseURL}/create`)).ok) return { fork, baseURL, stop, diagnostic: () => diagnostic }
      } catch { /* The production server is still starting. */ }
      await pause(250)
    }
    throw new Error(`The built app did not become ready: ${diagnostic}`)
  } catch (error) { await stop(); throw error }
}

/** Test-only external provider. Every request, including writes, goes to this loopback fork. */
export async function injectForkWallet(page: Page, fork: LocalFork) {
  // Load application owners through the existing Vite TS/JSON/alias loader;
  // Playwright's direct Node loader cannot consume framework JSON imports.
  const loader = await createServer({ root: process.cwd(), configFile: false,
    resolve: { alias: { '@': `${process.cwd()}/src` } }, server: { middlewareMode: true }, appType: 'custom' })
  let owners: typeof import('../../src/lib/defifa')
  let metadataOwner: typeof import('../../src/lib/market-metadata')
  try {
    owners = await loader.ssrLoadModule('/src/lib/defifa.ts') as typeof import('../../src/lib/defifa')
    metadataOwner = await loader.ssrLoadModule('/src/lib/market-metadata.ts') as typeof import('../../src/lib/market-metadata')
  } finally { await loader.close() }
  const { DEFIFA_ABI, deploymentForChain, launchData } = owners
  const { loadMarketMetadata } = metadataOwner
  const transactions: Hex[] = []
  /** The next send broadcasts, then its reply is lost before the page reads it, as a closed wallet connection loses it. */
  let loseNextReply = false
  const chainSwitches: number[] = []
  const metadataPins: { cid: string; bodySha256: string; status: number; warmupGas: string; warmupMs: number }[] = []
  let pinRequests = 0
  await page.exposeBinding('__metalogForkSwitch', (_source, chainId: number) => { chainSwitches.push(chainId) })
  await page.exposeBinding('__metalogForkRpc', async (_source, request: { method: string; params?: unknown[] }) => {
    if (request.method === 'eth_sendTransaction') {
      const transaction = request.params?.[0] as { from?: string }
      if (!transaction?.from || !fork.accounts.some(account => account.toLowerCase() === transaction.from!.toLowerCase())) {
        throw new Error('Only the isolated Anvil accounts can send in this browser test.')
      }
    }
    if (new URL(fork.url).hostname !== '127.0.0.1') throw new Error('Browser writes must stay on the local fork.')
    const result = await fork.client.request(request as never)
    if (request.method === 'eth_sendTransaction') {
      transactions.push(result as Hex)
      if (loseNextReply) { loseNextReply = false; throw new Error('The wallet connection closed.') }
    }
    return result
  })
  // App evidence/simulations normally use public RPC transports. Forward their JSON-RPC
  // requests to the exact same fork as the injected wallet and server-side route.
  await page.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin === 'https://juicebox.center' && url.pathname === '/v1/pins/json') {
      // The dynamic loopback browser is intentionally not on Center's pin allowlist.
      // This opt-in qualification publishes only two explicit fixture manifests via
      // the authorized site Origin; production metadata/readback code stays intact.
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: {
        'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type',
      } })
      if (request.method() !== 'POST' || ++pinRequests > 2) throw new Error('The fork qualification permits at most two metadata pins.')
      const body = request.postData()!
      const metadata = validateProjectMetadata(JSON.parse(body))
      if (!['Browser qualification: percentage change?', 'Browser qualification: timeout and refund?'].includes(metadata.metalog.definition.prompt)) {
        throw new Error('Only the explicit local-fork qualification metadata may be published.')
      }
      const response = await page.request.post(request.url(), { data: body, timeout: 60_000, maxRedirects: 0,
        headers: { Origin: 'https://metalog.money', 'content-type': 'application/json' } })
      if (response.ok()) {
        const result = await response.json() as { uri: string }
        if (new URL(fork.url).hostname !== '127.0.0.1') throw new Error('Gas warm-up must stay on the private loopback fork.')
        // Cold Anvil fetches many upstream slots serially. Warm the exact existing
        // launch owner after real IPFS readback, before the app's bounded estimate.
        // This performs no send and never alters the production RPC timeout.
        const started = Date.now()
        let timer: ReturnType<typeof setTimeout> | undefined
        const gas = await Promise.race([
          (async () => {
            const published = await loadMarketMetadata(result.uri)
            const deployment = deploymentForChain(fork.chainId)
            const value = await fork.client.readContract({ address: deployment.projects, abi: DEFIFA_ABI.JBProjects, functionName: 'creationFee' }) as bigint
            const data = encodeFunctionData({ abi: DEFIFA_ABI.DefifaDeployer, functionName: 'launchGameWith',
              args: [launchData(published.definition, fork.chainId, published)] })
            return fork.client.estimateGas({ account: fork.accounts[0], to: deployment.deployer, data, value })
          })(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The private fork gas warm-up exceeded 120 seconds.')), 120_000) }),
        ]).finally(() => { if (timer) clearTimeout(timer) })
        metadataPins.push({ cid: metadataCid(result.uri), bodySha256: createHash('sha256').update(body).digest('hex'),
          status: response.status(), warmupGas: String(gas), warmupMs: Date.now() - started })
      }
      return route.fulfill({ response, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } })
    }
    if (request.method() !== 'POST') return route.continue()
    let body: unknown
    try { body = request.postDataJSON() } catch { return route.continue() }
    const calls = Array.isArray(body) ? body : [body]
    if (!calls.length || !calls.every(call => call && typeof call === 'object' && 'jsonrpc' in call && 'method' in call)) return route.continue()
    const response = await page.request.post(fork.url, { data: body, timeout: 90_000 })
    return route.fulfill({ response, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } })
  })
  await page.addInitScript(({ accounts, chainId }) => {
    type Request = { method: string; params?: unknown[] }
    type Listener = (...args: unknown[]) => void
    const target = window as typeof window & {
      __metalogForkRpc: (request: Request) => Promise<unknown>
      __metalogForkSwitch: (chainId: number) => Promise<void>
      __metalogForkWallet: { select: (address: string) => void }
      ethereum: unknown
    }
    const listeners = new Map<string, Set<Listener>>()
    let address = sessionStorage.getItem('fork-wallet-account') || accounts[0]
    let selectedChain = Number(sessionStorage.getItem('fork-wallet-chain') || 8453)
    let connected = sessionStorage.getItem('fork-wallet-connected') === 'true'
    const emit = (event: string, ...args: unknown[]) => listeners.get(event)?.forEach(listener => listener(...args))
    const provider = {
      on(event: string, listener: Listener) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(listener); return provider },
      removeListener(event: string, listener: Listener) { listeners.get(event)?.delete(listener); return provider },
      async request(request: Request): Promise<unknown> {
        switch (request.method) {
          case 'eth_chainId': return `0x${selectedChain.toString(16)}`
          case 'eth_accounts': return connected ? [address] : []
          case 'eth_requestAccounts':
            connected = true
            sessionStorage.setItem('fork-wallet-connected', 'true')
            emit('accountsChanged', [address])
            return [address]
          case 'wallet_requestPermissions': return [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [address] }] }]
          case 'wallet_getPermissions': return connected ? [{ parentCapability: 'eth_accounts' }] : []
          case 'wallet_revokePermissions': connected = false; sessionStorage.removeItem('fork-wallet-connected'); return null
          case 'wallet_getCapabilities': return {}
          case 'wallet_switchEthereumChain': {
            const selected = request.params?.[0] as { chainId?: string }
            if (selected?.chainId !== `0x${chainId.toString(16)}`) throw Object.assign(new Error('Only the local fork network is available.'), { code: 4902 })
            selectedChain = chainId
            sessionStorage.setItem('fork-wallet-chain', String(selectedChain))
            await target.__metalogForkSwitch(chainId)
            emit('chainChanged', selected.chainId)
            return null
          }
          default: return target.__metalogForkRpc(request)
        }
      },
    }
    target.ethereum = provider
    target.__metalogForkWallet = { select(next) {
      if (!accounts.some(account => account === next)) throw new Error('Not an isolated fork account.')
      address = next
      sessionStorage.setItem('fork-wallet-account', address)
      emit('accountsChanged', [address])
    } }
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: {
      info: { uuid: 'd9a9c5f2-019a-4d5f-89d7-7ccfa5943b81', name: 'Local fork wallet', rdns: 'test.metalog.local-fork', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>' },
      provider,
    } }))
    window.addEventListener('eip6963:requestProvider', announce)
    announce()
  }, { accounts: fork.accounts, chainId: fork.chainId })
  return {
    transactions,
    loseNextReply: () => { loseNextReply = true },
    chainSwitches,
    metadataPins,
    select: (account: Address) => page.evaluate(address => {
      (window as typeof window & { __metalogForkWallet: { select: (account: string) => void } }).__metalogForkWallet.select(address)
    }, account),
  }
}
