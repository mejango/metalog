// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { numberToHex, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import type { UseReviewedRunDeps } from '@bananapus/nana-sdk-core/review/react'
import { lapsingLocksForTests } from '@bananapus/nana-sdk-core/testing'
import { useFormWrite } from '../src/lib/form-write'
import { marketIntent, type PreparedTransaction } from '../src/lib/transaction'
import { account, confirmEveryReview, harness, marketA, write } from './hold-harness'

const intent = marketIntent(marketA)
const other = '0x0000000000000000000000000000000000000033' as Address
const engine = () => import('@bananapus/nana-sdk-core/review')
const lost = numberToHex(99, { size: 32 })

afterEach(() => { vi.unstubAllGlobals() })

/**
 * A chain and wallet whose next send broadcasts and loses its reply, and forms that run through core's useReviewedRun,
 * with the browser's Web Locks standing in as core's lapsing test locks.
 */
function setup() {
  vi.stubGlobal('navigator', { ...navigator, locks: lapsingLocksForTests().locks })
  const h = harness()
  let connected = account
  h.adapter.account = () => connected
  h.setReply(async tx => {
    h.chain.txs.push({ hash: lost, nonce: 7, to: tx.to, input: tx.data, value: tx.value, from: connected })
    throw new Error('The wallet connection closed.')
  })
  const base = { adapter: h.adapter, hold: h.hold, clientFor: () => h.client as unknown as PublicClient, engine }
  const depsFor = new Map<Address, UseReviewedRunDeps>([account, other].map(address => [address, { ...base, account: address }]))
  /** The app's receipt read and effects; a test can hold it open. */
  let reading: Promise<void> = Promise.resolve()
  const settle = vi.fn(async (_chainId: number, hash: Hex) => {
    await reading
    return h.client.getTransactionReceipt({ hash }) as unknown as TransactionReceipt
  })
  const form = () => renderHook(({ address }) => useFormWrite({ deps: depsFor.get(address)!, settle }), { initialProps: { address: account } })
  const sends = () => (h.adapter.sendTransaction as ReturnType<typeof vi.fn>).mock.calls.length
  const recoverLost = async (owner = account) => {
    h.chain.head += 1n
    h.chain.txs.find(tx => tx.hash === lost)!.block = h.chain.head
    const held = h.hold.list({ account: owner, chainId: 8453 }).find(item => item.record.namespace === intent)!
    const state = await held.handle.attachHash(h.client as never, lost)
    expect(state).toMatchObject({ status: 'clear' })
    return { handle: held.handle, state }
  }
  return {
    h, settle, form, sends, recoverLost,
    switchTo: (address: Address) => { connected = address },
    holdReading: () => { let open!: () => void; reading = new Promise(resolve => { open = resolve }); return open },
  }
}

const prepared = (address = account): PreparedTransaction => ({ ...write('0x12345678'), account: address })
type Form = ReturnType<ReturnType<typeof setup>['form']>
const submit = (form: Form, done: () => void, prepare = vi.fn(async () => prepared())) =>
  act(() => form.result.current.run(prepare, intent, done, 'failed'))

describe('a form\'s write over core\'s run', () => {
  it('completes once when its lost wallet reply is recovered from the hash; sends refused meanwhile neither send nor complete their form', async () => {
    confirmEveryReview()
    const { h, form, sends, recoverLost } = setup()
    const original = form(), another = form()
    const done = vi.fn(), anotherDone = vi.fn()
    await submit(original, done)
    expect(sends()).toBe(1)
    await expect(h.heldUnder(intent)!.handle.state(h.client as never)).resolves.toMatchObject({ status: 'held-no-hash' })
    // The unchanged form, and another form of the market, send while the write is held: the hold refuses both.
    h.setReply(h.mine)
    await submit(original, done)
    await submit(another, anotherDone)
    expect(sends()).toBe(1)
    expect(original.result.current.runner.error).toBeTruthy()
    // The original mines; the user enters its hash and recovery settles it: its form completes, once.
    await recoverLost()
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 8_000 })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(anotherDone).not.toHaveBeenCalled()
    expect(sends()).toBe(1)
  }, 15_000)

  it('keeps taking submissions after another account\'s newer write completed and the older lost reply is recovered', async () => {
    confirmEveryReview()
    const { h, form, sends, recoverLost, switchTo } = setup()
    const shared = form()
    const done = vi.fn()
    await submit(shared, done)
    // Account B, on the same form, sends and completes.
    switchTo(other)
    shared.rerender({ address: other })
    h.setReply(h.mine)
    await submit(shared, done, vi.fn(async () => prepared(other)))
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 8_000 })
    expect(sends()).toBe(2)
    // Back on A, its write mines and is recovered from its hash.
    switchTo(account)
    shared.rerender({ address: account })
    await recoverLost()
    await new Promise(resolve => setTimeout(resolve, 300))
    // The form still takes its next submission.
    const next = vi.fn(async () => prepared())
    await submit(shared, vi.fn(), next)
    expect(next).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(shared.result.current.busy).toBe(false))
  }, 15_000)
})

describe('one form, two actions on one market', () => {
  it('completes a recovered lost-reply refund with the refund\'s own callback after a delegation was refused', async () => {
    confirmEveryReview()
    const { h, form, sends, recoverLost } = setup()
    const lifecycle = form()
    const refunded = vi.fn(), delegated = vi.fn()
    await submit(lifecycle, refunded)
    expect(sends()).toBe(1)
    // A delegation from the same panel: the market's hold refuses it, nothing is sent.
    h.setReply(h.mine)
    await submit(lifecycle, delegated, vi.fn(async () => ({ ...prepared(), data: '0xabcdef01' as Hex })))
    expect(sends()).toBe(1)
    await recoverLost()
    await waitFor(() => expect(refunded).toHaveBeenCalledTimes(1), { timeout: 8_000 })
    expect(delegated).not.toHaveBeenCalled()
    expect(sends()).toBe(1)
  }, 15_000)
})

describe('two forms queued on one market', () => {
  it('never sends a form\'s lost-reply write twice when another form\'s refused run acknowledged its recovery first', async () => {
    confirmEveryReview()
    const { h, form, sends, recoverLost } = setup()
    const transfer = form(), entry = form()
    const transferred = vi.fn(), entered = vi.fn()
    // Both reviews open before either reserves the market: the transfer broadcasts and loses its reply, then the hold
    // refuses the entry.
    await act(async () => {
      await Promise.all([
        transfer.result.current.run(async () => prepared(), intent, transferred, 'failed'),
        entry.result.current.run(async () => ({ ...prepared(), data: '0xabcdef01' }), intent, entered, 'failed'),
      ])
    })
    expect(sends()).toBe(1)
    h.setReply(h.mine)
    // The transfer is recovered from its hash.
    const { handle, state } = await recoverLost()
    // Another reader (the entry's refused run, say) acknowledges the transfer's success before the transfer's own run does.
    if (state.status === 'clear' && state.settled && 'hash' in state.settled) await handle.acknowledge(state.settled)
    expect(handle.unacknowledgedSuccess()).toBeUndefined()
    // Before the transfer's own run shows it done, the unchanged transfer is sent again: it never reaches the wallet.
    await submit(transfer, transferred)
    expect(sends()).toBe(1)
    await waitFor(() => expect(transferred).toHaveBeenCalledTimes(1), { timeout: 8_000 })
    expect(entered).not.toHaveBeenCalled()
    expect(sends()).toBe(1)
  }, 15_000)
})

describe('a retry while the form\'s held write completes', () => {
  it('drops a retry still preparing when the original confirms', async () => {
    confirmEveryReview()
    const { h, form, sends, recoverLost } = setup()
    const shared = form()
    const done = vi.fn()
    await submit(shared, done)
    h.setReply(h.mine)
    let ready!: () => void
    // Outside act: the retry stays open while the original settles and completes.
    const retried = shared.result.current.run(vi.fn(() => new Promise<PreparedTransaction>(resolve => { ready = () => resolve(prepared()) })),
      intent, done, 'failed')
    await recoverLost()
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 8_000 })
    await act(async () => { ready(); await retried })
    expect(sends()).toBe(1)
  }, 15_000)

  it('refuses a retry started after the original settled while the app still reads its receipt', async () => {
    confirmEveryReview()
    const { h, form, sends, recoverLost, settle, holdReading } = setup()
    const shared = form()
    const done = vi.fn()
    await submit(shared, done)
    h.setReply(h.mine)
    const open = holdReading()
    await recoverLost()
    await waitFor(() => expect(settle).toHaveBeenCalled(), { timeout: 8_000 })
    const retry = vi.fn(async () => prepared())
    await submit(shared, done, retry)
    expect(retry).not.toHaveBeenCalled()
    open()
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 2_000 })
    expect(sends()).toBe(1)
  }, 15_000)

  it('refuses a retry while the original is held, and the original still completes the form', async () => {
    confirmEveryReview()
    const { h, form, sends, recoverLost } = setup()
    const shared = form()
    const done = vi.fn()
    await submit(shared, done)
    h.setReply(h.mine)
    const retry = vi.fn(async () => prepared())
    await submit(shared, done, retry)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(sends()).toBe(1)
    await recoverLost()
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 8_000 })
    expect(sends()).toBe(1)
  }, 15_000)
})
