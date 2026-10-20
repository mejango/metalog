import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { setTimeout as pause } from 'node:timers/promises'
import {
  createPublicClient, createTestClient, createWalletClient, http,
  type Address, type PublicClient,
} from 'viem'
import { chainForId } from '../../src/lib/wallet'
import { centerAppOrigin, centerBaseUrl } from '../../src/lib/center'
import deploymentPins from '../../src/lib/defifa-deployments.json' with { type: 'json' }

export const forkChainIds = (process.env.METALOG_FORK_CHAINS || '84532,8453').split(',').map(value => {
  const chainId = Number(value)
  chainForId(chainId)
  return chainId
})

export async function unusedPort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('A local test port is unavailable.')
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

/** Only the freshly spawned loopback Anvil receives transaction or time-travel requests. */
export async function startFork(chainId: number) {
  const chain = chainForId(chainId)
  const rpc = `${centerBaseUrl().replace(/\/+$/, '')}/v1/rpc/${chainId}`
  const origin = centerAppOrigin()
  const source = createPublicClient({ chain, transport: http(rpc, {
    retryCount: 1, timeout: 20_000, fetchOptions: { headers: { Origin: origin } },
  }) })
  if (await source.getChainId() !== chainId) throw new Error('The fork source returned a different network.')
  const requestedBlock = process.env[`METALOG_FORK_BLOCK_${chainId}`]
  const blockNumber = requestedBlock ? BigInt(requestedBlock) : await source.getBlockNumber()
  const deployment = deploymentPins.chains[String(chainId) as keyof typeof deploymentPins.chains]
  if (blockNumber < BigInt(deployment.deployerBlock)) throw new Error('The fork precedes this Defifa deployment.')
  const anchor = await source.getBlock({ blockNumber })
  const url = `http://127.0.0.1:${await unusedPort()}`
  const processHandle = spawn(process.env.ANVIL_BIN || 'anvil', [
    '--quiet', '--host', '127.0.0.1', '--port', new URL(url).port,
    '--chain-id', String(chainId), '--fork-url', rpc, '--fork-block-number', String(blockNumber),
    '--fork-header', `Origin: ${origin}`,
    '--accounts', '5', '--balance', '10000', '--no-storage-caching',
    '--derivation-path', "m/44'/60'/21600'/0/",
    '--retries', '2', '--timeout', '20000',
    // Unpruned, Anvil writes block states to ~/.foundry/anvil/tmp and leaves them when stopped.
    // Pruning keeps the newest 500 in memory (Anvil's default) and writes none to disk.
    '--prune-history', '500',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let processError: Error | undefined
  processHandle.on('error', error => { processError = error })
  let diagnostic = ''
  processHandle.stderr.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-4_000) })
  const onExit = () => { processHandle.kill('SIGTERM') }
  process.once('exit', onExit)
  const stop = async () => {
    process.off('exit', onExit)
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) return
    const exited = once(processHandle, 'exit')
    processHandle.kill('SIGTERM')
    await Promise.race([exited, pause(3_000)])
    if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill('SIGKILL')
  }
  // Cold fork execution fetches many slots serially. This local-only budget
  // leaves individual Center reads bounded at 20s and does not skip simulation.
  // This client only reads/simulates; one transient read retry never resends a write.
  const client = createPublicClient({ chain, transport: http(url, { retryCount: 1, timeout: 180_000 }), cacheTime: 0 }) as PublicClient
  const control = createTestClient({ chain, mode: 'anvil', transport: http(url), cacheTime: 0 })
  try {
    let ready = false
    for (let attempt = 0; attempt < 200; attempt++) {
      if (processError || processHandle.exitCode !== null) throw new Error(`Anvil failed to start: ${processError?.message || diagnostic.replaceAll(rpc, '[fork RPC]')}`)
      try {
        ready = (await client.request({ method: 'web3_clientVersion' })).toLowerCase().includes('anvil') && await client.getChainId() === chainId
        if (ready) break
      } catch { /* The local process is still binding its listener. */ }
      await pause(150)
    }
    if (!ready) throw new Error(`Anvil did not become ready for chain ${chainId}.`)
    const accounts = await createWalletClient({ chain, transport: http(url) }).getAddresses()
    if (accounts.length !== 5) throw new Error('The isolated local wallet accounts are unavailable.')
    // The usual Anvil addresses have public EIP-7702 delegations on some networks.
    // Use a separate deterministic fixture path and fail if any account still inherits code.
    const inheritedCode = await Promise.all(accounts.map(address => client.getCode({ address })))
    if (inheritedCode.some(code => code && code !== '0x')) throw new Error('A test wallet inherits public code; choose a fresh fixture derivation path.')
    return {
      chainId, chain, url, client, control, accounts,
      anchor: { blockNumber: String(blockNumber), blockHash: anchor.hash },
      wallet: (account: Address) => {
        if (!accounts.some(candidate => candidate.toLowerCase() === account.toLowerCase())) throw new Error('Only this fork’s generated accounts may send.')
        return createWalletClient({ account, chain, transport: http(url) })
      },
      advanceTo: async (timestamp: number) => {
        await control.setNextBlockTimestamp({ timestamp: BigInt(timestamp) })
        await control.mine({ blocks: 1 })
      },
      stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}

export type LocalFork = Awaited<ReturnType<typeof startFork>>
