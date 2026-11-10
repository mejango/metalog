import { afterEach, describe, expect, it, vi } from 'vitest'
import { numberToHex, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import {
  createHeldWriteStorage, createWriteHold, openStepHold, registerReviewHandler, sendReviewed, WriteHeldError, type WalletAdapter,
} from '@bananapus/nana-sdk-core/review'
import type { MarketDefinition } from '../src/domain/market'
import { REVIEWED_RUN_BUSY_LINE } from '@bananapus/nana-sdk-core/review/react'
import { creationIntent, exclusive, marketIntent, reviewedAction, runOutcome, type PreparedTransaction } from '../src/lib/transaction'

const account = '0x0000000000000000000000000000000000000011' as Address
const terminal = '0x0000000000000000000000000000000000000022' as Address
const definition: MarketDefinition = { schemaVersion: 1, settlement: 'defifa-scorecard', prompt: 'BTC?', source: 'S', resolutionRule: 'R',
  entryOpensAt: 100, entryClosesAt: 1_000, resolvesAt: 2_000, rangeCount: 3, rangeWidth: 1, unitPriceWei: '1000' }
const marketA = { chainId: 8453, projectId: '27' }
const marketB = { chainId: 8453, projectId: '28' }

type Tx = { hash: Hex; nonce: number; to: Address; input: Hex; value: bigint; block?: bigint }

/** One chain that mines each accepted send in the next block, and a wallet whose reply each test sets. */
function harness() {
  const chain = { head: 100n, finalized: 90n, txs: [] as Tx[] }
  const at = (n: bigint) => numberToHex(n + 1n, { size: 32 })
  const asTx = (tx: Tx) => ({ hash: tx.hash, chainId: 8453, from: account, to: tx.to, input: tx.input, value: tx.value, nonce: tx.nonce,
    blockHash: tx.block === undefined ? null : at(tx.block), blockNumber: tx.block ?? null, transactionIndex: tx.block === undefined ? null : 0 })
  const notFound = (name: string) => Object.assign(new Error('not found'), { name })
  const receipt = (tx: Tx) => ({ transactionHash: tx.hash, blockHash: at(tx.block!), blockNumber: tx.block!, transactionIndex: 0,
    from: account, to: tx.to, status: 'success', logs: [] }) as unknown as TransactionReceipt
  const client = {
    chain: { id: 8453, name: 'Base' },
    estimateGas: vi.fn(async () => 21_000n),
    readContract: vi.fn(async () => { throw new Error('no token reads') }),
    getChainId: vi.fn(async () => 8453),
    getBlockNumber: vi.fn(async () => chain.head),
    getTransactionCount: vi.fn(async ({ blockNumber, blockTag }: { blockNumber?: bigint; blockTag?: string }) =>
      7 + chain.txs.filter(tx => blockTag === 'pending' || (tx.block !== undefined && tx.block <= (blockNumber ?? chain.head))).length),
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
    chain.head += 1n
    chain.txs.push({ hash, nonce: 7 + chain.txs.length, to: tx.to, input: tx.data, value: tx.value, block: chain.head })
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

const write = (data: Hex): PreparedTransaction => ({ chainId: 8453, account, to: terminal, data, value: 7n, title: 'Enter market', details: [{ label: 'Positions', value: '7' }] })
const unregister: (() => void)[] = []
afterEach(() => { while (unregister.length) unregister.pop()!(); vi.useRealTimers() })
function confirmEveryReview() { unregister.push(registerReviewHandler(async prompt => prompt.confirmation)) }

describe('metalog writes under the SDK hold', () => {
  it('holds a market whose wallet reply never came, lets other markets and creations proceed, and offers the exit', async () => {
    confirmEveryReview()
    const h = harness()
    h.setReply(async () => { throw new Error('The wallet connection closed.') })
    await expect(h.send(write('0x12345678'), marketIntent(marketA))).rejects.toThrow()
    const held = h.heldUnder(marketIntent(marketA))!
    const unknown = await held.handle.state(h.client as never)
    expect(unknown).toMatchObject({ status: 'held-no-hash', exit: true })

    h.setReply(h.mine)
    await expect(h.send(write('0x12345679'), marketIntent(marketA))).rejects.toBeInstanceOf(WriteHeldError)
    await expect(h.send(write('0x1234567b'), marketIntent(marketB))).resolves.toMatchObject({ status: 'done' })
    await expect(h.send(write('0xabcdef01'), creationIntent(8453, definition))).resolves.toMatchObject({ status: 'done' })

    await expect(held.handle.exit(unknown, { checkedWallet: true }, h.client as never)).resolves.toMatchObject({ released: true })
    await expect(h.send(write('0x12345679'), marketIntent(marketA))).resolves.toMatchObject({ status: 'done' })
  })

  it('holds one creation by its definition while a different definition proceeds', async () => {
    confirmEveryReview()
    const h = harness()
    h.setReply(async () => { throw new Error('The wallet connection closed.') })
    await expect(h.send(write('0xabcdef01'), creationIntent(8453, definition))).rejects.toThrow()
    h.setReply(h.mine)
    await expect(h.send(write('0xabcdef01'), creationIntent(8453, definition))).rejects.toBeInstanceOf(WriteHeldError)
    await expect(h.send(write('0xabcdef02'), creationIntent(8453, { ...definition, prompt: 'ETH?' }))).resolves.toMatchObject({ status: 'done' })
  })

  it('releases a market whose sent write the wallet replaced with a cancellation, once a final block proves it', async () => {
    confirmEveryReview()
    const h = harness()
    const lost = `0x${'ab'.repeat(32)}` as Hex
    // The wallet took the write under the market's hold and returned its hash.
    const sent = reviewedAction(write('0x12345678'), marketIntent(marketA)).calls[0]
    await openStepHold(h.hold, account, false, sent).send(h.client as never, async gate => { await gate.beforeSend(); gate.afterSubmit(lost); return lost })
    h.chain.txs.push({ hash: lost, nonce: 7, to: terminal, input: '0x12345678', value: 7n })
    await expect(h.send(write('0x12345678'), marketIntent(marketA))).rejects.toBeInstanceOf(WriteHeldError)
    await expect(h.heldUnder(marketIntent(marketA))!.handle.state(h.client as never)).resolves.toMatchObject({ status: 'pending-known-hash' })
    // The wallet's cancel used nonce 7 with other calldata in a final block; the node still lists the original.
    h.chain.head = 120n
    h.chain.finalized = 110n
    h.chain.txs.push({ hash: `0x${'cd'.repeat(32)}`, nonce: 7, to: account, input: '0x', value: 0n, block: 105n })
    const held = h.heldUnder(marketIntent(marketA))!
    const state = await held.handle.state(h.client as never)
    expect(state).toMatchObject({ status: 'dropped-proven', exit: true })
    await expect(held.handle.exit(state, { checkedWallet: true }, h.client as never)).resolves.toMatchObject({ released: true })
    await expect(h.send(write('0x12345678'), marketIntent(marketA))).resolves.toMatchObject({ status: 'done' })
  })
})

describe('a run\'s outcome for its form', () => {
  const mined = { transactionHash: `0x${'ab'.repeat(32)}`, status: 'success', logs: [] } as unknown as TransactionReceipt
  const noReceipt = { getTransactionReceipt: async () => { throw new Error('unused') } }

  it('returns a mined write as its outcome once its effects apply, with nothing to report', async () => {
    const apply = vi.fn(async () => {})
    const report = vi.fn()
    const done = { status: 'done' as const, hashes: [mined.transactionHash], receipts: [mined] }
    await expect(runOutcome(done, noReceipt, apply, report)).resolves.toBe(mined)
    expect(apply).toHaveBeenCalledWith(mined)
    expect(report).not.toHaveBeenCalled()
  })

  it('reports a mined write whose receipt could not be read, instead of failing its form', async () => {
    const report = vi.fn()
    const done = { status: 'done' as const, hashes: [mined.transactionHash], receipts: [] }
    const unread = { getTransactionReceipt: async () => { throw new Error('The RPC timed out.') } }
    await expect(runOutcome(done, unread, async () => {}, report)).resolves.toBeNull()
    expect(report).toHaveBeenCalledWith(expect.stringContaining('The RPC timed out.'))
  })

  it('hands a still-confirming write back to its form at once, and applies its later settlement', async () => {
    const apply = vi.fn(async () => {})
    let settle!: (done: { status: 'done'; hashes: Hex[]; receipts: TransactionReceipt[] }) => void
    const ended = new Promise<{ status: 'done'; hashes: Hex[]; receipts: TransactionReceipt[] }>(resolve => { settle = resolve })
    const confirming = { status: 'receipt' as const, step: 0, hash: mined.transactionHash, ended: () => ended }
    const handed = runOutcome(confirming, noReceipt, apply, vi.fn())
    await expect(Promise.race([handed, new Promise(resolve => setTimeout(resolve, 50, 'still waiting'))])).resolves.toBeNull()
    settle({ status: 'done', hashes: [mined.transactionHash], receipts: [mined] })
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(mined))
  })
})

describe('one handoff to the shared runner at a time', () => {
  it('refuses a second handoff while one reviews or sends, and takes the next once it ends', async () => {
    const open = { current: false }
    let finish!: () => void
    const first = exclusive(open, () => new Promise<string>(resolve => { finish = () => resolve('first') }))
    await expect(exclusive(open, async () => 'second')).rejects.toThrow(REVIEWED_RUN_BUSY_LINE)
    finish()
    await expect(first).resolves.toBe('first')
    await expect(exclusive(open, async () => 'third')).resolves.toBe('third')
  })
})
