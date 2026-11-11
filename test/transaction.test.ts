import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import { openStepHold, WriteHeldError } from '@bananapus/nana-sdk-core/review'
import { creationIntent, marketIntent, reviewedAction } from '../src/lib/transaction'
import { account, confirmEveryReview, definition, harness, marketA, marketB, terminal, write } from './hold-harness'

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
