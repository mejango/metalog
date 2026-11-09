import {
  decodeFunctionData, encodeAbiParameters, encodeFunctionData, formatEther, getAddress,
  parseAbi, parseEventLogs, zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt,
} from 'viem'
import { allocateManualPositions, allocatePositions, MAX_RECORDED_POSITIONS, type Allocation } from '../domain/allocation'
import { validateCoefficients, type Coefficients } from '../domain/distribution'
import {
  encodeMarketDefinition, marketRanges, SCORECARD_TIMEOUT_BUFFER_SECONDS, validateMarket,
  type MarketDefinition,
} from '../domain/market'
import { formatPercentage, RANGE_DECIMAL_PLACES, type RangeBin } from '../domain/ranges'
import {
  assertChain, assertGameClone, contractRead, DEFIFA_ABI, deploymentForChain, hookMetadata, sameAddress, verifyDefifaDeployment,
} from './defifa-deployment'
import { bendystraw } from './bendystraw'
import { loadMarketMetadata, publishMarketMetadata, type PublishedMarketMetadata } from './market-metadata'
import type { PreparedTransaction } from './transaction'
import { publicClientForChain, SUPPORTED_CHAINS } from './wallet'

export { DEFIFA_ABI, deploymentForChain, SUPPORTED_CHAINS }
export const NATIVE_TOKEN = '0x000000000000000000000000000000000000EEEe' as Address
export const ATTESTATION_GRACE_SECONDS = 86_400
export const ATTESTATION_TIMELOCK_SECONDS = 3_600
// RPC error messages may contain private server endpoint credentials.
export const PUBLIC_MARKET_ERROR = 'Market data could not be verified. Try again.'

export type MarketSnapshot = {
  chainId: number
  projectId: string
  hook: Address
  governor: Address
  referee: Address
  definition: MarketDefinition
  ranges: RangeBin[]
  phase: number
  stage: 'countdown' | 'entry' | 'refund' | 'trading' | 'settlement' | 'complete' | 'no-contest'
  blockNumber: string
  blockTimestamp: number
  potWei: string
  tiers: { tierId: number; supply: string; entrySupply: string | null; priceWei: string; remainingSupply: string }[]
  ratifiedScorecardId: string | null
  ratifiedWeights: { tierId: number; weight: string }[] | null
  cashOutWeightTotal: string
  commitmentsFulfilled: boolean
  noContestTriggered: boolean
}

type RawTier = { id: number; price: bigint; reserveFrequency: number; remainingSupply: number; encodedIpfsUri: Hex }
type RulesetResult = readonly [{ id: number }, { dataHook: Address }]

export function projectNumber(projectId: string): bigint {
  if (!/^[1-9]\d{0,77}$/.test(projectId) || BigInt(projectId) >= 1n << 256n) {
    throw new Error('Enter a valid Defifa project ID.')
  }
  return BigInt(projectId)
}

export function signer(account: Address): Address {
  const address = getAddress(account)
  if (address === zeroAddress) throw new Error('Connect a wallet before preparing this transaction.')
  return address
}

function gameStage(phase: number, definition: MarketDefinition, timestamp: number): MarketSnapshot['stage'] {
  switch (phase) {
    case 0: return 'countdown'
    case 1: return 'entry'
    case 2: return 'refund'
    case 3: return timestamp < definition.resolvesAt ? 'trading' : 'settlement'
    case 4: return 'complete'
    case 5: return 'no-contest'
    default: throw new Error('The game returned an unknown phase.')
  }
}

/** Every field is read at one block. A failed read never becomes an empty market or zero balance. */
export async function readMarket(chainId: number, projectId: string): Promise<MarketSnapshot> {
  const client = publicClientForChain(chainId)
  await assertChain(client, chainId)
  const block = await client.getBlock()
  return readMarketAt(client, chainId, projectId, block.number, Number(block.timestamp))
}

export async function readMarketAt(
  client: PublicClient, chainId: number, projectId: string, blockNumber: bigint, timestamp: number,
): Promise<MarketSnapshot> {
  const d = deploymentForChain(chainId)
  const id = projectNumber(projectId)
  const read = <T>(address: Address, contract: keyof typeof DEFIFA_ABI, fn: string, args: readonly unknown[] = []) =>
    contractRead<T>(client, address, contract, fn, args, blockNumber)
  const [uri, currentRuleset, token, controller, projectOwner, times, phase, pot, ratified, fulfilled, noContest] = await Promise.all([
    read<string>(d.controller, 'JBController', 'uriOf', [id]),
    read<RulesetResult>(d.controller, 'JBController', 'currentRulesetOf', [id]),
    read<Address>(d.deployer, 'DefifaDeployer', 'tokenOf', [id]),
    read<Address>(d.directory, 'JBDirectory', 'controllerOf', [id]),
    read<Address>(d.projects, 'JBProjects', 'ownerOf', [id]),
    read<readonly [number, number, number]>(d.deployer, 'DefifaDeployer', 'timesFor', [id]),
    read<number>(d.deployer, 'DefifaDeployer', 'currentGamePhaseOf', [id]),
    read<readonly [bigint, Address, bigint]>(d.deployer, 'DefifaDeployer', 'currentGamePotOf', [id, false]),
    read<bigint>(d.governor, 'DefifaGovernor', 'ratifiedScorecardIdOf', [id]),
    read<boolean>(d.deployer, 'DefifaDeployer', 'commitmentsFulfilledFor', [id]),
    read<boolean>(d.deployer, 'DefifaDeployer', 'noContestTriggeredFor', [id]),
  ])
  if (!sameAddress(controller, d.controller) || !sameAddress(projectOwner, d.deployer)
    || !sameAddress(token, NATIVE_TOKEN) || !sameAddress(pot[1], NATIVE_TOKEN) || Number(pot[2]) !== 18) {
    throw new Error('This project is not a supported native-token Defifa market.')
  }
  const published = await loadMarketMetadata(uri)
  const definition = published.definition
  const ranges = marketRanges(definition)
  if (Number(times[0]) !== definition.entryClosesAt || Number(times[2]) !== 0
    || Number(times[1]) !== definition.entryClosesAt - definition.entryOpensAt) {
    throw new Error('The market metadata does not match the onchain entry times.')
  }
  let hook = currentRuleset[1].dataHook
  if (sameAddress(hook, zeroAddress)) {
    hook = (await read<RulesetResult>(d.controller, 'JBController', 'latestQueuedRulesetOf', [id]))[1].dataHook
  }
  assertGameClone(await client.getCode({ address: hook, blockNumber }), d.implementation)
  const [terminal, governor, origin, store, reporter, hookProjectId, referee, attestationStart, rawTiers, defaultDelegate] = await Promise.all([
    read<Address>(d.directory, 'JBDirectory', 'primaryTerminalOf', [id, NATIVE_TOKEN]),
    read<Address>(hook, 'DefifaHook', 'owner'),
    read<Address>(hook, 'DefifaHook', 'CODE_ORIGIN'),
    read<Address>(hook, 'DefifaHook', 'store'),
    read<Address>(hook, 'DefifaHook', 'gamePhaseReporter'),
    read<bigint>(hook, 'DefifaHook', 'projectId'),
    read<Address>(d.governor, 'DefifaGovernor', 'refereeOf', [id]),
    read<bigint>(d.referee, 'DefifaVotingReferee', 'attestationStartTimeOf', [id]),
    read<RawTier[]>(d.store, 'JB721TiersHookStore', 'tiersOf', [hook, [], false, 0n, 128n]),
    read<Address>(hook, 'DefifaHook', 'defaultAttestationDelegate'),
  ])
  if (!sameAddress(terminal, d.terminal) || !sameAddress(governor, d.governor)
    || !sameAddress(origin, d.implementation) || !sameAddress(store, d.store)
    || !sameAddress(reporter, d.deployer) || hookProjectId !== id || !sameAddress(referee, d.referee)) {
    throw new Error('The game contracts do not match the configured Defifa deployment.')
  }
  if (Number(attestationStart) !== definition.resolvesAt || rawTiers.length !== ranges.length) {
    throw new Error('The market metadata does not match its resolution time or tiers.')
  }
  if (!sameAddress(defaultDelegate, definition.defaultAttestationDelegate ?? zeroAddress)) {
    throw new Error('The market oracle does not match its onchain setting.')
  }
  if (published.mode === 'ipfs') {
    const metadataAbi = parseAbi(['function contractURI() view returns (string)', 'function baseURI() view returns (string)'])
    const [contractUri, baseUri] = await Promise.all([
      client.readContract({ address: hook, abi: metadataAbi, functionName: 'contractURI', blockNumber }),
      client.readContract({ address: hook, abi: metadataAbi, functionName: 'baseURI', blockNumber }),
    ])
    if (contractUri !== published.contractUri || baseUri !== '') {
      throw new Error('The collection metadata does not match this market.')
    }
  }
  const tiers = await Promise.all(rawTiers.map(async (tier, index) => {
    const tierId = Number(tier.id)
    const [name, supply, redeemed] = await Promise.all([
      read<string>(hook, 'DefifaHook', 'tierNameOf', [BigInt(tierId)]),
      read<bigint>(hook, 'DefifaHook', 'currentSupplyOfTier', [BigInt(tierId)]),
      Number(phase) === 4 ? read<bigint>(hook, 'DefifaHook', 'tokensRedeemedFrom', [BigInt(tierId)]) : Promise.resolve(0n),
    ])
    if (tierId !== ranges[index].tierId || name !== ranges[index].label || Number(tier.reserveFrequency) !== 0
      || tier.price !== BigInt(definition.unitPriceWei)
      || (published.mode === 'ipfs' && tier.encodedIpfsUri !== published.encodedTierUris[index])) {
      throw new Error('The onchain ranges, price or reserves do not match this market.')
    }
    return {
      tierId, supply: supply.toString(), entrySupply: Number(phase) === 3 || Number(phase) === 4 ? (supply + redeemed).toString() : null,
      priceWei: tier.price.toString(), remainingSupply: String(tier.remainingSupply),
    }
  }))
  // DefifaHookLib.validateAndBuildWeights stores the exact scorecard at [tierId - 1].
  const weights = ratified === 0n ? null : await read<readonly bigint[]>(hook, 'DefifaHook', 'tierCashOutWeights')
  const ratifiedWeights = weights === null ? null : ranges.map(range => ({
    tierId: range.tierId, weight: weights[range.tierId - 1].toString(),
  }))
  return {
    chainId, projectId, hook, governor, referee: d.referee, definition, ranges, phase: Number(phase),
    stage: gameStage(Number(phase), definition, timestamp), blockNumber: blockNumber.toString(), blockTimestamp: timestamp,
    potWei: pot[0].toString(), tiers, ratifiedScorecardId: ratified === 0n ? null : ratified.toString(),
    ratifiedWeights, cashOutWeightTotal: '1000000000000000000',
    commitmentsFulfilled: fulfilled, noContestTriggered: noContest,
  }
}

async function assertEntryRules(client: PublicClient, market: MarketSnapshot): Promise<void> {
  const d = deploymentForChain(market.chainId)
  const id = projectNumber(market.projectId)
  const block = BigInt(market.blockNumber)
  const [scoring, splitsAddress, safety, grace, timelock] = await Promise.all([
    contractRead<RulesetResult>(client, d.controller, 'JBController', 'latestQueuedRulesetOf', [id], block),
    contractRead<Address>(client, d.controller, 'JBController', 'SPLITS', [], block),
    contractRead<readonly [bigint, number]>(client, d.deployer, 'DefifaDeployer', 'safetyParamsOf', [id], block),
    contractRead<bigint>(client, d.referee, 'DefifaVotingReferee', 'attestationGracePeriodOf', [id], block),
    contractRead<bigint>(client, d.governor, 'DefifaGovernor', 'timelockDurationOf', [id], block),
  ])
  const expectedTimeout = market.definition.resolvesAt - market.definition.entryClosesAt + SCORECARD_TIMEOUT_BUFFER_SECONDS
  if (safety[0] !== 0n || Number(safety[1]) !== expectedTimeout || grace !== BigInt(ATTESTATION_GRACE_SECONDS)
    || timelock !== BigInt(ATTESTATION_TIMELOCK_SECONDS)) {
    throw new Error('The game settlement settings differ from this supported market definition.')
  }
  type Split = { projectId: bigint; beneficiary: Address; hook: Address; preferAddToBalance: boolean }
  const splits = await contractRead<Split[]>(
    client, splitsAddress, 'JBSplits', 'splitsOf', [id, BigInt(scoring[0].id), BigInt(NATIVE_TOKEN)], block,
  )
  // The pinned deployer always appends these two protocol splits after any organizer splits.
  const projects = [d.deployerGetters.DEFIFA_PROJECT_ID, d.deployerGetters.BASE_PROTOCOL_PROJECT_ID]
  if (splits.length !== 2 || splits.some((split, index) => split.projectId !== BigInt(projects[index])
    || !sameAddress(split.beneficiary, market.hook) || !sameAddress(split.hook, zeroAddress) || split.preferAddToBalance)) {
    throw new Error('This game has payout splits outside the supported market definition.')
  }
}

const GAMES_QUERY = `query Games($chainId: Int!) {
  defifaGames(where: { chainId: $chainId, gameType: erc1155 }, orderBy: "createdAt", orderDirection: "desc", limit: 20) {
    items { projectId deployer } } }`

/**
 * Configured IDs plus the newest 1155 games Bendystraw has seen from this deployment. Every game is read and
 * validated on chain; discovered games that are not Metalog markets are left out quietly.
 */
export async function listMarkets(chainId: number): Promise<{ markets: MarketSnapshot[]; errors: string[] }> {
  const d = deploymentForChain(chainId)
  const configuration = process.env.METALOG_MARKETS || process.env.NEXT_PUBLIC_METALOG_MARKETS || ''
  const errors: string[] = []
  const configured = new Set<string>()
  for (const entry of configuration.split(',').map(value => value.trim()).filter(Boolean)) {
    const match = /^(\d+):([1-9]\d{0,77})$/.exec(entry)
    if (!match) { errors.push('A configured market ID is invalid.'); continue }
    if (Number(match[1]) === chainId) configured.add(match[2])
  }
  const discovered = await bendystraw<{ defifaGames: { items: { projectId: number; deployer: string }[] } }>(chainId, GAMES_QUERY, { chainId })
    .then(data => data.defifaGames.items.filter(game => sameAddress(game.deployer, d.deployer)).map(game => String(game.projectId)))
    .catch(() => { errors.push('Recent markets could not be listed. Configured markets are still shown.'); return [] as string[] })
  const ids = [...new Set([...configured, ...discovered])].slice(0, 20)
  const results = await Promise.allSettled(ids.map(id => readMarket(chainId, id)))
  const markets: MarketSnapshot[] = []
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') markets.push(result.value)
    else if (configured.has(ids[index])) errors.push(`Game ${ids[index]}: ${PUBLIC_MARKET_ERROR}`)
  })
  return { markets, errors }
}

export function launchData(definition: MarketDefinition, chainId: number, published: PublishedMarketMetadata) {
  const d = deploymentForChain(chainId)
  return {
    name: definition.prompt, projectUri: published.projectUri, contractUri: published.contractUri,
    baseUri: '',
    tiers: marketRanges(definition).map((range, index) => ({
      name: range.label, reservedRate: 0, reservedTokenBeneficiary: zeroAddress, encodedIpfsUri: published.encodedTierUris[index],
      shouldUseReservedTokenBeneficiaryAsDefault: false,
    })),
    tierPrice: BigInt(definition.unitPriceWei), token: { token: NATIVE_TOKEN, decimals: 18, currency: 1 },
    mintPeriodDuration: definition.entryClosesAt - definition.entryOpensAt, refundPeriodDuration: 0,
    start: BigInt(definition.entryClosesAt), splits: [], defaultAttestationDelegate: definition.defaultAttestationDelegate ?? zeroAddress,
    defaultTokenUriResolver: zeroAddress, terminal: d.terminal, minParticipation: 0n,
    scorecardTimeout: definition.resolvesAt - definition.entryClosesAt + SCORECARD_TIMEOUT_BUFFER_SECONDS,
    timelockDuration: BigInt(ATTESTATION_TIMELOCK_SECONDS),
    // The voting referee opens attestations when observation ends.
    referee: d.referee, refereeData: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }],
      [BigInt(definition.resolvesAt), BigInt(ATTESTATION_GRACE_SECONDS)]),
  }
}

export function createdMarketId(receipt: TransactionReceipt): string {
  const logs = parseEventLogs({ abi: DEFIFA_ABI.DefifaDeployer, logs: receipt.logs, eventName: 'LaunchGame', strict: true })
    .filter(log => SUPPORTED_CHAINS.some(chain => sameAddress(log.address, deploymentForChain(chain.id).deployer)))
  if (receipt.status !== 'success' || logs.length !== 1) throw new Error('The receipt does not contain one confirmed Defifa market.')
  return ((logs[0].args as { gameId: bigint }).gameId).toString()
}

async function verifyLaunchReceipt(
  client: PublicClient, chainId: number, owner: Address, published: PublishedMarketMetadata, receipt: TransactionReceipt,
): Promise<void> {
  const definition = published.definition
  const d = deploymentForChain(chainId)
  const projectId = createdMarketId(receipt)
  const launch = parseEventLogs({ abi: DEFIFA_ABI.DefifaDeployer, logs: receipt.logs, eventName: 'LaunchGame', strict: true })
    .find(log => sameAddress(log.address, d.deployer))
  if (!launch || !sameAddress((launch.args as { caller: Address }).caller, owner)) {
    throw new Error('The confirmed market does not match its creator.')
  }
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  const uri = await contractRead<string>(client, d.controller, 'JBController', 'uriOf', [BigInt(projectId)], block.number)
  if (uri !== published.projectUri) throw new Error('The confirmed metadata URI does not match the reviewed transaction.')
  const market = await readMarketAt(client, chainId, projectId, block.number, Number(block.timestamp))
  if (encodeMarketDefinition(market.definition) !== encodeMarketDefinition(definition)) {
    throw new Error('The confirmed market definition does not match the reviewed transaction.')
  }
}

export type PositionMove = { from: Address; to: Address; id: bigint; value: bigint }

/** Every 1155 single and batch transfer the hook emitted, one row per position ID. */
export function receiptMoves(hook: Address, receipt: Pick<TransactionReceipt, 'logs'>): PositionMove[] {
  return parseEventLogs({ abi: DEFIFA_ABI.DefifaHook, logs: receipt.logs, strict: true })
    .filter(log => sameAddress(log.address, hook) && (log.eventName === 'TransferSingle' || log.eventName === 'TransferBatch'))
    .flatMap(log => {
      const args = log.args as { from: Address; to: Address; id?: bigint; value?: bigint; ids?: readonly bigint[]; values?: readonly bigint[] }
      return log.eventName === 'TransferSingle'
        ? [{ from: args.from, to: args.to, id: args.id!, value: args.value! }]
        : args.ids!.map((id, index) => ({ from: args.from, to: args.to, id, value: args.values![index] }))
    })
}

/** Positions moved per range, in market range order. */
export function quantitiesOf(market: Pick<MarketSnapshot, 'ranges'>, moves: PositionMove[]): number[] {
  return market.ranges.map(range => Number(moves.filter(move => move.id === BigInt(range.tierId)).reduce((sum, move) => sum + move.value, 0n)))
}

function verifyEntryReceipt(market: MarketSnapshot, owner: Address, allocation: Allocation, receipt: TransactionReceipt): void {
  const mints = receiptMoves(market.hook, receipt).filter(move => sameAddress(move.from, zeroAddress) && sameAddress(move.to, owner))
  const expected = market.ranges.map(range => allocation.quantities[allocation.tierIds.indexOf(range.tierId)] ?? 0)
  if (receipt.status !== 'success' || JSON.stringify(quantitiesOf(market, mints)) !== JSON.stringify(expected)) {
    throw new Error('The receipt does not confirm the complete reviewed position allocation.')
  }
}

function entryMetadata(implementation: Address, definition: MarketDefinition, beneficiary: Address, allocation: Allocation) {
  const delegate = definition.defaultAttestationDelegate ?? beneficiary
  const minted = allocation.tierIds.flatMap((tierId, index) => allocation.quantities[index] > 0 ? [[tierId, allocation.quantities[index]]] : [])
  return { delegate, metadata: hookMetadata(implementation, 'pay', encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint16[]' }, { type: 'uint256[]' }],
    [delegate, minted.map(([tierId]) => tierId), minted.map(([, count]) => BigInt(count))],
  )) }
}

export function decodeEntryMemo(memoText: string, metadata: Hex) {
  if (memoText.length > 1_024 || metadata.length > 14_000) throw new Error('The recorded curve entry is too large.')
  const memo = JSON.parse(memoText) as { schema?: unknown; units?: unknown; coefficients?: unknown; count?: unknown; mode?: unknown; quantities?: unknown }
  if (!memo || (memo.schema !== 'metalog.entry.v1' && memo.schema !== 'metalog.entry.v2') || memo.units !== 'percentage-points'
    || !Array.isArray(memo.coefficients) || typeof memo.count !== 'number') {
    throw new Error('The recorded curve metadata is not supported.')
  }
  if (memo.schema === 'metalog.entry.v2' && (memo.mode !== 'manual' || !Array.isArray(memo.quantities))) {
    throw new Error('The recorded manual allocation is not supported.')
  }
  const coefficients = validateCoefficients(memo.coefficients)
  return { ...memo, coefficients, count: memo.count, schema: memo.schema, quantities: memo.quantities as number[] | undefined }

}

/** The shared recorded-entry rule used by recovery and public receipt evidence. */
export function verifyRecordedEntry(
  market: MarketSnapshot, implementation: Address, owner: Address, amount: bigint,
  memo: ReturnType<typeof decodeEntryMemo>, metadata: Hex, receipt: TransactionReceipt,
): { coefficients: Coefficients; allocation: Allocation } {
  const coefficients = memo.coefficients
  const allocation = memo.schema === 'metalog.entry.v1'
    ? allocatePositions(coefficients, market.ranges, memo.count, MAX_RECORDED_POSITIONS)
    : allocateManualPositions(coefficients, market.ranges, memo.quantities as number[], MAX_RECORDED_POSITIONS)
  if (memo.count !== allocation.count) throw new Error('The recorded position total does not match the position counts.')
  if (amount !== BigInt(market.definition.unitPriceWei) * BigInt(allocation.count)) {
    throw new Error('The recorded entry does not pay the exact position price.')
  }
  if (metadata !== entryMetadata(implementation, market.definition, owner, allocation).metadata) {
    throw new Error('The recorded mint metadata does not match the position allocation.')
  }
  verifyEntryReceipt(market, owner, allocation, receipt)
  return { coefficients, allocation }
}

/** Recovery rebuilds the effect checks from recorded calldata, without authorizing another send. */
export async function verifyDefifaTransactionReceipt(
  request: { chainId: number; account: Address; to: Address; data: Hex; value: bigint },
  receipt: TransactionReceipt,
): Promise<void> {
  const owner = signer(request.account)
  const client = publicClientForChain(request.chainId)
  const d = await verifyDefifaDeployment(client, request.chainId, receipt.blockNumber)
  if (sameAddress(request.to, d.deployer)) {
    const decoded = decodeFunctionData({ abi: DEFIFA_ABI.DefifaDeployer, data: request.data })
    if (decoded.functionName !== 'launchGameWith') {
      const { verifyLifecycleReceipt } = await import('./defifa-lifecycle')
      return verifyLifecycleReceipt(request, receipt)
    }
    const launch = decoded.args?.[0] as { projectUri: string }
    const published = await loadMarketMetadata(launch.projectUri)
    const definition = published.definition
    const expectedData = encodeFunctionData({
      abi: DEFIFA_ABI.DefifaDeployer, functionName: 'launchGameWith', args: [launchData(definition, request.chainId, published)],
    })
    if (expectedData !== request.data) throw new Error('The recorded creation differs from the supported market definition.')
    return verifyLaunchReceipt(client, request.chainId, owner, published, receipt)
  }
  if (!sameAddress(request.to, d.terminal)) {
    if (request.value !== 0n) throw new Error('The recorded transaction has an unsupported target.')
    const { verifyLifecycleReceipt } = await import('./defifa-lifecycle')
    return verifyLifecycleReceipt(request, receipt)
  }
  const decoded = decodeFunctionData({ abi: DEFIFA_ABI.JBMultiTerminal, data: request.data })
  if (decoded.functionName !== 'pay') {
    const { verifyLifecycleReceipt } = await import('./defifa-lifecycle')
    return verifyLifecycleReceipt(request, receipt)
  }
  const [projectId, token, amount, beneficiary, minimum, memoText, metadata] = decoded.args as
    readonly [bigint, Address, bigint, Address, bigint, string, Hex]
  if (!sameAddress(token, NATIVE_TOKEN) || !sameAddress(beneficiary, owner) || amount !== request.value || minimum !== 0n) {
    throw new Error('The recorded entry amount or beneficiary does not match.')
  }
  const memo = decodeEntryMemo(memoText, metadata)
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  const market = await readMarketAt(client, request.chainId, projectId.toString(), block.number, Number(block.timestamp))
  await assertEntryRules(client, market)
  verifyRecordedEntry(market, d.implementation, owner, amount, memo, metadata, receipt)
}

export async function prepareCreateMarket(
  input: MarketDefinition, chainId: number, account: Address,
): Promise<PreparedTransaction> {
  const definition = validateMarket(input)
  const owner = signer(account)
  const client = publicClientForChain(chainId)
  const d = deploymentForChain(chainId)
  const freshFee = async () => {
    const block = await client.getBlock()
    await verifyDefifaDeployment(client, chainId, block.number)
    validateMarket(definition, Number(block.timestamp))
    if (definition.entryOpensAt <= Number(block.timestamp)) throw new Error('Entry must open in the future. Update the opening time.')
    return contractRead<bigint>(client, d.projects, 'JBProjects', 'creationFee', [], block.number)
  }
  await freshFee()
  const published = await publishMarketMetadata(definition)
  if (published.mode !== 'ipfs') throw new Error('Market metadata must be published through Center.')
  const fee = await freshFee()
  const ranges = marketRanges(definition)
  const data = encodeFunctionData({ abi: DEFIFA_ABI.DefifaDeployer, functionName: 'launchGameWith', args: [launchData(definition, chainId, published)] })
  return {
    chainId, account: owner, to: d.deployer, data, value: fee, title: 'Create market',
    details: [
      { label: 'Question', value: definition.prompt },
      { label: 'Source', value: definition.source },
      { label: 'Metadata', value: published.projectUri },
      { label: 'Resolution rule', value: definition.resolutionRule },
      { label: 'Oracle', value: definition.defaultAttestationDelegate ?? 'None; position holders retain voting power.' },
      { label: 'Ranges', value: String(ranges.length) },
      definition.rangeBoundaries === undefined
        ? { label: 'Range width', value: `${definition.rangeWidth} percentage points` }
        : { label: 'Range cutoffs', value: ranges.slice(0, -1).map(range => formatPercentage(range.upper!, RANGE_DECIMAL_PLACES)).join(', ') },
      { label: 'Price per position', value: `${formatEther(BigInt(definition.unitPriceWei))} ETH` },
      { label: 'Entry opens', value: new Date(definition.entryOpensAt * 1000).toISOString() },
      { label: 'Entry closes', value: new Date(definition.entryClosesAt * 1000).toISOString() },
      { label: 'Observation ends', value: new Date(definition.resolvesAt * 1000).toISOString() },
      { label: 'Creation fee', value: `${formatEther(fee)} ETH` },
    ],
    reverify: async () => {
      const currentMetadata = await loadMarketMetadata(published.projectUri)
      if (encodeMarketDefinition(currentMetadata.definition) !== encodeMarketDefinition(definition)
        || JSON.stringify(currentMetadata.encodedTierUris) !== JSON.stringify(published.encodedTierUris)) {
        throw new Error('The metadata no longer matches the reviewed market.')
      }
      if (await freshFee() !== fee) throw new Error('The creation fee changed. Review a fresh transaction.')
    },
    verifyReceipt: receipt => verifyLaunchReceipt(client, chainId, owner, published, receipt),
  }
}

export async function prepareEntry(
  market: MarketSnapshot, allocation: Allocation, account: Address, coefficients: Coefficients,
): Promise<PreparedTransaction> {
  const owner = signer(account)
  const a = validateCoefficients(coefficients)
  const definition = validateMarket(market.definition)
  if (!allocation || (allocation.mode !== 'curve' && allocation.mode !== 'manual')) {
    throw new Error('The position allocation mode is not supported.')
  }
  const ranges = marketRanges(definition)
  const expected = allocation.mode === 'manual'
    ? allocateManualPositions(a, ranges, allocation.quantities)
    : allocatePositions(a, ranges, allocation.count)
  if ((Object.keys(expected) as (keyof Allocation)[]).some(key => JSON.stringify(expected[key]) !== JSON.stringify(allocation[key]))) {
    throw new Error(allocation.mode === 'curve'
      ? 'The position allocation does not match the submitted curve.'
      : 'The position allocation does not match the submitted position counts.')
  }
  const client = publicClientForChain(market.chainId)
  const d = deploymentForChain(market.chainId)
  const refresh = async () => {
    const block = await client.getBlock()
    await verifyDefifaDeployment(client, market.chainId, block.number)
    const current = await readMarketAt(client, market.chainId, market.projectId, block.number, Number(block.timestamp))
    if (encodeMarketDefinition(current.definition) !== encodeMarketDefinition(definition)
      || !sameAddress(current.hook, market.hook)) throw new Error('The market changed. Review the entry again.')
    if (current.phase !== 1 || current.blockTimestamp < definition.entryOpensAt
      || current.blockTimestamp >= definition.entryClosesAt) throw new Error('This market is not accepting entries.')
    await assertEntryRules(client, current)
    for (let index = 0; index < expected.quantities.length; index++) {
      if (BigInt(expected.quantities[index]) > BigInt(current.tiers[index].remainingSupply)) {
        throw new Error('A range no longer has enough positions available.')
      }
    }
    return current
  }
  const current = await refresh()
  const amount = BigInt(definition.unitPriceWei) * BigInt(expected.count)
  const { delegate, metadata } = entryMetadata(d.implementation, definition, owner, expected)
  const memo = JSON.stringify(expected.mode === 'curve'
    ? { schema: 'metalog.entry.v1', units: 'percentage-points', coefficients: a, count: expected.count }
    : { schema: 'metalog.entry.v2', units: 'percentage-points', coefficients: a, mode: 'manual', quantities: expected.quantities, count: expected.count })
  return {
    chainId: market.chainId, account: owner, to: d.terminal, value: amount, title: expected.mode === 'manual' ? 'Submit positions' : 'Submit curve',
    data: encodeFunctionData({
      abi: DEFIFA_ABI.JBMultiTerminal, functionName: 'pay',
      args: [projectNumber(market.projectId), NATIVE_TOKEN, amount, owner, 0n, memo, metadata],
    }),
    details: [
      { label: 'Question', value: definition.prompt },
      { label: 'Positions', value: String(expected.count) },
      { label: 'Cost', value: `${formatEther(amount)} ETH` },
      { label: 'Voting address', value: delegate },
      { label: 'Voting power', value: 'Applies to all your existing and newly minted positions in the selected ranges. You can change the voting address while entries are open.' },
      ...expected.quantities.flatMap((quantity, index) => quantity > 0
        ? [{ label: current.ranges[index].label, value: String(quantity) }] : []),
    ],
    reverify: async () => { await refresh() },
    verifyReceipt: receipt => verifyEntryReceipt(current, owner, expected, receipt),
  }
}
