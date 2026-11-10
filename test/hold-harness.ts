import { afterEach, vi } from 'vitest'
import { numberToHex, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { createHeldWriteStorage, createWriteHold, registerReviewHandler, sendReviewed, type WalletAdapter } from '@bananapus/nana-sdk-core/review'
import type { MarketDefinition } from '../src/domain/market'
import { reviewedAction, type PreparedTransaction } from '../src/lib/transaction'

/** One chain that mines each accepted send in the next block, a wallet whose reply each test sets, and one write hold. */
export const account = '0x0000000000000000000000000000000000000011' as Address
export const terminal = '0x0000000000000000000000000000000000000022' as Address
export const definition: MarketDefinition = { schemaVersion: 1, settlement: 'defifa-scorecard', prompt: 'BTC?', source: 'S', resolutionRule: 'R',
  entryOpensAt: 100, entryClosesAt: 1_000, resolvesAt: 2_000, rangeCount: 3, rangeWidth: 1, unitPriceWei: '1000' }
export const marketA = { chainId: 8453, projectId: '27' }
export const marketB = { chainId: 8453, projectId: '28' }

type Tx = { hash: Hex; nonce: number; to: Address; input: Hex; value: bigint; block?: bigint; from?: Address }

export function harness() {
  const chain = { head: 100n, finalized: 90n, txs: [] as Tx[] }
  const at = (n: bigint) => numberToHex(n + 1n, { size: 32 })
  const asTx = (tx: Tx) => ({ hash: tx.hash, chainId: 8453, from: tx.from ?? account, to: tx.to, input: tx.input, value: tx.value, nonce: tx.nonce,
    blockHash: tx.block === undefined ? null : at(tx.block), blockNumber: tx.block ?? null, transactionIndex: tx.block === undefined ? null : 0 })
  const notFound = (name: string) => Object.assign(new Error('not found'), { name })
  const receipt = (tx: Tx) => ({ transactionHash: tx.hash, blockHash: at(tx.block!), blockNumber: tx.block!, transactionIndex: 0,
    from: tx.from ?? account, to: tx.to, status: 'success', logs: [] }) as unknown as TransactionReceipt
  const client = {
    chain: { id: 8453, name: 'Base' },
    estimateGas: vi.fn(async () => 21_000n),
    readContract: vi.fn(async () => { throw new Error('no token reads') }),
    getChainId: vi.fn(async () => 8453),
    getBlockNumber: vi.fn(async () => chain.head),
    getTransactionCount: vi.fn(async ({ address, blockNumber, blockTag }: { address?: Address; blockNumber?: bigint; blockTag?: string }) =>
      7 + chain.txs.filter(tx => (!address || (tx.from ?? account).toLowerCase() === address.toLowerCase())
        && (blockTag === 'pending' || (tx.block !== undefined && tx.block <= (blockNumber ?? chain.head)))).length),
    getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => {
      const tx = chain.txs.find(item => item.hash === hash)
      if (!tx) throw notFound('TransactionNotFoundError')
      return asTx(tx)
    }),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      const tx = chain.txs.find(item => item.hash === hash)
      if (!tx || tx.block === undefined) throw notFound('TransactionReceiptNotFoundError')
      return receipt(tx)
    }),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      const tx = chain.txs.find(item => item.hash === hash)
      if (!tx || tx.block === undefined) throw notFound('WaitForTransactionReceiptTimeoutError')
      return receipt(tx)
    }),
    getBlock: vi.fn(async ({ blockTag, blockNumber, includeTransactions }: { blockTag?: string; blockNumber?: bigint; includeTransactions?: boolean } = {}) => {
      const number = blockTag === 'finalized' ? chain.finalized : blockNumber ?? chain.head
      return { number, hash: at(number), timestamp: 1_000n + number,
        transactions: includeTransactions ? chain.txs.filter(tx => tx.block === number).map(asTx) : [] }
    }),
    request: vi.fn(async ({ method, params }: { method: string; params: unknown[] }) => {
      if (method === 'eth_call') return '0x'
      if (method === 'eth_getBlockByNumber') {
        const n = params[0] === 'finalized' ? chain.finalized : params[0] === 'latest' ? chain.head : BigInt(params[0] as string)
        return { number: numberToHex(n), hash: at(n) }
      }
      if (method === 'eth_getLogs') return []
      throw new Error(`unexpected ${method}`)
    }),
  }
  let sends = 0
  /** What the wallet does with the next send: mine it, by default. */
  let reply = async (tx: { to: Address; data: Hex; value: bigint }): Promise<Hex> => {
    const hash = numberToHex(++sends, { size: 32 })
    const from = adapter.account() ?? account
    chain.head += 1n
    chain.txs.push({ hash, nonce: 7 + chain.txs.filter(item => (item.from ?? account) === from).length, to: tx.to, input: tx.data, value: tx.value,
      block: chain.head, from })
    return hash
  }
  const mine = reply
  const adapter: WalletAdapter = {
    kind: 'wallet', account: () => account, chainId: () => 8453, isSafe: () => false, switchChain: async () => {},
    sendTransaction: vi.fn(tx => reply(tx)),
    signTypedData: async () => { throw new Error('unused') }, signMessage: async () => { throw new Error('unused') },
  }
  const hold = createWriteHold({ storage: createHeldWriteStorage({ durable: () => undefined, memory: new Map() }) })
  const deps = { adapter, hold, clientFor: () => client as unknown as PublicClient }
  const send = (prepared: PreparedTransaction, intent: string) => sendReviewed(reviewedAction(prepared, intent), deps)
  const heldUnder = (intent: string) => hold.list({ account, chainId: 8453 }).find(item => item.record.namespace === intent)
  return { chain, client, adapter, hold, send, heldUnder, mine, setReply: (next: typeof reply) => { reply = next } }
}

export const write = (data: Hex): PreparedTransaction => ({ chainId: 8453, account, to: terminal, data, value: 7n, title: 'Enter market', details: [{ label: 'Positions', value: '7' }] })
const unregister: (() => void)[] = []
afterEach(() => { while (unregister.length) unregister.pop()!(); vi.useRealTimers() })
export function confirmEveryReview() { unregister.push(registerReviewHandler(async prompt => prompt.confirmation)) }
