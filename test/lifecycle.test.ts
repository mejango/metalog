import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  decodeAbiParameters, decodeFunctionData, encodeAbiParameters,
  encodeEventTopics, getAbiItem, getAddress, zeroAddress,
  parseAbi, type Abi, type Address, type Hex, type TransactionReceipt,
} from 'viem'
import { createHookMetadata, hookMetadataId } from '@bananapus/nana-sdk-core'
import { createRanges } from '../src/domain/ranges'
import { SCORECARD_WEIGHT_TOTAL, scorecardWeightsFromPercentages } from '../src/domain/scorecard'
import { DEFIFA_ABI, deploymentForChain, NATIVE_TOKEN, type MarketSnapshot } from '../src/lib/defifa'
import { prepareLifecycleAction, readCashOutQuote, readLifecycle, verifyLifecycleReceipt, type LifecycleAction } from '../src/lib/defifa-lifecycle'
import { verifyDefifaDeployment } from '../src/lib/defifa-deployment'

const mocks = vi.hoisted(() => ({ getBlock: vi.fn(), getChainId: vi.fn(), getBytecode: vi.fn(), readContract: vi.fn(), getLogs: vi.fn(), simulateContract: vi.fn(), readMarketAt: vi.fn() }))
vi.mock('../src/lib/wallet', () => ({ publicClientForChain: () => mocks, chainForId: (id: number) => ({ id }), SUPPORTED_CHAINS: [{ id: 8453 }] }))
vi.mock('../src/lib/defifa', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/defifa')>(), readMarketAt: mocks.readMarketAt }))
vi.mock('../src/lib/defifa-deployment', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/lib/defifa-deployment')>()
  return { ...actual, verifyDefifaDeployment: vi.fn(async (client, chainId) => {
    await actual.assertChain(client, chainId)
    return actual.deploymentForChain(chainId)
  }) }
})

const chainId = 8453
const d = deploymentForChain(chainId)
const head = BigInt(d.deployerBlock) + 100_000n
const account = getAddress('0x0000000000000000000000000000000000000123')
const other = getAddress('0x0000000000000000000000000000000000000789')
const hook = getAddress('0x0000000000000000000000000000000000000456')
const rewardA = getAddress('0x0000000000000000000000000000000000000a11')
const rewardB = getAddress('0x0000000000000000000000000000000000000b22')
let market: MarketSnapshot
let now: number
/** The account's ERC-1155 balance in each range. */
let balances: bigint[]
let state: number
let governorState: number
let forwardedId: bigint
let attested: boolean
let reclaim: bigint
let blockLogs: TransactionReceipt['logs']

function log(contract: keyof typeof DEFIFA_ABI | Abi, address: Address, name: string, args: Record<string, unknown>, blockNumber = head) {
  const abi = typeof contract === 'string' ? DEFIFA_ABI[contract] : contract
  const event = getAbiItem({ abi, name })
  if (!event || event.type !== 'event') throw new Error('Missing event fixture')
  const parameters = event.inputs.filter(input => !input.indexed)
  return {
    address, topics: encodeEventTopics({ abi, eventName: name, args }),
    data: encodeAbiParameters(parameters, parameters.map(input => args[input.name!])),
    blockNumber, blockHash: `0x${'a'.repeat(64)}`, transactionHash: `0x${'b'.repeat(64)}`,
    transactionIndex: 0, logIndex: 0, removed: false,
  } as unknown as TransactionReceipt['logs'][number]
}

function receipt(logs: TransactionReceipt['logs']): TransactionReceipt {
  return { status: 'success', blockNumber: head, logs } as TransactionReceipt
}

function moved(from: Address, to: Address, id: bigint, value = 1n, address: Address = hook) {
  return log('DefifaHook', address, 'TransferSingle', { operator: from, from, to, id, value })
}

beforeEach(() => {
  vi.clearAllMocks()
  now = 1_800_000_250
  balances = [1n, 1n, 1n]
  state = 1
  governorState = 4
  forwardedId = 0n
  attested = false
  reclaim = 100n
  blockLogs = []
  market = {
    chainId, projectId: '7', hook, governor: d.governor, referee: d.referee,
    definition: {
      schemaVersion: 1, settlement: 'defifa-scorecard', prompt: 'BTC/USD change?', source: 'Public source', resolutionRule: 'Ratified scorecard',
      entryOpensAt: 1_800_000_000, entryClosesAt: 1_800_000_100, resolvesAt: 1_800_000_200, rangeCount: 3, rangeWidth: 1, unitPriceWei: '100',
    },
    ranges: createRanges(3, 1), phase: 1, stage: 'entry', blockNumber: head.toString(), blockTimestamp: now,
    potWei: '300', tiers: [1, 2, 3].map(tierId => ({ tierId, supply: '1', entrySupply: null, priceWei: '100', remainingSupply: '999999998' })),
    ratifiedScorecardId: null, ratifiedWeights: null, cashOutWeightTotal: SCORECARD_WEIGHT_TOTAL.toString(), commitmentsFulfilled: false, noContestTriggered: false,
  }
  mocks.getChainId.mockResolvedValue(chainId)
  mocks.getBytecode.mockResolvedValue(`0x363d3d373d3d3d363d73${d.implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`)
  mocks.getBlock.mockImplementation(async (args?: { blockNumber?: bigint }) => {
    const number = args?.blockNumber ?? head
    return { number, timestamp: BigInt(now) - (head - number) * 2n }
  })
  mocks.readMarketAt.mockImplementation(async (_client, _chain, _id, blockNumber: bigint, timestamp: number) => ({ ...market, blockNumber: blockNumber.toString(), blockTimestamp: timestamp }))
  mocks.getLogs.mockImplementation(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => blockLogs.filter(item => item.blockNumber !== null && item.blockNumber >= fromBlock && item.blockNumber <= toBlock))
  mocks.simulateContract.mockImplementation(async () => ({ result: reclaim }))
  mocks.readContract.mockImplementation(async ({ address, functionName, args }: { address: string; functionName: string; args: readonly unknown[] }) => {
    switch (functionName) {
      case 'projectId': return 7n
      case 'quorum': return 1_500_000_000n
      case 'currentRulesetOf': return [{ id: 10n }, { dataHook: hook, useDataHookForPay: true }]
      case 'store': return d.store
      case 'CODE_ORIGIN': return d.implementation
      case 'gamePhaseReporter': case 'gamePotReporter': return d.deployer
      case 'pricingCurrency': return 61166n
      case 'contractURI': return 'ipfs://native-test-collection'
      case 'currentGamePotOf': return [BigInt(market.potWei), NATIVE_TOKEN, 18n]
      case 'currentGamePhaseOf': return market.phase
      case 'tierNameOf': return market.ranges.find(range => BigInt(range.tierId) === args[0])!.label
      case 'currentSupplyOfTier': return 1n
      case 'ownerOf': return d.deployer
      case 'balanceOfBatch': return (args[1] as bigint[]).map(id => balances[Number(id) - 1] ?? 0n)
      case 'getTierDelegateOf': return account
      case 'stateOf': return address === d.governor ? governorState : state
      case 'forwardedScorecardIdOf': return forwardedId
      case 'quorumOf': return 1_500_000_000n
      case 'scorecardSubmittedAtOf': return BigInt(now - 100)
      case 'scorecardIdOf': return 123n
      case 'attestationCountOf': return 1_400_000_000n
      case 'hasAttestedTo': return attested
      case 'getBWAAttestationWeight': return 1_200_000_000n
      case 'attestationGracePeriodOf': return 86_400n
      case 'timelockDurationOf': return 3_600n
      case 'safetyParamsOf': return [0n, 604_900]
      case 'tokensClaimableFor': return market.phase === 4 ? [11n, 12n] : [0n, 0n]
      case 'DEFIFA_TOKEN': return rewardA
      case 'BASE_PROTOCOL_TOKEN': return rewardB
      case 'decimals': return 18
      default: throw new Error(`Unhandled read ${functionName}`)
    }
  })
})

describe('native lifecycle preparation', () => {
  it('converts percentages exactly and rejects rounding or incomplete totals', () => {
    expect(scorecardWeightsFromPercentages(market.ranges, ['50', '30', '20'])).toEqual([
      { tierId: 1, weight: '500000000000000000' }, { tierId: 2, weight: '300000000000000000' }, { tierId: 3, weight: '200000000000000000' },
    ])
    expect(() => scorecardWeightsFromPercentages(market.ranges, ['99.99999999999999999', '0', '0'])).toThrow('16 decimal')
    expect(() => scorecardWeightsFromPercentages(market.ranges, ['99', '0', '0'])).toThrow('exactly 100')
    expect(scorecardWeightsFromPercentages(market.ranges, ['100', '', '0'])).toEqual([{ tierId: 1, weight: SCORECARD_WEIGHT_TOTAL.toString() }])
  })

  it('prepares an implementation-keyed refund with exact selected ranges, counts and minimum', async () => {
    const tx = await prepareLifecycleAction(market, { kind: 'cash-out', positions: [{ tierId: 1, count: 1 }, { tierId: 2, count: 1 }], minReclaimedWei: '100' }, account)
    const decoded = decodeFunctionData({ abi: DEFIFA_ABI.JBMultiTerminal, data: tx.data })
    expect(tx.to).toBe(d.terminal)
    expect(tx.value).toBe(0n)
    expect(decoded.functionName).toBe('cashOutTokensOf')
    expect(decoded.args?.slice(0, 6)).toEqual([account, 7n, 0n, NATIVE_TOKEN, 100n, account])
    const metadata = decoded.args![6] as Hex
    expect(metadata.slice(2, 130)).toContain(hookMetadataId(d.implementation, 'cashOut').slice(2).toLowerCase())
    expect(decodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], `0x${metadata.slice(130)}`)).toEqual([[1n, 2n], [1n, 1n]])
    expect(metadata).toBe(createHookMetadata([hookMetadataId(d.implementation, 'cashOut')], [
      encodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], [[1n, 2n], [1n, 1n]]),
    ]))
    reclaim = 99n
    await expect(tx.reverify!()).rejects.toThrow('below the reviewed minimum')
  })

  it('rejects changed phase, unheld positions, duplicate ranges and oversized selections', async () => {
    const tx = await prepareLifecycleAction(market, { kind: 'cash-out', positions: [{ tierId: 1, count: 1 }], minReclaimedWei: '100' }, account)
    market.phase = 4
    await expect(tx.reverify!()).rejects.toThrow('phase changed')
    await expect(prepareLifecycleAction(market, { kind: 'transfer', tierId: 1, count: 2, to: other }, account)).rejects.toThrow('no longer holds')
    await expect(prepareLifecycleAction(market, { kind: 'cash-out', positions: [{ tierId: 1, count: 1 }, { tierId: 1, count: 1 }], minReclaimedWei: '0' }, account)).rejects.toThrow('unique')
    await expect(prepareLifecycleAction(market, { kind: 'cash-out', positions: [{ tierId: 1, count: 161 }], minReclaimedWei: '0' }, account)).rejects.toThrow('160')
    await expect(prepareLifecycleAction(market, { kind: 'cash-out', positions: [{ tierId: 4, count: 1 }], minReclaimedWei: '0' }, account)).rejects.toThrow('unique')
  })

  it('sends a range count with ERC-1155 safeTransferFrom and pins it against later draft changes', async () => {
    const action: LifecycleAction = { kind: 'transfer', tierId: 1, count: 1, to: other }
    const tx = await prepareLifecycleAction(market, action, account)
    expect(decodeFunctionData({ abi: DEFIFA_ABI.DefifaHook, data: tx.data }).args).toEqual([account, other, 1n, 1n, '0x'])
    action.tierId = 2
    balances[0] = 0n
    await expect(tx.reverify!()).rejects.toThrow('no longer holds')
  })

  it('uses native proposal/attest/revoke/ratify gates and rejects unowned weighted tiers', async () => {
    const weights = scorecardWeightsFromPercentages(market.ranges, ['50', '30', '20'])
    await expect(prepareLifecycleAction(market, { kind: 'submit-scorecard', weights }, account)).rejects.toThrow('scoring phase')
    market.phase = 3
    market.tiers[1].supply = '0'
    await expect(prepareLifecycleAction(market, { kind: 'submit-scorecard', weights }, account)).rejects.toThrow('no circulating')
    market.tiers[1].supply = '1'
    const submit = await prepareLifecycleAction(market, { kind: 'submit-scorecard', weights }, account)
    expect(submit.to).toBe(d.referee)
    expect(decodeFunctionData({ abi: DEFIFA_ABI.DefifaVotingReferee, data: submit.data }).functionName).toBe('submitScorecardFor')
    state = 3
    await expect(prepareLifecycleAction(market, { kind: 'attest', scorecardId: '123' }, account)).resolves.toMatchObject({ to: d.referee, value: 0n, title: 'Attest result', details: expect.arrayContaining([{ label: 'Result', value: '123' }]) })
    attested = true
    await expect(prepareLifecycleAction(market, { kind: 'revoke', scorecardId: '123' }, account)).rejects.toThrow('only be revoked')
    // The referee forwards a result that reached quorum once; the governor ratifies after its timelock.
    const forward = await prepareLifecycleAction(market, { kind: 'forward', weights }, account)
    expect([forward.to, decodeFunctionData({ abi: DEFIFA_ABI.DefifaVotingReferee, data: forward.data }).functionName]).toEqual([d.referee, 'forwardScorecardFor'])
    forwardedId = 999n
    await expect(prepareLifecycleAction(market, { kind: 'forward', weights }, account)).rejects.toThrow('another result is queued')
    await expect(prepareLifecycleAction(market, { kind: 'ratify', weights }, account)).rejects.toThrow('timelock')
    governorState = 3
    const ratify = await prepareLifecycleAction(market, { kind: 'ratify', weights }, account)
    expect([ratify.to, decodeFunctionData({ abi: DEFIFA_ABI.DefifaGovernor, data: ratify.data }).functionName]).toEqual([d.governor, 'ratifyScorecardFrom'])
    state = 1
    await expect(prepareLifecycleAction(market, { kind: 'revoke', scorecardId: '123' }, account)).resolves.toMatchObject({ value: 0n })
  })

  it('allows explicit delegation only during mint and to a nonzero address', async () => {
    const tx = await prepareLifecycleAction(market, { kind: 'delegate', tierIds: [1, 2], delegatee: other }, account)
    expect(decodeFunctionData({ abi: DEFIFA_ABI.DefifaHook, data: tx.data }).args).toEqual([[{ delegatee: other, tierId: 1n }, { delegatee: other, tierId: 2n }]])
    market.phase = 3
    await expect(tx.reverify!()).rejects.toThrow('entry is open')
    await expect(prepareLifecycleAction(market, { kind: 'delegate', tierIds: [1], delegatee: zeroAddress }, account)).rejects.toThrow('Connect a wallet')
  })

  it('only opens native no-contest refunds after phase5 and before activation', async () => {
    market.phase = 3
    await expect(prepareLifecycleAction(market, { kind: 'no-contest' }, account)).rejects.toThrow('not awaiting')
    market.phase = 5
    await expect(readCashOutQuote(market, [{ tierId: 1, count: 1 }], account)).rejects.toThrow('Open the native')
    const tx = await prepareLifecycleAction(market, { kind: 'no-contest' }, account)
    expect(decodeFunctionData({ abi: DEFIFA_ABI.DefifaDeployer, data: tx.data }).functionName).toBe('triggerNoContestFor')
    market.noContestTriggered = true
    await expect(tx.reverify!()).rejects.toThrow('not awaiting')
  })

  it('shows simulated ETH and actual protocol-token rewards without swallowing failures', async () => {
    market.phase = 4
    expect(await readCashOutQuote(market, [{ tierId: 1, count: 1 }], account)).toEqual({ blockNumber: head.toString(), reclaimWei: '100', defifaTokenWei: '11', baseProtocolTokenWei: '12', defifaToken: rewardA, baseProtocolToken: rewardB })
    mocks.simulateContract.mockRejectedValueOnce(new Error('Native NothingToClaim'))
    await expect(readCashOutQuote(market, [{ tierId: 1, count: 1 }], account)).rejects.toThrow('NothingToClaim')
    mocks.readContract.mockImplementationOnce(async () => { throw new Error('RPC unavailable') })
    await expect(readCashOutQuote(market, [{ tierId: 1, count: 1 }], account)).rejects.toThrow('RPC unavailable')
  })

  it('refuses all actions after deployment verification fails', async () => {
    vi.mocked(verifyDefifaDeployment).mockRejectedValueOnce(new Error('Runtime fingerprint changed'))
    await expect(prepareLifecycleAction(market, { kind: 'transfer', tierId: 1, count: 1, to: other }, account)).rejects.toThrow('fingerprint')
  })
})

describe('bounded pinned lifecycle reads', () => {
  it('reads every range balance in one batched call at the snapshot block and surfaces RPC outages', async () => {
    balances = [3n, 0n, 2n]
    const result = await readLifecycle(chainId, '7', account)
    expect(result.positions).toEqual([{ tierId: 1, count: 3 }, { tierId: 3, count: 2 }])
    expect(mocks.readContract.mock.calls.filter(([args]) => args.functionName === 'balanceOfBatch')).toHaveLength(1)
    expect(mocks.readContract.mock.calls.every(([args]) => args.blockNumber === head)).toBe(true)
    expect((await readLifecycle(chainId, '7')).positions).toEqual([])
    const original = mocks.readContract.getMockImplementation()!
    mocks.readContract.mockImplementation(async args => { if (args.functionName === 'balanceOfBatch') throw new Error('RPC down'); return original(args) })
    await expect(readLifecycle(chainId, '7', account)).rejects.toThrow('RPC down')
  })

  it('reads native scorecard state and timestamp snapshot without unrelated old history', async () => {
    market.phase = 3
    blockLogs = [log('DefifaVotingReferee', d.referee, 'ScorecardSubmitted', { gameId: 7n, scorecardId: 123n, tierWeights: [{ id: 1n, cashOutWeight: SCORECARD_WEIGHT_TOTAL }], isDefaultAttestationDelegate: false, caller: other }, head - 20n)]
    const result = await readLifecycle(chainId, '7', account)
    expect(result.scorecards[0]).toMatchObject({ scorecardId: '123', submittedAt: now - 40, attestationsBegin: now - 39, gracePeriodEnds: now - 39 + 86_400, state: 1,
      canAttest: true, accountWeight: '1200000000', quorum: '1500000000', forwarded: false, ratifiableAt: null, canForward: false })
    expect(mocks.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'getBWAAttestationWeight', args: [7n, 123n, account, now - 41], blockNumber: head }))
    expect(mocks.getBlock.mock.calls.every(([args]) => !args || args.blockNumber >= head - 128n)).toBe(true)
    expect(mocks.getLogs).toHaveBeenCalledTimes(1)
    expect(result.scorecardsComplete).toBe(true)
    // Once forwarded, the governor's queue state and timelock end describe the result.
    forwardedId = 123n
    expect((await readLifecycle(chainId, '7', account)).scorecards[0]).toMatchObject({ state: 4, forwarded: true, ratifiableAt: now - 100 + 3_600, canAttest: false, canRatify: false })
  })

  it('adapts explicit RPC range limits and does not turn rate limits into empty pages', async () => {
    market.phase = 3
    mocks.getLogs.mockImplementation(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (toBlock - fromBlock + 1n > 20n) throw new Error('eth_getLogs is limited to a maximum 20 blocks range')
      return []
    })
    expect((await readLifecycle(chainId, '7')).scorecardsComplete).toBe(true)
    expect(mocks.getLogs.mock.calls.length).toBeGreaterThan(1)
    expect(mocks.getLogs.mock.calls.length).toBeLessThanOrEqual(16)
    mocks.getLogs.mockRejectedValue(new Error('RPC rate limit exceeded: try later'))
    await expect(readLifecycle(chainId, '7')).rejects.toThrow('rate limit')
  })

  it('bounds Center log requests before its generic limit and preserves full history', async () => {
    market.phase = 3
    market.definition.entryClosesAt = now - 3_000
    blockLogs = [10n, 1_400n].map((age, index) => log('DefifaVotingReferee', d.referee, 'ScorecardSubmitted', {
      gameId: 7n, scorecardId: BigInt(index + 123), tierWeights: [{ id: 1n, cashOutWeight: SCORECARD_WEIGHT_TOTAL }],
      isDefaultAttestationDelegate: false, caller: other,
    }, head - age))
    mocks.getLogs.mockImplementation(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (toBlock - fromBlock + 1n > 500n) throw Object.assign(new Error('RPC request failed'), { code: -32005 })
      return blockLogs.filter(item => item.blockNumber !== null && item.blockNumber >= fromBlock && item.blockNumber <= toBlock)
    })
    const result = await readLifecycle(chainId, '7')
    expect(result.scorecards.map(card => card.scorecardId)).toEqual(['123', '124'])
    expect(result.scorecardsComplete).toBe(true)
    expect(mocks.getLogs).toHaveBeenCalledTimes(4)
    mocks.getLogs.mockRejectedValue(Object.assign(new Error('RPC request failed'), { code: -32005 }))
    await expect(readLifecycle(chainId, '7')).rejects.toThrow('RPC request failed')
  })

  it('keeps recent and early proposals when splitting pages and exposes bounded continuation', async () => {
    market.phase = 3
    market.definition.entryClosesAt = now - 5_000
    blockLogs = [10n, 2_400n].map((age, index) => log('DefifaVotingReferee', d.referee, 'ScorecardSubmitted', {
      gameId: 7n, scorecardId: BigInt(index + 123), tierWeights: [{ id: 1n, cashOutWeight: SCORECARD_WEIGHT_TOTAL }],
      isDefaultAttestationDelegate: false, caller: other,
    }, head - age))
    mocks.getLogs.mockImplementation(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (toBlock - fromBlock + 1n > 100n) throw new Error('block range too large')
      return blockLogs.filter(item => item.blockNumber !== null && item.blockNumber >= fromBlock && item.blockNumber <= toBlock)
    })
    let result = await readLifecycle(chainId, '7')
    expect(result.scorecardsComplete).toBe(false)
    expect(BigInt(result.scorecardsNextCursor!)).toBeLessThan(head)
    expect(mocks.getLogs).toHaveBeenCalledTimes(16)
    const ids = result.scorecards.map(card => card.scorecardId)
    for (let pages = 0; result.scorecardsNextCursor && pages < 10; pages++) {
      result = await readLifecycle(chainId, '7', undefined, { blockNumber: result.market.blockNumber, scorecardCursor: result.scorecardsNextCursor })
      ids.push(...result.scorecards.map(card => card.scorecardId))
    }
    expect(result.scorecardsComplete).toBe(true)
    expect(ids).toEqual(['123', '124'])
  })
})

describe('receipt effects and reload recovery', () => {
  it('proves a transfer even when the recipient forwards it later in the same block', async () => {
    const tx = await prepareLifecycleAction(market, { kind: 'transfer', tierId: 1, count: 1, to: other }, account)
    balances[0] = 0n
    await expect(verifyLifecycleReceipt(tx, receipt([moved(account, other, 1n), moved(other, hook, 1n)]))).resolves.toBeUndefined()
    await expect(verifyLifecycleReceipt(tx, receipt([moved(account, other, 1n, 1n, other)]))).rejects.toThrow('reviewed position transfer')
    await expect(verifyLifecycleReceipt(tx, receipt([moved(account, other, 2n)]))).rejects.toThrow('reviewed position transfer')
  })

  it.each([{ percentages: ['100', '0', '0'] }, { percentages: ['50', '30', '20'] }])('requires the exact native scorecard event for $percentages and rejects forged/re-targeted recovery', async ({ percentages }) => {
    market.phase = 3
    const weights = scorecardWeightsFromPercentages(market.ranges, percentages)
    const tx = await prepareLifecycleAction(market, { kind: 'submit-scorecard', weights }, account)
    const nativeWeights = weights.map(item => ({ id: BigInt(item.tierId), cashOutWeight: BigInt(item.weight) }))
    expect(decodeFunctionData({ abi: DEFIFA_ABI.DefifaVotingReferee, data: tx.data }).args).toEqual([7n, nativeWeights])
    const event = log('DefifaVotingReferee', d.referee, 'ScorecardSubmitted', { gameId: 7n, scorecardId: 123n, tierWeights: nativeWeights, isDefaultAttestationDelegate: false, caller: account })
    await expect(verifyLifecycleReceipt(tx, receipt([event]))).resolves.toBeUndefined()
    await expect(verifyLifecycleReceipt(tx, receipt([{ ...event, address: other }]))).rejects.toThrow('complete reviewed result')
    await expect(verifyLifecycleReceipt({ ...tx, value: 1n }, receipt([event]))).rejects.toThrow('native lifecycle')
    await expect(verifyLifecycleReceipt({ ...tx, data: `${tx.data}00` }, receipt([event]))).rejects.toThrow('calldata')
  })

  it('accepts a confirmed attestation even if a later same-block revoke changes the getter', async () => {
    market.phase = 3
    const tx = await prepareLifecycleAction(market, { kind: 'attest', scorecardId: '123' }, account)
    attested = false
    await expect(verifyLifecycleReceipt(tx, receipt([log('DefifaVotingReferee', d.referee, 'ScorecardAttested', { gameId: 7n, scorecardId: 123n, weight: 900_000_000n, caller: account })]))).resolves.toBeUndefined()
    await expect(verifyLifecycleReceipt(tx, receipt([]))).rejects.toThrow('attestation change')
  })

  it('requires every selected burn and minimum ETH for cash-out recovery', async () => {
    const tx = await prepareLifecycleAction(market, { kind: 'cash-out', positions: [{ tierId: 1, count: 1 }], minReclaimedWei: '100' }, account)
    const decoded = decodeFunctionData({ abi: DEFIFA_ABI.JBMultiTerminal, data: tx.data })
    const cash = (amount: bigint) => log('JBMultiTerminal', d.terminal, 'CashOutTokens', { rulesetId: 10n, rulesetCycleNumber: 1n, projectId: 7n, holder: account, beneficiary: account, cashOutCount: 0n, cashOutTaxRate: 0n, reclaimAmount: amount, metadata: decoded.args![6], caller: account })
    const burn = moved(account, zeroAddress, 1n)
    await expect(verifyLifecycleReceipt(tx, receipt([burn, cash(100n)]))).resolves.toBeUndefined()
    await expect(verifyLifecycleReceipt(tx, receipt([cash(100n)]))).rejects.toThrow('every position burn')
    await expect(verifyLifecycleReceipt(tx, receipt([burn, cash(99n)]))).rejects.toThrow('reviewed reclaim')
  })

  it.each([{ percentages: ['100', '0', '0'] }, { percentages: ['50', '30', '20'] }])('checks ratification for $percentages, full stored scorecard and atomic fulfillment together', async ({ percentages }) => {
    market.phase = 3; governorState = 3; forwardedId = 123n
    const weights = scorecardWeightsFromPercentages(market.ranges, percentages)
    const tx = await prepareLifecycleAction(market, { kind: 'ratify', weights }, account)
    expect(decodeFunctionData({ abi: DEFIFA_ABI.DefifaGovernor, data: tx.data }).args).toEqual([
      7n, weights.map(item => ({ id: BigInt(item.tierId), cashOutWeight: BigInt(item.weight) })),
    ])
    market.phase = 4; market.commitmentsFulfilled = true; market.ratifiedScorecardId = '123'
    market.ratifiedWeights = market.ranges.map(range => ({ tierId: range.tierId, weight: weights.find(item => item.tierId === range.tierId)?.weight ?? '0' }))
    const result = receipt([
      log('DefifaGovernor', d.governor, 'ScorecardRatified', { gameId: 7n, scorecardId: 123n, caller: account }),
      log('DefifaHook', hook, 'TierCashOutWeightsSet', { tierWeights: weights.map(item => ({ id: BigInt(item.tierId), cashOutWeight: BigInt(item.weight) })), caller: d.governor }),
    ])
    await expect(verifyLifecycleReceipt(tx, result)).resolves.toBeUndefined()
    market.commitmentsFulfilled = false
    await expect(verifyLifecycleReceipt(tx, result)).rejects.toThrow('native fulfillment')
  })

  it('confirms a forward only with the referee event and the governor queueing the same result', async () => {
    market.phase = 3; state = 3
    const weights = scorecardWeightsFromPercentages(market.ranges, ['50', '30', '20'])
    const nativeWeights = weights.map(item => ({ id: BigInt(item.tierId), cashOutWeight: BigInt(item.weight) }))
    const tx = await prepareLifecycleAction(market, { kind: 'forward', weights }, account)
    const forwarded = log('DefifaVotingReferee', d.referee, 'ScorecardForwarded', { gameId: 7n, scorecardId: 123n, caller: account })
    const queued = log('DefifaGovernor', d.governor, 'ScorecardSubmitted', { gameId: 7n, scorecardId: 123n, tierWeights: nativeWeights, caller: d.referee })
    await expect(verifyLifecycleReceipt(tx, receipt([forwarded, queued]))).resolves.toBeUndefined()
    await expect(verifyLifecycleReceipt(tx, receipt([forwarded]))).rejects.toThrow('queued with the governor')
    await expect(verifyLifecycleReceipt(tx, receipt([queued]))).rejects.toThrow('queued with the governor')
  })

  it('confirms reward-only cash-outs through ClaimedTokens and actual ERC20 transfers', async () => {
    market.phase = 4
    reclaim = 0n
    const tx = await prepareLifecycleAction(market, { kind: 'cash-out', positions: [{ tierId: 1, count: 1 }], minReclaimedWei: '0' }, account)
    const decoded = decodeFunctionData({ abi: DEFIFA_ABI.JBMultiTerminal, data: tx.data })
    const erc20 = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)'])
    const logs = [
      moved(account, zeroAddress, 1n),
      log('JBMultiTerminal', d.terminal, 'CashOutTokens', { rulesetId: 10n, rulesetCycleNumber: 3n, projectId: 7n, holder: account, beneficiary: account, cashOutCount: 0n, cashOutTaxRate: 0n, reclaimAmount: 0n, metadata: decoded.args![6], caller: account }),
      log('DefifaHook', hook, 'ClaimedTokens', { beneficiary: account, defifaTokenAmount: 11n, baseProtocolTokenAmount: 12n, caller: d.terminal }),
      log(erc20, rewardA, 'Transfer', { from: hook, to: account, value: 11n }),
      log(erc20, rewardB, 'Transfer', { from: hook, to: account, value: 12n }),
    ]
    await expect(verifyLifecycleReceipt(tx, receipt(logs))).resolves.toBeUndefined()
    await expect(verifyLifecycleReceipt(tx, receipt(logs.slice(0, 4)))).rejects.toThrow('protocol token transfer')
    await expect(verifyLifecycleReceipt(tx, receipt(logs.filter(item => item !== logs[2])))).rejects.toThrow('protocol token claim')
  })

  it('confirms idempotent delegation without requiring a later mutable state value', async () => {
    const tx = await prepareLifecycleAction(market, { kind: 'delegate', tierIds: [1], delegatee: account }, account)
    const original = mocks.readContract.getMockImplementation()!
    mocks.readContract.mockImplementation(async args => args.functionName === 'getTierDelegateOf' ? other : original(args))
    await expect(verifyLifecycleReceipt(tx, receipt([]))).resolves.toBeUndefined()
    await expect(verifyLifecycleReceipt(tx, receipt([
      log('DefifaHook', hook, 'DelegateChanged', { delegator: account, fromDelegate: zeroAddress, toDelegate: other, caller: account }),
    ]))).rejects.toThrow('delegate changes')
  })

  it('requires native no-contest event and permanent activation flag', async () => {
    market.phase = 5
    const tx = await prepareLifecycleAction(market, { kind: 'no-contest' }, account)
    const result = receipt([log('DefifaDeployer', d.deployer, 'QueuedNoContest', { gameId: 7n, caller: account })])
    await expect(verifyLifecycleReceipt(tx, result)).rejects.toThrow('no-contest activation')
    market.noContestTriggered = true
    await expect(verifyLifecycleReceipt(tx, result)).resolves.toBeUndefined()
    await expect(verifyLifecycleReceipt(tx, receipt([]))).rejects.toThrow('no-contest activation')
  })
})
