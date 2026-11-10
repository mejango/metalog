import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { setTimeout as pause } from 'node:timers/promises'
import {
  createPublicClient, createTestClient, createWalletClient, custom, http,
  type Address, type Hex, type PublicClient, type TransactionReceipt, type WalletClient,
} from 'viem'
import {
  createHeldWriteStorage, createWriteHold, openStepHold, registerReviewHandler, sendReviewed, viemWalletAdapter, type WriteHoldClient,
} from '@bananapus/nana-sdk-core/review'
import { expect } from 'vitest'
import { reviewedAction, type PreparedTransaction } from '../../src/lib/transaction'
import { checkReceiptEffects } from './effects'
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

/**
 * Metalog's reviewed send on this fork, as the app runs it: the review confirmed, one write hold (in memory), and the
 * confirmed receipt's effects checked. `lose` mines the write but loses the wallet's reply, as a closed tab does.
 */
export function forkSender(fork: LocalFork) {
  const hold = createWriteHold({ storage: createHeldWriteStorage({ durable: () => undefined, memory: new Map() }) })
  registerReviewHandler(async prompt => prompt.confirmation)
  /** The hash the wallet mined but whose reply was lost: what the user finds in their wallet. */
  let lost: Hex | undefined
  const send = async (prepared: PreparedTransaction, intent: string, lose = false): Promise<TransactionReceipt> => {
    const wallet = fork.wallet(prepared.account)
    const sent: WalletClient = lose
      ? createWalletClient({ account: prepared.account, chain: fork.chain, transport: custom({ request: async ({ method, params }) => {
        const result = await wallet.request({ method, params } as never)
        if (method !== 'eth_sendTransaction') return result
        lost = result as Hex
        throw new Error('Injected lost wallet reply after the local transaction was mined')
      } }) })
      : wallet
    const adapter = viemWalletAdapter({
      walletClient: async () => sent, account: () => prepared.account, chainId: () => fork.chainId,
      isSafe: () => false, switchChain: async () => {},
    })
    const result = await sendReviewed(reviewedAction(prepared, intent), { adapter, hold, clientFor: () => fork.client })
    if (result.status !== 'done') throw new Error(`The fork write ended ${result.status}.`)
    const receipt = result.receipts.at(-1)!
    await checkReceiptEffects(prepared, receipt)
    return receipt
  }
  /**
   * The held write with no hash, given the hash the wallet shows: the hold checks it is this exact call at or after
   * the reserved nonce, and settles it from its receipt.
   */
  const settledReceipt = async (prepared: PreparedTransaction, intent: string): Promise<TransactionReceipt> => {
    const handle = openStepHold(hold, prepared.account, false, reviewedAction(prepared, intent).calls[0])
    const client = fork.client as unknown as WriteHoldClient
    expect((await handle.state(client)).status).toBe('held-no-hash')
    const state = await handle.attachHash(client, lost!)
    if (state.status !== 'clear' || !state.settled || !('hash' in state.settled) || state.settled.result !== 'success') {
      throw new Error(`The hold did not settle a success: ${state.status}.`)
    }
    return fork.client.getTransactionReceipt({ hash: state.settled.hash as Hex })
  }
  return { hold, send, settledReceipt }
}
