import { afterEach, describe, expect, it, vi } from 'vitest'
import { numberToHex, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import {
  createHeldWriteStorage, createWriteHold, followHeldWrite, openStepHold, registerReviewHandler, sendReviewed, WriteHeldError, type WalletAdapter,
} from '@bananapus/nana-sdk-core/review'
import type { MarketDefinition } from '../src/domain/market'
import { REVIEWED_RUN_BUSY_LINE } from '@bananapus/nana-sdk-core/review/react'
import {
  creationIntent, exclusive, formRuns, heldWrite, marketIntent, refuseStale, reviewedAction, runOutcome, type PreparedTransaction,
} from '../src/lib/transaction'

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

  it('completes the form that sent a handed-back write once its hold settles, through a refused retry', async () => {
    confirmEveryReview()
    const h = harness()
    const intent = marketIntent(marketA)
    // The wallet took the write under the market's hold and returned its hash; it waits in the mempool, and the run
    // handed it back. A later run (the retry below) replaces that run, so its ended() resolves null.
    const sent = numberToHex(99, { size: 32 })
    const handle = openStepHold(h.hold, account, false, reviewedAction(write('0x12345678'), intent).calls[0])
    await handle.send(h.client as never, async gate => { await gate.beforeSend(); gate.afterSubmit(sent); return sent })
    h.chain.txs.push({ hash: sent, nonce: 7, to: terminal, input: '0x12345678', value: 7n })
    const handedBack = { status: 'receipt' as const, step: 0, hash: sent, ended: async () => null }
    const stop = new AbortController()
    const order: string[] = []
    const form = { sent: vi.fn(), handedBack: vi.fn(), complete: vi.fn(), stale: () => false, later: vi.fn(async () => { order.push('form') }) }
    const outcome = runOutcome(handedBack, h.client as never, async () => { order.push('apply') }, vi.fn(), form,
      heldWrite(handle, h.client as never, { signal: stop.signal, pollMs: 5 }))
    await expect(outcome).resolves.toBeNull()
    expect(form.sent).toHaveBeenCalledTimes(1)
    // A retry of the same transfer is refused by the hold and sends nothing.
    await expect(h.send(write('0x12345678'), intent)).rejects.toBeInstanceOf(WriteHeldError)
    // The original mines: its form completes once, after the app's effects.
    h.chain.head += 1n
    h.chain.txs.find(tx => tx.hash === sent)!.block = h.chain.head
    await vi.waitFor(() => expect(form.later).toHaveBeenCalledTimes(1), { timeout: 5_000 })
    expect(order).toEqual(['apply', 'form'])
    stop.abort()
  })

  it('completes the form from its own settlement after another reader acknowledged it and a new reservation replaced it', async () => {
    confirmEveryReview()
    const h = harness()
    const intent = marketIntent(marketA)
    const call = reviewedAction(write('0x12345678'), intent).calls[0]
    const sent = numberToHex(99, { size: 32 })
    const handle = openStepHold(h.hold, account, false, call)
    await handle.send(h.client as never, async gate => { await gate.beforeSend(); gate.afterSubmit(sent); return sent })
    h.chain.txs.push({ hash: sent, nonce: 7, to: terminal, input: '0x12345678', value: 7n })
    const handedBack = { status: 'receipt' as const, step: 0, hash: sent, ended: async () => null }
    const stop = new AbortController()
    const form = { sent: vi.fn(), handedBack: vi.fn(), complete: vi.fn(), stale: () => false, later: vi.fn(async () => {}) }
    await runOutcome(handedBack, h.client as never, async () => {}, vi.fn(), form,
      heldWrite(handle, h.client as never, { signal: stop.signal }))
    await new Promise(resolve => setTimeout(resolve, 200)) // the follow's first look ends; its next is seconds away
    // Between this follow's looks the original mines; another reader of the hold (the held-writes notice) settles and
    // acknowledges it, and another form reserves the market for a send the wallet then rejects.
    h.chain.head += 1n
    h.chain.txs.find(tx => tx.hash === sent)!.block = h.chain.head
    const other = openStepHold(h.hold, account, false, call)
    const cleared = await followHeldWrite(other, h.client as never, { signal: stop.signal, fastMs: 5 })
    expect(cleared?.status === 'clear' && cleared.settled?.result).toBe('success')
    if (cleared?.status === 'clear' && cleared.settled && 'hash' in cleared.settled) await other.acknowledge(cleared.settled)
    h.setReply(async () => { throw Object.assign(new Error('User rejected the request.'), { code: 4001 }) })
    const rejected = await h.send(write('0x12345678'), intent).catch(cause => cause)
    expect(rejected).toBeInstanceOf(Error)
    expect(rejected).not.toBeInstanceOf(WriteHeldError)
    // The original's form still completes, once.
    await vi.waitFor(() => expect(form.later).toHaveBeenCalledTimes(1), { timeout: 6_000 })
    stop.abort()
  }, 10_000)
})

describe('a handed-back write settled in another tab', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('completes its form after another tab settled, acknowledged and replaced it while this tab slept', async () => {
    confirmEveryReview()
    const h = harness()
    const intent = marketIntent(marketA)
    const call = reviewedAction(write('0x12345678'), intent).calls[0]
    // Two tabs, each with its own memory and hold, share one browser storage. Its events wait until this tab wakes.
    const shared = new Map<string, string>()
    const queued: string[] = []
    const durable = {
      getItem: (key: string) => shared.get(key) ?? null,
      setItem: (key: string, value: string) => { shared.set(key, value); queued.push(key) },
      removeItem: (key: string) => { shared.delete(key); queued.push(key) },
    }
    const listeners = new Set<(event: { key: string }) => void>()
    vi.stubGlobal('addEventListener', (type: string, listener: (event: { key: string }) => void) => { if (type === 'storage') listeners.add(listener) })
    vi.stubGlobal('removeEventListener', (_type: string, listener: (event: { key: string }) => void) => { listeners.delete(listener) })
    const tab = () => createWriteHold({ storage: createHeldWriteStorage({ durable: () => durable, memory: new Map() }) })
    const here = tab(), there = tab()
    const sent = numberToHex(99, { size: 32 })
    const handle = openStepHold(here, account, false, call)
    await handle.send(h.client as never, async gate => { await gate.beforeSend(); gate.afterSubmit(sent); return sent })
    h.chain.txs.push({ hash: sent, nonce: 7, to: terminal, input: '0x12345678', value: 7n })
    const stop = new AbortController()
    const form = { sent: vi.fn(), handedBack: vi.fn(), complete: vi.fn(), stale: () => false, later: vi.fn(async () => {}) }
    await runOutcome({ status: 'receipt', step: 0, hash: sent, ended: async () => null }, h.client as never, async () => {}, vi.fn(), form,
      heldWrite(openStepHold(here, account, false, call), h.client as never, { signal: stop.signal }))
    await new Promise(resolve => setTimeout(resolve, 200)) // this tab's first look ends; it sleeps until the next
    queued.length = 0
    // The other tab sees the write mine, settles and acknowledges it, then reserves the market for a send the wallet rejects.
    h.chain.head += 1n
    h.chain.txs.find(tx => tx.hash === sent)!.block = h.chain.head
    const other = openStepHold(there, account, false, call)
    const cleared = await followHeldWrite(other, h.client as never, { signal: stop.signal, fastMs: 5 })
    if (cleared?.status === 'clear' && cleared.settled && 'hash' in cleared.settled) await other.acknowledge(cleared.settled)
    h.setReply(async () => { throw Object.assign(new Error('User rejected the request.'), { code: 4001 }) })
    const rejected = await sendReviewed(reviewedAction(write('0x12345678'), intent), { adapter: h.adapter, hold: there,
      clientFor: () => h.client as unknown as PublicClient }).catch(cause => cause)
    expect(rejected).not.toBeInstanceOf(WriteHeldError)
    // This tab wakes: its queued events all read the storage as it is now.
    for (const key of queued.splice(0)) for (const listener of listeners) listener({ key })
    await vi.waitFor(() => expect(form.later).toHaveBeenCalledTimes(1), { timeout: 6_000 })
    stop.abort()
  }, 10_000)
})

describe('a retry once the form\'s handed-back write completes', () => {
  /** A form whose first write was handed back still confirming, and the means to retry it and to mine the original. */
  async function handedBackForm(appReceipts?: (client: ReturnType<typeof harness>['client']) => Pick<PublicClient, 'getTransactionReceipt'>) {
    const h = harness()
    const intent = marketIntent(marketA)
    const sent = numberToHex(99, { size: 32 })
    const stop = new AbortController()
    const completed = vi.fn()
    const run = formRuns({ preparing: () => {}, running: () => {}, error: () => {} })
    const handle = openStepHold(h.hold, account, false, reviewedAction(write('0x12345678'), intent).calls[0])
    await run(async () => write('0x12345678'), async (_prepared, form) => {
      await handle.send(h.client as never, async gate => { await gate.beforeSend(); gate.afterSubmit(sent); return sent })
      h.chain.txs.push({ hash: sent, nonce: 7, to: terminal, input: '0x12345678', value: 7n })
      return runOutcome({ status: 'receipt', step: 0, hash: sent, ended: async () => null }, (appReceipts?.(h.client) ?? h.client) as never,
        async () => {}, vi.fn(), form,
        heldWrite(handle, h.client as never, { signal: stop.signal, pollMs: 5 }))
    }, completed, 'failed')
    await new Promise(resolve => setTimeout(resolve, 200)) // the follow's first look ends
    const mineOriginal = () => { h.chain.head += 1n; h.chain.txs.find(tx => tx.hash === sent)!.block = h.chain.head }
    /** The retry through the real runner, with the provider's last gate before the wallet. */
    const retry = (prepare: () => Promise<PreparedTransaction>) => run(prepare, (prepared, form) =>
      sendReviewed({ ...reviewedAction(prepared, intent), assertWriteState: () => refuseStale(form) }, { adapter: h.adapter, hold: h.hold,
        clientFor: () => h.client as unknown as PublicClient }).then(() => null), completed, 'failed')
    return { h, stop, completed, mineOriginal, retry }
  }

  it('drops a retry still preparing when the original confirms', async () => {
    confirmEveryReview()
    const { h, stop, completed, mineOriginal, retry } = await handedBackForm()
    let prepared!: () => void
    const retried = retry(() => new Promise(resolve => { prepared = () => resolve(write('0x12345678')) }))
    mineOriginal()
    await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1), { timeout: 6_000 })
    prepared()
    await retried
    expect(h.adapter.sendTransaction).not.toHaveBeenCalled()
    stop.abort()
  }, 10_000)

  it('refuses a retry started after the original settled while the app still reads its receipt', async () => {
    confirmEveryReview()
    // The app's own receipt read for the original (after its hold settled it) waits until the test lets it through.
    let reading!: () => void
    let read!: () => void
    const atRead = new Promise<void>(resolve => { reading = resolve })
    const { h, stop, completed, mineOriginal, retry } = await handedBackForm(client => ({
      getTransactionReceipt: async args => { reading(); await new Promise<void>(resolve => { read = resolve }); return client.getTransactionReceipt(args) },
    }))
    mineOriginal()
    await atRead
    await retry(async () => write('0x12345678'))
    expect(h.adapter.sendTransaction).not.toHaveBeenCalled()
    read()
    await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1), { timeout: 2_000 })
    stop.abort()
  }, 10_000)

  it('drops a retry already past preparation when the original confirms before its wallet opens', async () => {
    confirmEveryReview()
    const { h, stop, completed, mineOriginal, retry } = await handedBackForm()
    // The retry waits for its wallet to be ready while the original confirms: it reaches its hold once that write is
    // settled and shown, and its review opens.
    let readying!: () => void
    let ready!: () => void
    const atReady = new Promise<void>(resolve => { readying = resolve })
    h.adapter.ready = () => { readying(); return new Promise<void>(resolve => { ready = resolve }) }
    const retried = retry(async () => write('0x12345678'))
    await atReady
    mineOriginal()
    await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1), { timeout: 6_000 })
    ready()
    await retried
    expect(h.adapter.sendTransaction).not.toHaveBeenCalled()
    stop.abort()
  }, 10_000)
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
