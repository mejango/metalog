import { describe, expect, it, vi } from 'vitest'
import { createHookMetadata, hookMetadataId } from '@bananapus/nana-sdk-core'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { allocatePositions } from '../src/domain/allocation'
import type { Coefficients } from '../src/domain/distribution'
import { marketRanges, type MarketDefinition } from '../src/domain/market'
import { DEFIFA_ABI, deploymentForChain, NATIVE_TOKEN, type MarketSnapshot } from '../src/lib/defifa'
import { readEntry } from '../src/lib/entries'

const chainId = 8453
const d = deploymentForChain(chainId)
const account = '0x0000000000000000000000000000000000000123' as Address
const hook = '0x0000000000000000000000000000000000000456' as Address
const number = BigInt(d.deployerBlock) + 1_000n
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex
const definition: MarketDefinition = { schemaVersion: 1, settlement: 'defifa-scorecard', prompt: 'BTC change?', source: 'Source',
  resolutionRule: 'Ratified scorecard', entryOpensAt: 100, entryClosesAt: 1_000, resolvesAt: 2_000,
  rangeCount: 3, rangeWidth: 1, unitPriceWei: '1000' }
const ranges = marketRanges(definition)
const market = { chainId, projectId: '27', hook, definition, ranges, blockNumber: number.toString(), blockTimestamp: 200 } as MarketSnapshot
const coefficients: Coefficients = [0, 1, 0, 0, 0, 0]
const allocation = allocatePositions(coefficients, ranges, 10)
const ids = allocation.tierIds.flatMap((id, index) => Array<number>(allocation.quantities[index]).fill(id))

function fixture(options: { mode?: 'manual'; memo?: string; missingMint?: boolean; target?: Address; outsiderMint?: boolean; transactions?: number; malformedReceipt?: boolean; wrongDelegate?: boolean } = {}) {
  const transactions = options.transactions ?? 1
  const all = Array.from({ length: transactions }, (_, txIndex) => {
    const tierIds = options.mode === 'manual' ? [1, 1, 3] : ids
    const unique = [...new Set(tierIds)]
    const metadata = createHookMetadata([hookMetadataId(d.implementation, 'pay')], [encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint16[]' }, { type: 'uint256[]' }],
      [options.wrongDelegate ? hook : account, unique, unique.map(id => BigInt(tierIds.filter(item => item === id).length))])])
    const memo = options.memo ?? JSON.stringify(options.mode === 'manual'
      ? { schema: 'metalog.entry.v2', units: 'percentage-points', coefficients, mode: 'manual', quantities: [2, 0, 1], count: 3 }
      : { schema: 'metalog.entry.v1', units: 'percentage-points', coefficients, count: 10 })
    const transactionHash = hash(txIndex + 1)
    const blockHash = hash(100)
    const minted = tierIds.map((tierId, index) => ({
      address: hook, data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(tierId), 1n]),
      topics: encodeEventTopics({ abi: DEFIFA_ABI.DefifaHook, eventName: 'TransferSingle', args: {
        operator: d.terminal, from: zeroAddress, to: options.outsiderMint && index === 0 ? hook : account,
      } }), blockNumber: number, blockHash, transactionHash, transactionIndex: txIndex, logIndex: index, removed: false,
    }))
    const transaction = { hash: transactionHash, blockHash, blockNumber: number, transactionIndex: txIndex, from: account,
      to: options.target ?? d.terminal, value: BigInt(tierIds.length) * 1000n,
      input: encodeFunctionData({ abi: DEFIFA_ABI.JBMultiTerminal, functionName: 'pay', args: [27n, NATIVE_TOKEN,
        BigInt(tierIds.length) * 1000n, account, 0n, memo, metadata] }) }
    const receipt = { status: 'success', from: account, to: transaction.to, blockNumber: number,
      blockHash: options.malformedReceipt ? hash(999) : blockHash, transactionHash, transactionIndex: txIndex,
      logs: options.missingMint ? minted.slice(1) : minted }
    return { transaction, receipt, minted }
  })
  const getLogs = vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
    expect(toBlock - fromBlock + 1n).toBeLessThanOrEqual(500n)
    return number >= fromBlock && number <= toBlock ? all.flatMap(item => item.minted) : []
  })
  const client = { getChainId: vi.fn(async () => chainId), getLogs,
    getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: hash(100), timestamp: blockNumber >= number ? 200n : 99n })),
    getTransaction: vi.fn(async ({ hash: requested }: { hash: Hex }) => all.find(item => item.transaction.hash === requested)!.transaction),
    getTransactionReceipt: vi.fn(async ({ hash: requested }: { hash: Hex }) => all.find(item => item.transaction.hash === requested)!.receipt) }
  return { client: client as unknown as PublicClient, mocks: client }
}

describe('public entry receipt evidence', () => {
  const entry = async (options: Parameters<typeof fixture>[0] = {}) => readEntry(fixture(options).client, market, hash(1))
  it('authenticates a direct curve and exact mint quantities without reading current ownership', async () => {
    expect(await entry()).toMatchObject({ status: 'verified-curve', coefficients, quantities: allocation.quantities,
      account, beneficiary: account, stakeWei: '10000', timestamp: 200, blockNumber: number.toString() })
  })
  it('authenticates manual quantities while retaining coefficients only as reference', async () => {
    expect(await entry({ mode: 'manual' })).toMatchObject({ status: 'verified-manual', quantities: [2, 0, 1], coefficients, stakeWei: '3000' })
  })
  it.each([{ memo: '{"schema":"metalog.entry.v1"}' }, { missingMint: true }])('never authenticates malformed curve or incomplete mints %j', async options => {
    expect(await entry(options)).toMatchObject({ status: 'invalid', coefficients: null })
  })
  it('rejects a spoofed curve whose claimed coefficients disagree with the actual mints', async () => {
    const memo = JSON.stringify({ schema: 'metalog.entry.v1', units: 'percentage-points', coefficients: [0, 5], count: 10 })
    expect((await entry({ memo })).status).toBe('invalid')
  })
  it('rejects wrong native delegation metadata instead of relying only on a memo', async () => {
    expect((await entry({ wrongDelegate: true })).status).toBe('invalid')
  })
  it('rejects extra mints to a different recipient even when reviewed allocation subset matches', async () => {
    expect((await entry({ outsiderMint: true })).status).toBe('invalid')
  })
  it('shows direct unknown memos as unrecognized, not a claimed curve', async () => {
    expect(await entry({ memo: 'hello' })).toMatchObject({ status: 'unrecognized', coefficients: null, stakeWei: '10000' })
  })
  it('shows wrapped effects without attributing outer value to an entry stake', async () => {
    expect(await entry({ target: hook })).toMatchObject({ status: 'unsupported', coefficients: null, stakeWei: null })
  })
  it('fails on noncanonical receipts, provider failures, receipts without mints and later blocks', async () => {
    await expect(entry({ malformedReceipt: true })).rejects.toThrow('canonical')
    const { client, mocks } = fixture()
    mocks.getTransactionReceipt.mockRejectedValueOnce(new Error('provider down'))
    await expect(readEntry(client, market, hash(1))).rejects.toThrow('provider down')
    const receipt = await client.getTransactionReceipt({ hash: hash(1) })
    ;(receipt.logs as unknown[]).length = 0
    await expect(readEntry(client, market, hash(1))).rejects.toThrow('did not mint')
    await expect(readEntry(fixture().client, { ...market, blockNumber: (number - 1n).toString() }, hash(1))).rejects.toThrow('did not mint')
  })
})
