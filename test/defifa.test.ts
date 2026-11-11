import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAddress, keccak256,
  zeroAddress, zeroHash, stringToHex, type Address, type Hex, type TransactionReceipt,
} from 'viem'
import { bytes32ToCidV0, createHookMetadata, hookMetadataId } from '@bananapus/nana-sdk-core'
import { allocateManualPositions, allocatePositions, type Allocation } from '../src/domain/allocation'
import { coefficientsFromMoments } from '../src/domain/distribution'
import { decodeMarketDefinition, encodeMarketDefinition, marketRanges, validateMarket, type MarketDefinition } from '../src/domain/market'
import { createRanges } from '../src/domain/ranges'
import {
  createdMarketId, DEFIFA_ABI, deploymentForChain, listMarkets, NATIVE_TOKEN, prepareCreateMarket, prepareEntry, readMarket,
  decodeEntryMemo, verifyRecordedEntry,
} from '../src/lib/defifa'
import { assertDeploymentCode, assertGameClone, verifyDefifaDeployment } from '../src/lib/defifa-deployment'
import { checkReceiptEffects } from './integration/effects'
import { forecastPreview } from '../src/lib/forecast'
import { buildProjectMetadata } from '../src/domain/market-metadata'
import { loadMarketMetadata, publishMarketMetadata, type PublishedMarketMetadata } from '../src/lib/market-metadata'

const mocks = vi.hoisted(() => ({
  getBlock: vi.fn(), getChainId: vi.fn(), getCode: vi.fn(), readContract: vi.fn(), publishMetadata: vi.fn(), loadMetadata: vi.fn(), bendystraw: vi.fn(),
}))
vi.mock('../src/lib/bendystraw', () => ({ bendystraw: mocks.bendystraw }))
vi.mock('../src/lib/market-metadata', () => ({
  publishMarketMetadata: mocks.publishMetadata, loadMarketMetadata: mocks.loadMetadata,
}))
vi.mock('../src/lib/wallet', () => ({
  publicClientForChain: () => mocks,
  SUPPORTED_CHAINS: [{ id: 8453 }, { id: 84532 }],
}))
vi.mock('../src/lib/defifa-deployment', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/lib/defifa-deployment')>()
  return { ...actual, verifyDefifaDeployment: vi.fn(async (client, chainId) => {
    await actual.assertChain(client, chainId)
    return actual.deploymentForChain(chainId)
  }) }
})

const chainId = 8453
const deployment = deploymentForChain(chainId)
const account = getAddress('0x0000000000000000000000000000000000000123')
const hook = getAddress('0x0000000000000000000000000000000000000456')
const cloneCode = `0x363d3d373d3d3d363d73${deployment.implementation.slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex
const definition: MarketDefinition = {
  schemaVersion: 1, settlement: 'defifa-scorecard', prompt: 'BTC/USD change?', source: 'Named reference feed',
  resolutionRule: 'The ratified Defifa scorecard determines payouts.',
  entryOpensAt: 1_800_000_100, entryClosesAt: 1_800_003_700, resolvesAt: 1_800_090_100,
  rangeCount: 3, rangeWidth: 1, unitPriceWei: '10000000000000',
}
const customDefinition = validateMarket({ ...definition, rangeCount: undefined, rangeWidth: undefined, rangeBoundaries: [-5, -1, 0, 0.5, 3] })
const ranges = createRanges(definition.rangeCount, definition.rangeWidth)
let observedRanges = ranges
let now = definition.entryOpensAt - 10
let phase = 1
let fee = 123n
let remaining = 999_999_990
let observedPrice = BigInt(definition.unitPriceWei)
let uri = encodeMarketDefinition(definition)
let currentHook: Address = hook
let ratifiedId = 0n
let redeemed = 0n
let extraSplits = false
let grace = 86_400n
let observedDelegate: Address = zeroAddress

const publishedByUri = new Map<string, PublishedMarketMetadata>()
let alteredTierHash: number | null = null
let alteredContractUri: string | null = null
let alteredBaseUri: string | null = null

function publishFixture(input: MarketDefinition): PublishedMarketMetadata {
  const definition = validateMarket(input)
  const projectUri = `ipfs://${bytes32ToCidV0(keccak256(stringToHex(JSON.stringify(buildProjectMetadata(definition)))))}`
  const published: PublishedMarketMetadata = { mode: 'ipfs', definition, projectUri, contractUri: projectUri,
    tierUris: [], encodedTierUris: marketRanges(definition).map(() => zeroHash) }
  publishedByUri.set(projectUri, published)
  return published
}

async function fixtureDefinition(uri: string): Promise<MarketDefinition> {
  return (await loadMarketMetadata(uri)).definition
}

function creationReceipt(): TransactionReceipt {
  return { status: 'success', blockNumber: 100n, logs: [{
    address: deployment.deployer,
    topics: encodeEventTopics({ abi: DEFIFA_ABI.DefifaDeployer, eventName: 'LaunchGame', args: {
      gameId: 7n, hook, governor: deployment.governor,
    } }),
    data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [zeroAddress, account]),
  }] } as unknown as TransactionReceipt
}

/** One ERC-1155 TransferSingle mint per listed range ID, as a batch of single positions. */
function mintLogs(tierIds: number[]) {
  return tierIds.map(tierId => ({
    address: hook, data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(tierId), 1n]),
    topics: encodeEventTopics({ abi: DEFIFA_ABI.DefifaHook, eventName: 'TransferSingle', args: { operator: account, from: zeroAddress, to: account } }),
  }))
}

function mintReceipt(tierIds: number[]): TransactionReceipt {
  return { status: 'success', blockNumber: 100n, logs: mintLogs(tierIds) } as unknown as TransactionReceipt
}

/** The 1155 pay payload: delegate, ascending range IDs and a count for each. */
function payMetadata(delegate: Address, expanded: number[]): Hex {
  const ids = [...new Set(expanded)]
  return createHookMetadata([hookMetadataId(deployment.implementation, 'pay')], [encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint16[]' }, { type: 'uint256[]' }],
    [delegate, ids, ids.map(id => BigInt(expanded.filter(item => item === id).length))])])
}
const PAY_TYPES = [{ type: 'address' }, { type: 'uint16[]' }, { type: 'uint256[]' }] as const

beforeEach(() => {
  vi.clearAllMocks()
  publishedByUri.clear()
  alteredTierHash = null
  alteredContractUri = null
  alteredBaseUri = null
  mocks.publishMetadata.mockImplementation(async input => publishFixture(input))
  mocks.loadMetadata.mockImplementation(async input => {
    if (String(input).startsWith('data:')) {
      const definition = decodeMarketDefinition(input)
      return { mode: 'embedded', definition, projectUri: input, contractUri: input, tierUris: [],
        encodedTierUris: marketRanges(definition).map(() => zeroHash) }
    }
    const published = publishedByUri.get(input)
    if (!published) throw new Error('Center metadata is unavailable.')
    return published
  })
  now = definition.entryOpensAt - 10
  phase = 1
  fee = 123n
  remaining = 999_999_990
  observedRanges = ranges
  observedPrice = BigInt(definition.unitPriceWei)
  uri = encodeMarketDefinition(definition)
  currentHook = hook
  ratifiedId = 0n
  redeemed = 0n
  extraSplits = false
  grace = 86_400n
  observedDelegate = zeroAddress
  delete process.env.METALOG_MARKETS
  delete process.env.NEXT_PUBLIC_METALOG_MARKETS
  mocks.getBlock.mockImplementation(async () => ({ number: 100n, timestamp: BigInt(now) }))
  mocks.getChainId.mockResolvedValue(chainId)
  mocks.getCode.mockResolvedValue(cloneCode)
  mocks.readContract.mockImplementation(async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
    switch (functionName) {
      case 'creationFee': return fee
      case 'uriOf': return uri
      case 'currentRulesetOf': return [{ id: 101 }, { dataHook: currentHook }]
      case 'latestQueuedRulesetOf': return [{ id: 102 }, { dataHook: hook }]
      case 'tokenOf': return NATIVE_TOKEN
      case 'controllerOf': return deployment.controller
      case 'ownerOf': return deployment.deployer
      case 'timesFor': return [definition.entryClosesAt, definition.entryClosesAt - definition.entryOpensAt, 0]
      case 'currentGamePhaseOf': return phase
      case 'currentGamePotOf': return [777n, NATIVE_TOKEN, 18n]
      case 'ratifiedScorecardIdOf': return ratifiedId
      case 'commitmentsFulfilledFor': case 'noContestTriggeredFor': return false
      case 'primaryTerminalOf': return deployment.terminal
      case 'owner': return deployment.governor
      case 'CODE_ORIGIN': return deployment.implementation
      case 'store': return deployment.store
      case 'gamePhaseReporter': return deployment.deployer
      case 'projectId': return 7n
      case 'contractURI': return alteredContractUri ?? uri
      case 'baseURI': return alteredBaseUri ?? ''
      case 'defaultAttestationDelegate': return observedDelegate
      case 'attestationStartTimeOf': return BigInt(definition.resolvesAt)
      case 'refereeOf': return deployment.referee
      case 'tiersOf': return observedRanges.map(range => ({
        id: range.tierId, encodedIpfsUri: alteredTierHash === range.tierId ? keccak256(stringToHex('unexpected tier CID')) : (publishedByUri.get(uri)?.encodedTierUris[range.tierId - 1] ?? zeroHash), price: observedPrice, reserveFrequency: 0, initialSupply: 999_999_999, remainingSupply: remaining,
      }))
      case 'tierNameOf': return observedRanges[Number(args[0]) - 1].label
      case 'currentSupplyOfTier': return 7n
      case 'tokensRedeemedFrom': return redeemed
      case 'tierCashOutWeights': return [200_000_000_000_000_000n, 300_000_000_000_000_000n, 500_000_000_000_000_000n, ...Array<bigint>(125).fill(0n)]
      case 'SPLITS': return getAddress('0x0000000000000000000000000000000000000678')
      case 'safetyParamsOf': return [0n, definition.resolvesAt - definition.entryClosesAt + 604_800]
      case 'attestationGracePeriodOf': return grace
      case 'timelockDurationOf': return 3_600n
      case 'splitsOf': return [5n, 1n, ...(extraSplits ? [6n] : [])].map(projectId => ({
        projectId, beneficiary: hook, hook: zeroAddress, preferAddToBalance: false,
      }))
      default: throw new Error(`Unhandled contract read: ${functionName}`)
    }
  })
})

describe('Defifa deployment binding', () => {
  it('pins runtime bytes while accepting only compiler-declared immutable slots', () => {
    const fingerprint = { bytes: 4, hash: keccak256('0x6000005b'), immutableRanges: [[1, 2]] }
    expect(() => assertDeploymentCode('0x60ffff5b', fingerprint, 'Example')).not.toThrow()
    expect(() => assertDeploymentCode('0x61ffff5b', fingerprint, 'Example')).toThrow('pinned release')
    expect(() => assertDeploymentCode(undefined, fingerprint, 'Example')).toThrow('unavailable')
    expect(() => assertGameClone(cloneCode, deployment.implementation)).not.toThrow()
    expect(() => assertGameClone(cloneCode, hook)).toThrow('canonical Defifa clone')
  })

  it('rejects unsupported chains and an RPC reporting another chain', async () => {
    expect(() => deploymentForChain(137)).toThrow('not configured')
    mocks.getChainId.mockResolvedValue(1)
    await expect(prepareCreateMarket(definition, chainId, account)).rejects.toThrow('RPC network')
    await expect(readMarket(chainId, '7')).rejects.toThrow('RPC network')
  })

  it('does not prepare a write after deployment verification fails', async () => {
    vi.mocked(verifyDefifaDeployment).mockRejectedValueOnce(new Error('DefifaHook deployment code does not match'))
    await expect(prepareCreateMarket(definition, chainId, account)).rejects.toThrow('deployment code')
  })
})

describe('Defifa launch calldata and fresh state', () => {
  it('preserves optional names in the Center manifest and native position tier labels', async () => {
    const named = validateMarket({ ...customDefinition, rangeNames: ['Rekt', 'FUD', 'Crab', 'Hopium', 'FOMO', 'Moon'] })
    const tx = await prepareCreateMarket(named, chainId, account)
    const launch = decodeFunctionData({ abi: DEFIFA_ABI.DefifaDeployer, data: tx.data }).args![0] as {
      projectUri: string; tiers: { name: string }[];
    }
    expect(launch.tiers.map(tier => tier.name)).toEqual(marketRanges(named).map(range => range.label))
    expect(launch.tiers[0].name).toBe('Rekt · < -5%')
    expect(launch.tiers.at(-1)?.name).toBe('Moon · ≥ +3%')
    expect(publishedByUri.get(launch.projectUri)?.definition).toEqual(named)
    await tx.reverify!()
    expect(publishMarketMetadata).toHaveBeenCalledTimes(1)
  })

  it('publishes one IPFS project manifest and binds native tier names and zero hashes to launch and receipt', async () => {
    const tx = await prepareCreateMarket(customDefinition, chainId, account)
    const launch = decodeFunctionData({ abi: DEFIFA_ABI.DefifaDeployer, data: tx.data }).args![0] as {
      projectUri: string; contractUri: string; baseUri: string; tiers: { name: string; encodedIpfsUri: Hex }[];
    }
    const published = publishedByUri.get(launch.projectUri)!
    expect(launch.projectUri).toMatch(/^ipfs:\/\/Qm/)
    expect(launch.contractUri).toBe(launch.projectUri)
    expect(launch.baseUri).toBe('')
    expect(launch.tiers.map(tier => tier.encodedIpfsUri)).toEqual(published.encodedTierUris)
    expect(published.tierUris).toEqual([])
    expect(launch.tiers.every(tier => tier.encodedIpfsUri === zeroHash)).toBe(true)
    expect(launch.tiers.map(tier => tier.name)).toEqual(marketRanges(customDefinition).map(range => range.label))
    await tx.reverify!()
    expect(publishMarketMetadata).toHaveBeenCalledTimes(1)
    expect(loadMarketMetadata).toHaveBeenCalledWith(launch.projectUri)
    uri = launch.projectUri
    observedRanges = marketRanges(customDefinition)
    await expect(checkReceiptEffects(tx, creationReceipt())).resolves.toBeUndefined()
    alteredTierHash = 2
    await expect(readMarket(chainId, '7')).rejects.toThrow()
    await expect(checkReceiptEffects(tx, creationReceipt())).rejects.toThrow()
    alteredTierHash = null
    alteredContractUri = encodeMarketDefinition(customDefinition)
    await expect(readMarket(chainId, '7')).rejects.toThrow()
    alteredContractUri = null
    alteredBaseUri = 'https://another-gateway.test/'
    await expect(readMarket(chainId, '7')).rejects.toThrow()
  })

  it('blocks preparation and receipt checks when Center metadata is unavailable or URI evidence changes', async () => {
    mocks.publishMetadata.mockRejectedValueOnce(new Error('Center pin failed.'))
    await expect(prepareCreateMarket(definition, chainId, account)).rejects.toThrow('Center pin failed')
    const tx = await prepareCreateMarket(definition, chainId, account)
    const launch = decodeFunctionData({ abi: DEFIFA_ABI.DefifaDeployer, data: tx.data }).args![0] as {
      projectUri: string; contractUri: string; tiers: { encodedIpfsUri: Hex }[];
    }
    uri = launch.projectUri
    const otherUri = `ipfs://${bytes32ToCidV0(keccak256(stringToHex('different project bytes')))}`
    publishedByUri.set(otherUri, { ...publishedByUri.get(uri)!, projectUri: otherUri, contractUri: otherUri })
    uri = otherUri
    await expect(checkReceiptEffects(tx, creationReceipt())).rejects.toThrow('confirmed metadata URI')
    uri = launch.projectUri
    publishedByUri.delete(uri)
    await expect(tx.reverify!()).rejects.toThrow('Center metadata is unavailable')
  })

  it('binds the default voting delegate to launch, entry review and receipt', async () => {
    const delegated = validateMarket({ ...definition, defaultAttestationDelegate: hook })
    const launch = await prepareCreateMarket(delegated, chainId, account)
    const data = decodeFunctionData({ abi: DEFIFA_ABI.DefifaDeployer, data: launch.data }).args![0] as Record<string, unknown>
    expect(data.defaultAttestationDelegate).toBe(hook)
    expect(await fixtureDefinition(data.projectUri as string)).toEqual(delegated)
    expect(launch.details).toContainEqual({ label: 'Oracle', value: hook })
    uri = data.projectUri as string
    await expect(readMarket(chainId, '7')).rejects.toThrow('oracle')
    observedDelegate = hook
    now = definition.entryOpensAt + 1
    const market = await readMarket(chainId, '7')
    const coefficients = coefficientsFromMoments(0, 1)
    const allocation = allocateManualPositions(coefficients, ranges, [1, 0, 1])
    const entry = await prepareEntry(market, allocation, account, coefficients)
    const decoded = decodeFunctionData({ abi: DEFIFA_ABI.JBMultiTerminal, data: entry.data })
    const [delegate] = decodeAbiParameters(PAY_TYPES, `0x${(decoded.args![6] as Hex).slice(130)}`)
    expect(delegate).toBe(hook)
    expect(decoded.args![6]).toBe(payMetadata(hook, [1, 3]))
    expect(entry.details).toContainEqual({ label: 'Voting address', value: hook })
    expect(entry.details?.find(detail => detail.label === 'Voting power')?.value).toContain('all your existing')
    await expect(checkReceiptEffects(entry, mintReceipt([1, 3]))).resolves.toBeUndefined()
  })
  it('encodes the native Defifa launch struct, immutable definition and exact creation fee', async () => {
    const tx = await prepareCreateMarket(definition, chainId, account)
    const decoded = decodeFunctionData({ abi: DEFIFA_ABI.DefifaDeployer, data: tx.data })
    expect(decoded.functionName).toBe('launchGameWith')
    const data = decoded.args![0] as Record<string, unknown>
    expect(tx.value).toBe(123n)
    expect(tx.to).toBe(deployment.deployer)
    expect(data.start).toBe(definition.entryClosesAt)
    expect(data.mintPeriodDuration).toBe(3_600)
    expect(data.refundPeriodDuration).toBe(0)
    expect(data.scorecardTimeout).toBe(86_400 + 604_800)
    expect(data.referee).toBe(deployment.referee)
    expect(decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], data.refereeData as Hex)).toEqual([BigInt(definition.resolvesAt), 86_400n])
    expect(data.defaultAttestationDelegate).toBe(zeroAddress)
    expect(data.splits).toEqual([])
    expect(data.token).toEqual({ token: NATIVE_TOKEN, decimals: 18, currency: 1 })
    expect(await fixtureDefinition(data.projectUri as string)).toEqual(definition)
    expect((data.tiers as { name: string; reservedRate: number }[]).map(tier => tier.name)).toEqual(ranges.map(range => range.label))
    expect((data.tiers as { reservedRate: number }[]).every(tier => tier.reservedRate === 0)).toBe(true)
    fee++
    await expect(tx.reverify!()).rejects.toThrow('creation fee changed')
    expect(verifyDefifaDeployment).toHaveBeenCalledTimes(3)
  })

  it('propagates fee-read failures and refuses an expired launch opening', async () => {
    mocks.readContract.mockRejectedValueOnce(new Error('Fee unavailable'))
    await expect(prepareCreateMarket(definition, chainId, account)).rejects.toThrow('Fee unavailable')
    const tx = await prepareCreateMarket(definition, chainId, account)
    now = definition.entryOpensAt
    await expect(tx.reverify!()).rejects.toThrow('open in the future')
  })

  it('uses the chosen width in launch names, immutable metadata, live reads and exact entry allocation', async () => {
    const custom = { ...definition, rangeCount: 5, rangeWidth: 2.5 }
    const preview = forecastPreview({ market: custom, coefficients: [0, 1], positions: 20 })
    const launch = await prepareCreateMarket(custom, chainId, account)
    const decoded = decodeFunctionData({ abi: DEFIFA_ABI.DefifaDeployer, data: launch.data })
    const data = decoded.args![0] as { projectUri: string; tiers: { name: string }[] }
    expect(await fixtureDefinition(data.projectUri)).toEqual(custom)
    expect(data.tiers.map(tier => tier.name)).toEqual(preview.ranges.map(range => range.label))
    expect(data.tiers.map(tier => tier.name)).toEqual([
      '< -3.75%', '-3.75% to < -1.25%', '-1.25% to < +1.25%', '+1.25% to < +3.75%', '≥ +3.75%',
    ])
    uri = data.projectUri
    observedRanges = createRanges(custom.rangeCount, custom.rangeWidth)
    now = custom.entryOpensAt + 1
    const market = await readMarket(chainId, '7')
    expect(market.ranges).toEqual(preview.ranges)
    const entry = await prepareEntry(market, preview.allocation, account, preview.distribution.coefficients)
    const payment = decodeFunctionData({ abi: DEFIFA_ABI.JBMultiTerminal, data: entry.data })
    const metadata = payment.args![6] as Hex
    const expectedIds = preview.allocation.tierIds.flatMap((id, index) => Array<number>(preview.allocation.quantities[index]).fill(id))
    expect(metadata).toBe(payMetadata(account, expectedIds))
    await expect(checkReceiptEffects(entry, mintReceipt(expectedIds))).resolves.toBeUndefined()
    uri = encodeMarketDefinition({ ...custom, rangeWidth: 1 })
    await expect(readMarket(chainId, '7')).rejects.toThrow('onchain ranges')
    await expect(entry.reverify!()).rejects.toThrow('onchain ranges')
  })

  it('round-trips UTF-8 prompt/source data and rejects oversized text before preparing a call', async () => {
    const unicode = { ...definition, prompt: '₿ Δ price? 📈', source: 'Fonte de preços, São Paulo' }
    const tx = await prepareCreateMarket(unicode, chainId, account)
    const decoded = decodeFunctionData({ abi: DEFIFA_ABI.DefifaDeployer, data: tx.data })
    const launch = decoded.args![0] as { name: string; projectUri: string }
    expect(launch.name).toBe(unicode.prompt)
    expect((await fixtureDefinition(launch.projectUri)).source).toBe(unicode.source)
    await expect(prepareCreateMarket({ ...definition, prompt: 'a'.repeat(281) }, chainId, account)).rejects.toThrow('prompt')
  })

  it('binds uneven cutoffs to reviewed launch tiers, exact entry allocations and receipts', async () => {
    const preview = forecastPreview({ market: customDefinition, coefficients: [0, 1], positions: 100 })
    const launch = await prepareCreateMarket(customDefinition, chainId, account)
    const decoded = decodeFunctionData({ abi: DEFIFA_ABI.DefifaDeployer, data: launch.data })
    const data = decoded.args![0] as { projectUri: string; tiers: { name: string }[] }
    expect(await fixtureDefinition(data.projectUri)).toEqual(customDefinition)
    expect(data.tiers.map(tier => tier.name)).toEqual([
      '< -5%', '-5% to < -1%', '-1% to < 0%', '0% to < +0.5%', '+0.5% to < +3%', '≥ +3%',
    ])
    expect(launch.details).toContainEqual({ label: 'Ranges', value: '6' })
    expect(launch.details).toContainEqual({ label: 'Range cutoffs', value: '-5%, -1%, 0%, +0.5%, +3%' })
    expect(launch.details?.some(detail => detail.label === 'Range width')).toBe(false)
    uri = data.projectUri
    observedRanges = marketRanges(customDefinition)
    now = customDefinition.entryOpensAt + 1
    const market = await readMarket(chainId, '7')
    expect(market.ranges).toEqual(preview.ranges)
    const entry = await prepareEntry(market, preview.allocation, account, preview.distribution.coefficients)
    expect(preview.allocation.quantities).toEqual([1, 26, 23, 12, 33, 5])
    const expectedIds = preview.allocation.tierIds.flatMap((id, index) => Array<number>(preview.allocation.quantities[index]).fill(id))
    const payment = decodeFunctionData({ abi: DEFIFA_ABI.JBMultiTerminal, data: entry.data })
    expect(payment.args![6]).toBe(payMetadata(account, expectedIds))
    expect(entry.value).toBe(BigInt(customDefinition.unitPriceWei) * 100n)
    await expect(checkReceiptEffects(entry, mintReceipt(expectedIds))).resolves.toBeUndefined()

    const changed = { ...customDefinition, rangeBoundaries: [-5, -1, 0, 0.5, 5] } as MarketDefinition
    uri = encodeMarketDefinition(changed)
    await expect(readMarket(chainId, '7')).rejects.toThrow('onchain ranges')
    await expect(entry.reverify!()).rejects.toThrow('onchain ranges')
    observedRanges = marketRanges(changed)
    await expect(entry.reverify!()).rejects.toThrow('market changed')
  })
})

describe('Defifa market reads and curve entry', () => {
  it('reads the shared game hook from the queued ruleset during countdown', async () => {
    phase = 0
    currentHook = zeroAddress
    const market = await readMarket(chainId, '7')
    expect(market.hook).toBe(hook)
    expect(market.stage).toBe('countdown')
    expect(market.tiers.every(tier => tier.entrySupply === null)).toBe(true)
    expect(mocks.readContract.mock.calls.some(([read]) => read.functionName === 'latestQueuedRulesetOf')).toBe(true)
  })

  it('reports the actual multi-tier ratified scorecard and preserves supply before final redemptions', async () => {
    phase = 4
    ratifiedId = 42n
    redeemed = 2n
    const market = await readMarket(chainId, '7')
    expect(market.ratifiedScorecardId).toBe('42')
    expect(market.ratifiedWeights).toEqual([
      { tierId: 1, weight: '200000000000000000' },
      { tierId: 2, weight: '300000000000000000' },
      { tierId: 3, weight: '500000000000000000' },
    ])
    expect(market.tiers.map(tier => tier.entrySupply)).toEqual(['9', '9', '9'])
    phase = 5
    ratifiedId = 0n
    expect((await readMarket(chainId, '7')).tiers.every(tier => tier.entrySupply === null)).toBe(true)
  })

  it('uses burn-aware circulation and one evidence block, with explicit configuration errors', async () => {
    now = definition.entryOpensAt + 1
    const market = await readMarket(chainId, '7')
    expect(market.tiers.map(tier => tier.supply)).toEqual(['7', '7', '7'])
    expect(market.stage).toBe('entry')
    expect(market.potWei).toBe('777')
    expect(mocks.readContract.mock.calls.every(([read]) => read.blockNumber === 100n)).toBe(true)
    mocks.bendystraw.mockResolvedValue({ defifaGames: { items: [] } })
    expect(await listMarkets(chainId)).toEqual({ markets: [], errors: [] })
    process.env.METALOG_MARKETS = 'bad,8453:7,84532:8'
    const listed = await listMarkets(chainId)
    expect(listed.markets).toHaveLength(1)
    expect(listed.errors).toHaveLength(1)
    // Discovered games: this deployment's are read on chain; another deployer's are never read.
    delete process.env.METALOG_MARKETS
    mocks.bendystraw.mockResolvedValue({ defifaGames: { items: [{ projectId: 7, deployer: deployment.deployer }, { projectId: 9, deployer: hook }] } })
    expect((await listMarkets(chainId)).markets.map(market => market.projectId)).toEqual(['7'])
    mocks.bendystraw.mockRejectedValue(new Error('down'))
    expect((await listMarkets(chainId)).errors).toEqual(['Recent markets could not be listed. Configured markets are still shown.'])
    uri = encodeMarketDefinition({ ...definition, entryClosesAt: definition.entryClosesAt + 1 })
    await expect(readMarket(chainId, '7')).rejects.toThrow('onchain entry times')
  })

  it('encodes the exact sorted position quantities, self-delegation, amount and retrievable curve', async () => {
    now = definition.entryOpensAt + 1
    const market = await readMarket(chainId, '7')
    const coefficients = coefficientsFromMoments(0, 50)
    const allocation = allocatePositions(coefficients, ranges, 20)
    const tx = await prepareEntry(market, allocation, account, coefficients)
    const decoded = decodeFunctionData({ abi: DEFIFA_ABI.JBMultiTerminal, data: tx.data })
    const args = decoded.args!
    expect(decoded.functionName).toBe('pay')
    expect(args.slice(0, 5)).toEqual([7n, NATIVE_TOKEN, BigInt(definition.unitPriceWei) * 20n, account, 0n])
    expect(tx.value).toBe(BigInt(definition.unitPriceWei) * 20n)
    expect(JSON.parse(args[5] as string)).toEqual({ schema: 'metalog.entry.v1', units: 'percentage-points', coefficients, count: 20 })
    const metadata = args[6] as Hex
    expect(`0x${metadata.slice(66, 74)}`).toBe(hookMetadataId(deployment.implementation, 'pay'))
    expect(`0x${metadata.slice(66, 74)}`).not.toBe(hookMetadataId(hook, 'pay'))
    const [delegate, ids, counts] = decodeAbiParameters(PAY_TYPES, `0x${metadata.slice(130)}`)
    expect(delegate).toBe(account)
    const expanded = allocation.tierIds.flatMap((id, index) => Array<number>(allocation.quantities[index]).fill(id))
    expect(ids).toEqual([...new Set(expanded)])
    expect(metadata).toBe(payMetadata(account, expanded))
    expect(counts.reduce((sum, count) => sum + count, 0n)).toBe(20n)
    now = definition.entryClosesAt
    await expect(tx.reverify!()).rejects.toThrow('not accepting entries')
  })

  it('rejects curve/vector mismatch, unavailable supply, changed prices and closed phases', async () => {
    now = definition.entryOpensAt + 1
    const market = await readMarket(chainId, '7')
    const coefficients = coefficientsFromMoments(0, 50)
    const allocation = allocatePositions(coefficients, ranges, 20)
    const tampered = { ...allocation, quantities: allocation.quantities.map((quantity, index) => quantity + (index === 0 ? 1 : 0)) }
    await expect(prepareEntry(market, tampered, account, coefficients)).rejects.toThrow('does not match the submitted curve')
    remaining = 0
    await expect(prepareEntry(market, allocation, account, coefficients)).rejects.toThrow('enough positions')
    remaining = 999_999_990
    observedPrice++
    await expect(prepareEntry(market, allocation, account, coefficients)).rejects.toThrow('price or reserves')
    observedPrice--
    phase = 3
    await expect(prepareEntry(market, allocation, account, coefficients)).rejects.toThrow('not accepting entries')
    expect((await readMarket(chainId, '7')).stage).toBe('trading')
    now = definition.resolvesAt
    expect((await readMarket(chainId, '7')).stage).toBe('settlement')
  })

  it('reviews and mints exact manual counts without reapportioning the source curve', async () => {
    now = definition.entryOpensAt + 1
    const market = await readMarket(chainId, '7')
    const coefficients = coefficientsFromMoments(0, 1)
    const allocation = allocateManualPositions(coefficients, ranges, [7, 0, 3])
    const tx = await prepareEntry(market, allocation, account, coefficients)
    const decoded = decodeFunctionData({ abi: DEFIFA_ABI.JBMultiTerminal, data: tx.data })
    const args = decoded.args!
    expect(tx.title).toBe('Submit positions')
    expect(tx.value).toBe(BigInt(definition.unitPriceWei) * 10n)
    expect(args.slice(0, 5)).toEqual([7n, NATIVE_TOKEN, tx.value, account, 0n])
    expect(JSON.parse(args[5] as string)).toEqual({
      schema: 'metalog.entry.v2', units: 'percentage-points', coefficients,
      mode: 'manual', quantities: [7, 0, 3], count: 10,
    })
    const ids = [1, 1, 1, 1, 1, 1, 1, 3, 3, 3]
    const [delegate, encodedIds, counts] = decodeAbiParameters(PAY_TYPES, `0x${(args[6] as Hex).slice(130)}`)
    expect(delegate).toBe(account)
    expect(encodedIds).toEqual([1, 3])
    expect(counts).toEqual([7n, 3n])
    expect(tx.details).toContainEqual({ label: ranges[0].label, value: '7' })
    expect(tx.details).toContainEqual({ label: ranges[2].label, value: '3' })
    await expect(checkReceiptEffects(tx, mintReceipt(ids))).resolves.toBeUndefined()
    await expect(checkReceiptEffects(tx, mintReceipt(ids.slice(1)))).rejects.toThrow('complete reviewed')
    remaining = 6
    await expect(tx.reverify!()).rejects.toThrow('enough positions')
  })

  it('rejects tampered manual review fields and recorded quantity metadata', async () => {
    now = definition.entryOpensAt + 1
    const market = await readMarket(chainId, '7')
    const coefficients = coefficientsFromMoments(0, 1)
    const allocation = allocateManualPositions(coefficients, ranges, [7, 0, 3])
    for (const patch of [
      { count: 9 }, { tierIds: [3, 2, 1] }, { quantities: [6, 0, 3] }, { mode: undefined },
      { probabilities: [1, 0, 0] }, { actualProbabilities: [1, 0, 0] }, { totalVariationError: 0 },
    ]) await expect(prepareEntry(market, { ...allocation, ...patch } as Allocation, account, coefficients)).rejects.toThrow()
    const tx = await prepareEntry(market, allocation, account, coefficients)
    const decoded = decodeFunctionData({ abi: DEFIFA_ABI.JBMultiTerminal, data: tx.data })
    const [, , amount, , , memoText, metadata] = decoded.args as
      readonly [bigint, Address, bigint, Address, bigint, string, Hex]
    const memo = JSON.parse(memoText)
    for (const patch of [
      { count: 9 }, { mode: 'curve' }, { quantities: null }, { quantities: [7, -1, 4] },
      { quantities: [6, 1, 3] }, { quantities: [200, 0, 1], count: 201 }, { schema: 'metalog.entry.v3' },
    ]) {
      expect(() => verifyRecordedEntry(market, deploymentForChain(chainId).implementation, account, amount,
        decodeEntryMemo(JSON.stringify({ ...memo, ...patch }), metadata), metadata, mintReceipt([1, 1, 1, 1, 1, 1, 1, 3, 3, 3]))).toThrow()
    }
  })

  it('rejects undisclosed organizer splits and changed settlement settings despite matching metadata', async () => {
    now = definition.entryOpensAt + 1
    const market = await readMarket(chainId, '7')
    const coefficients = coefficientsFromMoments(0, 50)
    const allocation = allocatePositions(coefficients, ranges, 20)
    extraSplits = true
    await expect(prepareEntry(market, allocation, account, coefficients)).rejects.toThrow('payout splits')
    extraSplits = false
    grace++
    await expect(prepareEntry(market, allocation, account, coefficients)).rejects.toThrow('settlement settings')
  })

  it('accepts receipt effects only for the complete reviewed mint allocation', async () => {
    now = definition.entryOpensAt + 1
    const market = await readMarket(chainId, '7')
    const coefficients = coefficientsFromMoments(0, 50)
    const allocation = allocatePositions(coefficients, ranges, 3)
    const tx = await prepareEntry(market, allocation, account, coefficients)
    const logs = mintLogs(allocation.tierIds.flatMap((tierId, index) => Array<number>(allocation.quantities[index]).fill(tierId)))
    const receipt = { status: 'success', blockNumber: 100n, logs } as unknown as TransactionReceipt
    await expect(checkReceiptEffects(tx, receipt)).resolves.toBeUndefined()
    await expect(checkReceiptEffects(tx, { ...receipt, logs: receipt.logs.slice(1) })).rejects.toThrow('complete reviewed')
    await expect(checkReceiptEffects(tx, { ...receipt, status: 'reverted' })).rejects.toThrow('complete reviewed')
  })
})

it('extracts only confirmed canonical launch events for navigation', () => {
  const receipt = { status: 'success', logs: [{
    address: deployment.deployer,
    topics: encodeEventTopics({ abi: DEFIFA_ABI.DefifaDeployer, eventName: 'LaunchGame', args: {
      gameId: 7n, hook, governor: deployment.governor,
    } }),
    data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [zeroAddress, account]),
  }] } as unknown as TransactionReceipt
  expect(createdMarketId(receipt)).toBe('7')
  expect(() => createdMarketId({ ...receipt, status: 'reverted' })).toThrow('confirmed Defifa market')
  expect(() => createdMarketId({ ...receipt, logs: [{ ...receipt.logs[0], address: account as Address }] })).toThrow('confirmed Defifa market')
})

it.each([{ name: 'uniform', definition }, { name: 'custom', definition: customDefinition }])('checks $name creation receipts and rejects a changed creator or stored definition', async ({ definition }) => {
  uri = encodeMarketDefinition(definition)
  observedRanges = marketRanges(definition)
  const tx = await prepareCreateMarket(definition, chainId, account)
  uri = (decodeFunctionData({ abi: DEFIFA_ABI.DefifaDeployer, data: tx.data }).args![0] as { projectUri: string }).projectUri
  const receipt = { status: 'success', blockNumber: 100n, logs: [{
    address: deployment.deployer,
    topics: encodeEventTopics({ abi: DEFIFA_ABI.DefifaDeployer, eventName: 'LaunchGame', args: {
      gameId: 7n, hook, governor: deployment.governor,
    } }),
    data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [zeroAddress, account]),
  }] } as unknown as TransactionReceipt
  await expect(checkReceiptEffects(tx, receipt)).resolves.toBeUndefined()
  const otherCaller = encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [zeroAddress, hook])
  await expect(checkReceiptEffects(tx, { ...receipt, logs: [{ ...receipt.logs[0], data: otherCaller }] })).rejects.toThrow('creator')
  uri = encodeMarketDefinition({ ...definition, source: 'A different source' })
  await expect(checkReceiptEffects(tx, receipt)).rejects.toThrow('confirmed metadata URI')
})
