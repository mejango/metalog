import { describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, type Address, type Hex, type TransactionReceipt } from 'viem'
import { nativeCreationRequest } from './fixtures/transaction-requests'
import { DEFIFA_ABI, deploymentForChain } from '../src/lib/defifa-deployment'
import {
  executeTransaction, readPendingTransaction, recoverTransaction, TRANSACTION_STORAGE_KEY,
  creationAttemptStorage, marketAttemptStorage, readPendingAttempts, pendingBlocksMarket, pendingBlocksNewCreation, TRANSACTION_JOURNAL_STORAGE_KEY, selectedTransactionStatus,
  type PreparedTransaction, type TransactionRuntime, type WalletIdentity,
} from '../src/lib/transaction'

const account = '0x0000000000000000000000000000000000000011' as Address
const to = '0x0000000000000000000000000000000000000022' as Address
const hash = `0x${'ab'.repeat(32)}` as Hex
const blockHash = `0x${'cd'.repeat(32)}` as Hex
const request: PreparedTransaction = { chainId: 8453, account, to, data: '0x12345678', value: 7n, title: 'Enter market', details: [{ label: 'Positions', value: '7' }], verifyReceipt: () => {} }

function harness() {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  const wallet: WalletIdentity = { address: account, chainId: 8453, connectorUid: 'injected-1', isSigna: false }
  const receipt = { from: account, to, transactionHash: hash, blockHash, blockNumber: 11n, status: 'success' } as TransactionReceipt
  const client = {
    chain: { id: 8453 }, request: vi.fn(async () => '0x'), estimateGas: vi.fn(async () => 100n), getBlockNumber: vi.fn(async () => 10n),
    getBlock: vi.fn(async () => ({ hash: blockHash })),
    getTransaction: vi.fn(async () => ({ chainId: 8453, hash, from: account, to, input: request.data, value: request.value })),
    getTransactionReceipt: vi.fn(async () => receipt), waitForTransactionReceipt: vi.fn(async () => receipt),
  }
  const runtime: TransactionRuntime = { storage, client: client as unknown as TransactionRuntime['client'], identity: () => wallet,
    review: vi.fn(async () => true), switchChain: vi.fn(async chainId => { wallet.chainId = chainId }),
    send: vi.fn(async () => hash), onStatus: vi.fn() }
  return { runtime, storage, client, receipt, wallet, values }
}

describe('reviewed transaction boundary', () => {
  it('saves uncertainty before invoking the wallet and checks exact receipt effects', async () => {
    const h = harness()
    h.runtime.send = vi.fn(async sent => {
      expect(readPendingTransaction(h.storage)).toMatchObject({ account, to, data: request.data, value: '7', phase: 'unknown' })
      expect(sent).toMatchObject({ account, to, data: request.data, value: 7n, gas: 200n })
      return hash
    })
    const verifyReceipt = vi.fn()
    expect(await executeTransaction({ ...request, verifyReceipt }, h.runtime)).toEqual(h.receipt)
    expect(verifyReceipt).toHaveBeenCalledWith(h.receipt)
    expect(readPendingTransaction(h.storage)).toBeNull()
  })

  it('never sends a declined review or failed simulation', async () => {
    const cancelled = harness()
    cancelled.runtime.review = async () => false
    await expect(executeTransaction(request, cancelled.runtime)).rejects.toThrow()
    expect(cancelled.runtime.send).not.toHaveBeenCalled()
    expect(readPendingTransaction(cancelled.storage)).toBeNull()
    const failed = harness()
    failed.client.request.mockRejectedValue(new Error('entry closed'))
    await expect(executeTransaction(request, failed.runtime)).rejects.toThrow('entry closed')
    expect(failed.runtime.send).not.toHaveBeenCalled()
  })

  it.each(['address', 'chainId', 'connectorUid', 'isSigna'] as const)('rechecks %s after durable preparation and clears only the unsent record', async field => {
    const h = harness()
    h.client.getBlockNumber.mockImplementation(async () => {
      Object.assign(h.wallet, { [field]: field === 'address' ? to : field === 'chainId' ? 1 : field === 'connectorUid' ? 'injected-2' : true })
      return 10n
    })
    await expect(executeTransaction(request, h.runtime)).rejects.toThrow(/changed/)
    expect(h.runtime.send).not.toHaveBeenCalled()
    expect(readPendingTransaction(h.storage)).toBeNull()
  })

  it('keeps ambiguous submissions locked across reload and only observes recovery', async () => {
    const h = harness()
    h.runtime.send = vi.fn(async () => { throw new Error('wallet response timed out') })
    await expect(executeTransaction(request, h.runtime)).rejects.toThrow('timed out')
    expect(readPendingTransaction(h.storage)?.phase).toBe('unknown')
    await expect(executeTransaction(request, h.runtime)).rejects.toThrow('pending transaction')
    await expect(recoverTransaction(h.runtime, undefined, request)).rejects.toThrow('original transaction hash')
    expect(await recoverTransaction(h.runtime, hash, request)).toEqual(h.receipt)
    expect(h.runtime.send).toHaveBeenCalledTimes(1)
    expect(readPendingTransaction(h.storage)).toBeNull()
  })

  it('releases the record only for explicit wallet rejection', async () => {
    const h = harness()
    h.runtime.send = async () => { throw Object.assign(new Error('Rejected'), { code: 4001 }) }
    await expect(executeTransaction(request, h.runtime)).rejects.toThrow('Rejected')
    expect(readPendingTransaction(h.storage)).toBeNull()
  })

  it('preserves known hashes when confirmation is unavailable and never resends', async () => {
    const h = harness()
    h.client.waitForTransactionReceipt.mockRejectedValue(new Error('offline'))
    h.client.getTransactionReceipt.mockRejectedValue(new Error('offline'))
    await expect(executeTransaction(request, h.runtime)).rejects.toThrow('confirmation tracking')
    expect(readPendingTransaction(h.storage)).toMatchObject({ phase: 'pending', hash })
    h.client.waitForTransactionReceipt.mockResolvedValue(h.receipt)
    await recoverTransaction(h.runtime, undefined, request)
    expect(h.runtime.send).toHaveBeenCalledTimes(1)
  })

  it.each(['calldata', 'account', 'value', 'network', 'block', 'old receipt'])('refuses incorrect %s evidence while retaining its record', async kind => {
    const h = harness()
    if (kind === 'calldata') h.client.getTransaction.mockResolvedValue({ chainId: 8453, hash, from: account, to, input: '0x9999', value: 7n })
    if (kind === 'account') h.client.getTransaction.mockResolvedValue({ chainId: 8453, hash, from: to, to, input: request.data, value: 7n })
    if (kind === 'value') h.client.getTransaction.mockResolvedValue({ chainId: 8453, hash, from: account, to, input: request.data, value: 8n })
    if (kind === 'network') h.client.getTransaction.mockResolvedValue({ chainId: 1, hash, from: account, to, input: request.data, value: 7n })
    if (kind === 'block') h.client.getBlock.mockResolvedValue({ hash })
    if (kind === 'old receipt') h.client.waitForTransactionReceipt.mockResolvedValue({ ...h.receipt, blockNumber: 10n })
    await expect(executeTransaction(request, h.runtime)).rejects.toThrow(/receipt/)
    expect(readPendingTransaction(h.storage)?.hash).toBe(hash)
  })

  it('retains the exact call when its Defifa effect verifier cannot establish success', async () => {
    const h = harness()
    const verifyReceipt = vi.fn(() => { throw new Error('Expected mints are missing') })
    await expect(executeTransaction({ ...request, verifyReceipt }, h.runtime)).rejects.toThrow('mints')
    expect(readPendingTransaction(h.storage)?.hash).toBe(hash)
    await expect(recoverTransaction(h.runtime, hash, { ...request, value: 8n })).rejects.toThrow('differs')
    await expect(recoverTransaction(h.runtime, hash)).rejects.toThrow('effect verifier')
    const restored = { ...request, verifyReceipt: vi.fn(() => { throw new Error('Recovered mints are missing') }) }
    await expect(recoverTransaction(h.runtime, hash, restored)).rejects.toThrow('Recovered mints')
    expect(restored.verifyReceipt).toHaveBeenCalledWith(h.receipt)
    expect(readPendingTransaction(h.storage)?.hash).toBe(hash)
    const verified = { ...request, verifyReceipt: vi.fn() }
    await recoverTransaction(h.runtime, hash, verified)
    expect(verified.verifyReceipt).toHaveBeenCalledWith(h.receipt)
    expect(readPendingTransaction(h.storage)).toBeNull()
  })

  it('refuses to send an action without a deterministic effect check', async () => {
    const h = harness()
    await expect(executeTransaction({ ...request, verifyReceipt: undefined }, h.runtime)).rejects.toThrow('effect verifier')
    expect(h.runtime.send).not.toHaveBeenCalled()
  })

  it('fails before sending when durable storage is unavailable or corrupt', async () => {
    const h = harness()
    h.storage.setItem = () => { throw new Error('Storage full') }
    await expect(executeTransaction(request, h.runtime)).rejects.toThrow('Storage full')
    expect(h.runtime.send).not.toHaveBeenCalled()
    h.values.set(TRANSACTION_STORAGE_KEY, '{broken')
    await expect(executeTransaction(request, h.runtime)).rejects.toThrow('saved transaction cannot be read')
    expect(h.runtime.send).not.toHaveBeenCalled()
  })

  it('does not offer arbitrary transaction authority to a Signa connection', async () => {
    const h = harness()
    h.wallet.isSigna = true
    await expect(executeTransaction(request, h.runtime)).rejects.toThrow('external wallet')
    expect(h.runtime.review).not.toHaveBeenCalled()
    expect(h.runtime.send).not.toHaveBeenCalled()
  })
})


describe('independent new-market intent', () => {
  const firstId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const nextId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  const creation = { ...request, ...nativeCreationRequest, title: 'Create market' }
  async function legacyPending(h: ReturnType<typeof harness>) {
    h.receipt.to = creation.to
    h.client.getTransaction.mockResolvedValue({ chainId: 8453, hash, from: account, to: creation.to, input: creation.data, value: creation.value })
    h.runtime.send = vi.fn(async () => { throw new Error('lost wallet reply') })
    await expect(executeTransaction(creation, h.runtime)).rejects.toThrow('lost wallet reply')
    return h.storage.getItem(TRANSACTION_STORAGE_KEY)
  }

  it('lets a new market proceed without replacing earlier evidence and keeps normal actions blocked', async () => {
    const h = harness(), original = await legacyPending(h)
    const storage = creationAttemptStorage(h.storage, firstId)
    h.runtime.send = vi.fn(async () => hash)
    expect(await executeTransaction(creation, { ...h.runtime, storage })).toEqual(h.receipt)
    expect(h.runtime.send).toHaveBeenCalledTimes(1)
    expect(h.storage.getItem(TRANSACTION_STORAGE_KEY)).toBe(original)
    expect(readPendingAttempts(h.storage)).toHaveLength(1)
    await expect(executeTransaction(request, h.runtime)).rejects.toThrow('pending transaction')
  })

  it('does not label an older unresolved transaction confirmed after a new market succeeds', async () => {
    const h = harness()
    await legacyPending(h)
    const statuses: string[] = []
    h.runtime.send = vi.fn(async () => hash)
    const storage = creationAttemptStorage(h.storage, firstId)
    await executeTransaction(creation, { ...h.runtime, storage, onStatus: status => statuses.push(status) })
    expect(statuses.at(-1)).toBe('success')
    const selected = readPendingAttempts(h.storage)[0].transaction
    expect(selectedTransactionStatus('success', false, selected)).toBe('unknown')
    expect(selectedTransactionStatus('success', false, null)).toBe('success')
    expect(readPendingTransaction(h.storage)).toEqual(selected)
  })

  it('persists separate uncertainty across reload and refuses a resend of the same attempt', async () => {
    const h = harness(), original = await legacyPending(h)
    for (const id of [firstId, nextId]) {
      const storage = creationAttemptStorage(h.storage, id)
      await expect(executeTransaction(creation, { ...h.runtime, storage })).rejects.toThrow('lost wallet reply')
    }
    const records = readPendingAttempts(h.storage)
    expect(records).toHaveLength(3)
    expect(new Set(records.map(record => record.transaction.id)).size).toBe(3)
    const reload = creationAttemptStorage(h.storage, firstId)
    await expect(executeTransaction(creation, { ...h.runtime, storage: reload })).rejects.toThrow('pending transaction')
    expect(h.runtime.send).toHaveBeenCalledTimes(3)
    await expect(recoverTransaction({ ...h.runtime, storage: reload }, hash, { ...creation, value: 8n })).rejects.toThrow('differs')
    await recoverTransaction({ ...h.runtime, storage: reload }, hash, creation)
    expect(readPendingAttempts(h.storage).map(record => record.attemptId)).toEqual([null, nextId])
    expect(h.storage.getItem(TRANSACTION_STORAGE_KEY)).toBe(original)
    expect(h.runtime.send).toHaveBeenCalledTimes(3)
  })

  it('saves one record and sends once when the same intent is submitted concurrently', async () => {
    const h = harness()
    h.runtime.send = vi.fn(async () => { throw new Error('lost wallet reply') })
    const storage = creationAttemptStorage(h.storage, firstId)
    await Promise.allSettled([executeTransaction(creation, { ...h.runtime, storage }), executeTransaction(creation, { ...h.runtime, storage })])
    expect(h.runtime.send).toHaveBeenCalledTimes(1)
    expect(readPendingAttempts(h.storage)).toHaveLength(1)
  })

  it('keeps a creation record when its receipt proves another call', async () => {
    const h = harness(), original = await legacyPending(h)
    h.runtime.send = vi.fn(async () => hash)
    h.client.getTransaction.mockResolvedValue({ chainId: 8453, hash, from: account, to, input: '0x9999', value: 7n })
    const storage = creationAttemptStorage(h.storage, firstId)
    await expect(executeTransaction(creation, { ...h.runtime, storage })).rejects.toThrow('exact reviewed transaction')
    expect(readPendingTransaction(storage)?.hash).toBe(hash)
    expect(h.storage.getItem(TRANSACTION_STORAGE_KEY)).toBe(original)
    expect(readPendingAttempts(h.storage)).toHaveLength(2)
  })

  it('does not allow non-creation transactions to use an independent intent', async () => {
    const h = harness()
    await expect(executeTransaction(request, { ...h.runtime, storage: creationAttemptStorage(h.storage, firstId) })).rejects.toThrow('require a native market creation')
    expect(h.runtime.send).not.toHaveBeenCalled()
    expect(readPendingAttempts(h.storage)).toEqual([])
  })

  it('retains all evidence if the creation journal cannot persist or read back', async () => {
    const h = harness(), original = await legacyPending(h)
    const storage = creationAttemptStorage(h.storage, firstId)
    h.storage.setItem = () => { throw new Error('Storage full') }
    await expect(executeTransaction(creation, { ...h.runtime, storage })).rejects.toThrow('Storage full')
    expect(h.runtime.send).toHaveBeenCalledTimes(1)
    expect(h.storage.getItem(TRANSACTION_STORAGE_KEY)).toBe(original)
    h.storage.setItem = () => {}
    await expect(executeTransaction(creation, { ...h.runtime, storage })).rejects.toThrow('could not be saved')
    expect(h.runtime.send).toHaveBeenCalledTimes(1)
    expect(h.storage.getItem(TRANSACTION_STORAGE_KEY)).toBe(original)
  })

  it('refuses timestamps that cannot be displayed without destroying their original evidence', async () => {
    const h = harness()
    await legacyPending(h)
    const record = readPendingTransaction(h.storage)!
    for (const createdAt of [8_640_000_000_000_001, Number.MAX_SAFE_INTEGER]) {
      const raw = JSON.stringify({ ...record, createdAt })
      h.values.set(TRANSACTION_STORAGE_KEY, raw)
      expect(() => readPendingTransaction(h.storage)).toThrow('cannot be read')
      expect(h.storage.getItem(TRANSACTION_STORAGE_KEY)).toBe(raw)
      h.values.delete(TRANSACTION_STORAGE_KEY)
      h.values.set(TRANSACTION_JOURNAL_STORAGE_KEY, JSON.stringify({ [firstId]: { ...record, title: 'Create market', createdAt } }))
      expect(() => readPendingAttempts(h.storage)).toThrow('cannot be read')
      h.values.delete(TRANSACTION_JOURNAL_STORAGE_KEY)
    }
    h.values.set(TRANSACTION_STORAGE_KEY, JSON.stringify({ ...record, createdAt: 8_640_000_000_000_000 }))
    expect(readPendingTransaction(h.storage)?.createdAt).toBe(8_640_000_000_000_000)
  })

  it('fails closed on invalid journals without deleting the valid legacy record', async () => {
    const h = harness(), original = await legacyPending(h)
    h.values.set(TRANSACTION_JOURNAL_STORAGE_KEY, '{bad')
    expect(() => creationAttemptStorage(h.storage, firstId)).toThrow('cannot be read')
    await expect(executeTransaction(request, h.runtime)).rejects.toThrow('cannot be read')
    expect(h.storage.getItem(TRANSACTION_STORAGE_KEY)).toBe(original)
    expect(h.runtime.send).toHaveBeenCalledTimes(1)
  })

  it('checks the record cap before sending an additional creation', async () => {
    const h = harness()
    await legacyPending(h)
    const record = readPendingTransaction(h.storage)!
    const journal = Object.fromEntries(Array.from({ length: 100 }, (_, index) => {
      const id = `${index.toString(16).padStart(8, '0')}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`
      return [id, { ...record, id, title: 'Create market' }]
    }))
    h.values.set(TRANSACTION_JOURNAL_STORAGE_KEY, JSON.stringify(journal))
    const storage = creationAttemptStorage(h.storage, firstId)
    await expect(executeTransaction(creation, { ...h.runtime, storage })).rejects.toThrow('Too many unresolved')
    expect(readPendingAttempts(h.storage)).toHaveLength(101)
    expect(h.runtime.send).toHaveBeenCalledTimes(1)
  })
})


describe('independent market action intents', () => {
  const hook = '0x0000000000000000000000000000000000000044' as Address
  const a = { chainId: 8453, projectId: '27', hook }
  const b = { ...a, projectId: '28', hook: '0x0000000000000000000000000000000000000055' as Address }
  const entry = (projectId: string): PreparedTransaction => ({ ...request, to: deploymentForChain(8453).terminal,
    data: encodeFunctionData({ abi: DEFIFA_ABI.JBMultiTerminal, functionName: 'pay', args: [BigInt(projectId), account, 7n, account, 0n, '', '0x'] }) })
  async function pendingEntry(h: ReturnType<typeof harness>, scope = a) {
    h.runtime.send = vi.fn(async () => { throw new Error('lost market reply') })
    await expect(executeTransaction(entry(scope.projectId), { ...h.runtime, storage: marketAttemptStorage(h.storage, scope) })).rejects.toThrow('lost market reply')
  }

  it('allows market B while an action on A is uncertain, and keeps A blocked after draft changes', async () => {
    const h = harness()
    await pendingEntry(h)
    const original = h.storage.getItem(TRANSACTION_JOURNAL_STORAGE_KEY)
    expect(pendingBlocksMarket(readPendingAttempts(h.storage), a)).toBe(true)
    expect(pendingBlocksMarket(readPendingAttempts(h.storage), b)).toBe(false)
    const transaction = entry(b.projectId)
    h.receipt.to = transaction.to
    h.client.getTransaction.mockResolvedValue({ chainId: 8453, hash, from: account, to: transaction.to, input: transaction.data, value: transaction.value })
    h.runtime.send = vi.fn(async () => hash)
    await executeTransaction(transaction, { ...h.runtime, storage: marketAttemptStorage(h.storage, b) })
    expect(h.runtime.send).toHaveBeenCalledTimes(1)
    expect(h.storage.getItem(TRANSACTION_JOURNAL_STORAGE_KEY)).toBe(original)
    const changed = { ...entry(a.projectId), value: 8n }
    await expect(executeTransaction(changed, { ...h.runtime, storage: marketAttemptStorage(h.storage, a) })).rejects.toThrow('pending transaction')
    expect(h.runtime.send).toHaveBeenCalledTimes(1)
  })

  it('permits a new market entry with earlier native creation uncertainty, preserving its legacy record', async () => {
    const h = harness()
    h.runtime.send = vi.fn(async () => { throw new Error('lost creation reply') })
    await expect(executeTransaction({ ...request, ...nativeCreationRequest }, h.runtime)).rejects.toThrow('lost creation reply')
    const original = h.storage.getItem(TRANSACTION_STORAGE_KEY)
    expect(pendingBlocksMarket(readPendingAttempts(h.storage), b)).toBe(false)
    expect(pendingBlocksNewCreation(readPendingAttempts(h.storage))).toBe(false)
    await pendingEntry(h, b)
    expect(h.storage.getItem(TRANSACTION_STORAGE_KEY)).toBe(original)
    expect(readPendingAttempts(h.storage)).toHaveLength(2)
  })

  it('does not trust titles or project labels on unrecognized legacy calldata', async () => {
    const h = harness()
    h.runtime.send = vi.fn(async () => { throw new Error('unknown reply') })
    await expect(executeTransaction({ ...request, title: 'Create market', details: [{ label: 'Market', value: '28' }] }, h.runtime)).rejects.toThrow('unknown reply')
    expect(pendingBlocksMarket(readPendingAttempts(h.storage), b)).toBe(true)
    expect(pendingBlocksNewCreation(readPendingAttempts(h.storage))).toBe(true)
  })

  it('recovers only the selected market after reload while retaining legacy and another market', async () => {
    const h = harness()
    h.runtime.send = vi.fn(async () => { throw new Error('lost creation reply') })
    await expect(executeTransaction({ ...request, ...nativeCreationRequest }, h.runtime)).rejects.toThrow('lost creation reply')
    const legacy = h.storage.getItem(TRANSACTION_STORAGE_KEY)
    await pendingEntry(h, a)
    await pendingEntry(h, b)
    const transaction = entry(b.projectId)
    h.receipt.to = transaction.to
    h.client.getTransaction.mockResolvedValue({ chainId: 8453, hash, from: account, to: transaction.to, input: transaction.data, value: transaction.value })
    const restored = marketAttemptStorage(h.storage, b)
    expect(await recoverTransaction({ ...h.runtime, storage: restored }, hash, transaction)).toEqual(h.receipt)
    expect(readPendingAttempts(h.storage).map(attempt => attempt.attemptId)).toEqual([null, 'market:8453:27'])
    expect(h.storage.getItem(TRANSACTION_STORAGE_KEY)).toBe(legacy)
    expect(pendingBlocksMarket(readPendingAttempts(h.storage), a)).toBe(true)
    expect(pendingBlocksMarket(readPendingAttempts(h.storage), b)).toBe(false)
    expect(h.runtime.send).toHaveBeenCalledTimes(1)
  })

  it('refuses a forged persisted scope or journal key without deleting its evidence', async () => {
    const h = harness()
    await pendingEntry(h, a)
    const original = JSON.parse(h.storage.getItem(TRANSACTION_JOURNAL_STORAGE_KEY)!)
    for (const forged of [
      { 'market:8453:28': original['market:8453:27'] },
      { 'market:8453:28': { ...original['market:8453:27'], marketScope: b } },
    ]) {
      const raw = JSON.stringify(forged)
      h.values.set(TRANSACTION_JOURNAL_STORAGE_KEY, raw)
      expect(() => readPendingAttempts(h.storage)).toThrow('cannot be read')
      expect(h.storage.getItem(TRANSACTION_JOURNAL_STORAGE_KEY)).toBe(raw)
    }
  })

  it('rejects a mismatched project scope before sending or changing earlier evidence', async () => {
    const h = harness()
    await pendingEntry(h)
    const original = h.storage.getItem(TRANSACTION_JOURNAL_STORAGE_KEY)
    await expect(executeTransaction(entry(a.projectId), { ...h.runtime, storage: marketAttemptStorage(h.storage, b) })).rejects.toThrow('does not belong')
    expect(h.runtime.send).toHaveBeenCalledTimes(1)
    expect(h.storage.getItem(TRANSACTION_JOURNAL_STORAGE_KEY)).toBe(original)
  })

  it('uses the verified hook identity over a forged persisted project label', async () => {
    const h = harness()
    const transfer = { ...request, value: 0n, to: a.hook,
      data: encodeFunctionData({ abi: DEFIFA_ABI.DefifaHook, functionName: 'safeTransferFrom', args: [account, account, 1n, 1n, '0x'] }) }
    h.runtime.send = vi.fn(async () => { throw new Error('lost transfer reply') })
    await expect(executeTransaction(transfer, { ...h.runtime, storage: marketAttemptStorage(h.storage, a) })).rejects.toThrow('lost transfer reply')
    const journal = JSON.parse(h.storage.getItem(TRANSACTION_JOURNAL_STORAGE_KEY)!)
    h.values.set(TRANSACTION_JOURNAL_STORAGE_KEY, JSON.stringify({ 'market:8453:28': {
      ...journal['market:8453:27'], marketScope: { ...b, hook: a.hook },
    } }))
    expect(pendingBlocksMarket(readPendingAttempts(h.storage), a)).toBe(true)
  })
})
