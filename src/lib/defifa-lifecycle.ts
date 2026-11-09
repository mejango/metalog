import {
  decodeAbiParameters, encodeAbiParameters,
  encodeFunctionData, getAbiItem, getAddress, parseAbi, parseEventLogs, zeroAddress,
  type Address, type Hex, type PublicClient, type TransactionReceipt,
} from 'viem'
import { NATIVE_TOKEN, projectNumber, quantitiesOf, readMarketAt, receiptMoves, signer, type MarketSnapshot } from './defifa'
import { assertChain, contractRead, DEFIFA_ABI, deploymentForChain, hookMetadata, sameAddress, verifyDefifaDeployment } from './defifa-deployment'
import { bendystraw } from './bendystraw'
import { publicClientForChain } from './wallet'
import { firstBlockAtTimestamp, MAX_LOG_BLOCKS } from './history-blocks'
import type { PreparedTransaction } from './transaction'
import { decodeDefifaTransactionCall } from './transaction-scope'
import { SCORECARD_WEIGHT_TOTAL, type TierWeight } from '../domain/scorecard'
import { MAX_POSITIONS } from '../domain/allocation'
import { phaseCapabilities, type CashOutMode } from './lifecycle-phase'
export { SCORECARD_WEIGHT_TOTAL, scorecardWeightsFromPercentages, type TierWeight } from '../domain/scorecard'

const MAX_LOG_REQUESTS = 16
// Center's hosted provider rejects wider windows with a generic -32005. Bound
// requests up front; do not mistake that same code on a small request for a range limit.
const MAX_SCORECARDS_PER_PAGE = 100
const STATE_NAMES = ['Pending', 'Active', 'Defeated', 'Succeeded', 'Queued', 'Ratified'] as const
const ERC20_ABI = parseAbi(['function decimals() view returns (uint8)', 'event Transfer(address indexed from,address indexed to,uint256 value)'])

/** An ERC-1155 balance: every position in a range shares the range's token ID. */
export type OwnedPosition = { tierId: number; count: number }
export type LifecyclePageOptions = { blockNumber?: string; scorecardCursor?: string }
export type ScorecardSnapshot = {
  scorecardId: string
  weights: TierWeight[]
  submitter: Address
  state: number
  stateName: string
  submittedAt: number
  attestationsBegin: number
  gracePeriodEnds: number
  attestationCount: string
  /** Attestation weight this result needs, as the referee snapshotted it at submission. */
  quorum: string
  accountWeight: string | null
  hasAttested: boolean
  /** Sent from the referee to the governor, which ratifies after its timelock. */
  forwarded: boolean
  /** When the governor's timelock ends, once forwarded. */
  ratifiableAt: number | null
  canAttest: boolean
  canRevoke: boolean
  canForward: boolean
  canRatify: boolean
}
export type LifecycleSnapshot = {
  market: MarketSnapshot
  account: Address | null
  positions: OwnedPosition[]
  delegates: { tierId: number; delegate: Address }[]
  scorecards: ScorecardSnapshot[]
  scorecardsNextCursor: string | null
  scorecardsComplete: boolean
  attestationGraceSeconds: number
  timelockSeconds: number
  noContestAfter: number
  canSubmitScorecard: boolean
  canDelegate: boolean
  canFulfill: boolean
  canTriggerNoContest: boolean
  cashOutMode: CashOutMode
}
export type LifecycleAction =
  | { kind: 'transfer'; tierId: number; count: number; to: Address }
  | { kind: 'delegate'; tierIds: number[]; delegatee: Address }
  | { kind: 'submit-scorecard'; weights: TierWeight[] }
  | { kind: 'attest' | 'revoke'; scorecardId: string }
  | { kind: 'forward' | 'ratify'; weights: TierWeight[] }
  | { kind: 'fulfill' | 'no-contest' }
  | { kind: 'cash-out'; positions: OwnedPosition[]; minReclaimedWei: string }
export type CashOutQuote = {
  blockNumber: string
  reclaimWei: string
  defifaTokenWei: string
  baseProtocolTokenWei: string
  defifaToken: Address
  baseProtocolToken: Address
}
export type LifecycleRequest = Pick<PreparedTransaction, 'chainId' | 'account' | 'to' | 'data' | 'value'>

type NativeWeight = { id: bigint; cashOutWeight: bigint }
type SubmittedArgs = { gameId: bigint; scorecardId: bigint; tierWeights: NativeWeight[]; caller: Address }

function uint(value: string, name: string, zero = true): bigint {
  if (!/^(0|[1-9]\d{0,77})$/.test(value) || BigInt(value) >= 1n << 256n || (!zero && value === '0')) {
    throw new Error(`Enter a valid ${name}.`)
  }
  return BigInt(value)
}

function nativeWeights(market: MarketSnapshot, weights: TierWeight[]): NativeWeight[] {
  if (!Array.isArray(weights) || !weights.length || weights.length > market.ranges.length) {
    throw new Error('Provide a result for this market’s ranges.')
  }
  let previous = 0
  const result = weights.map(item => {
    if (!Number.isSafeInteger(item.tierId) || item.tierId <= previous
      || !market.ranges.some(range => range.tierId === item.tierId)) {
      throw new Error('Result ranges must be unique and in ascending order.')
    }
    previous = item.tierId
    return { id: BigInt(item.tierId), cashOutWeight: uint(item.weight, 'result weight') }
  })
  if (result.reduce((sum, item) => sum + item.cashOutWeight, 0n) !== SCORECARD_WEIGHT_TOTAL) {
    throw new Error('The result must assign exactly 100% of the pot.')
  }
  return result
}

/** Ascending, unique ranges of this market with positive whole counts. */
function positionsFor(market: MarketSnapshot, positions: readonly OwnedPosition[]): OwnedPosition[] {
  if (!Array.isArray(positions) || !positions.length || positions.length > market.ranges.length) throw new Error('Select positions in this market’s ranges.')
  let previous = 0
  for (const { tierId, count } of positions) {
    if (!Number.isSafeInteger(tierId) || tierId <= previous || !market.ranges.some(range => range.tierId === tierId)) {
      throw new Error('Selected ranges must be unique and in ascending order.')
    }
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_POSITIONS) throw new Error(`Select between 1 and ${MAX_POSITIONS} positions per range.`)
    previous = tierId
  }
  return positions.map(({ tierId, count }) => ({ tierId, count }))
}

async function freshMarket(market: MarketSnapshot): Promise<{ client: PublicClient; market: MarketSnapshot }> {
  const client = publicClientForChain(market.chainId)
  await assertChain(client, market.chainId)
  const block = await client.getBlock()
  await verifyDefifaDeployment(client, market.chainId, block.number)
  const current = await readMarketAt(client, market.chainId, market.projectId, block.number, Number(block.timestamp))
  if (!sameAddress(current.hook, market.hook)) throw new Error('The market contract changed. Reload it before continuing.')
  return { client, market: current }
}

function readAt(client: PublicClient, market: MarketSnapshot) {
  return <T>(address: Address, contract: keyof typeof DEFIFA_ABI, fn: string, args: readonly unknown[] = []) =>
    contractRead<T>(client, address, contract, fn, args, BigInt(market.blockNumber))
}

async function assertOwned(client: PublicClient, market: MarketSnapshot, positions: readonly OwnedPosition[], account: Address) {
  const held = await readPositions(client, market, account)
  if (positions.some(position => (held.find(item => item.tierId === position.tierId)?.count ?? 0) < position.count)) {
    throw new Error('Your wallet no longer holds every selected position.')
  }
}

/** One batched balance read covers every range. */
async function readPositions(client: PublicClient, market: MarketSnapshot, account: Address | null): Promise<OwnedPosition[]> {
  if (!account) return []
  const balances = await readAt(client, market)<readonly bigint[]>(market.hook, 'DefifaHook', 'balanceOfBatch',
    [market.ranges.map(() => account), market.ranges.map(range => BigInt(range.tierId))])
  return market.ranges.flatMap((range, index) => balances[index] > 0n ? [{ tierId: range.tierId, count: Number(balances[index]) }] : [])
}

/** Bounded binary search finds the first block where scorecard submissions could exist. */
async function firstScoringBlock(client: PublicClient, market: MarketSnapshot): Promise<bigint> {
  try { return await firstBlockAtTimestamp(client, market, market.definition.entryClosesAt) }
  catch (error) {
    if (error instanceof Error && error.message === 'The history range could not be resolved within its read limit.') {
      throw new Error('The results history range could not be resolved within its read limit.')
    }
    throw error
  }
}

async function readScorecards(
  client: PublicClient, market: MarketSnapshot, account: Address | null, grace: number, timelock: number, cursor?: string,
): Promise<{ scorecards: ScorecardSnapshot[]; next: string | null; complete: boolean }> {
  if (market.phase < 3) return { scorecards: [], next: null, complete: true }
  const head = BigInt(market.blockNumber)
  const end = cursor === undefined ? head : uint(cursor, 'results cursor')
  if (end > head) throw new Error('The results cursor is outside this snapshot.')
  const first = await firstScoringBlock(client, market)
  if (end < first) return { scorecards: [], next: null, complete: true }
  const event = getAbiItem({ abi: DEFIFA_ABI.DefifaVotingReferee, name: 'ScorecardSubmitted' })
  if (!event || event.type !== 'event') throw new Error('The result event ABI is unavailable.')
  // Scan indexed game history in Center-compatible windows. Reduce only an explicitly
  // unsupported log range/result size; transport outages and rate limits remain errors. Accepted chunks
  // are continued automatically, bounded by 16 RPC calls and 100 proposals per page.
  let nextEnd = end
  let span = end - first + 1n > MAX_LOG_BLOCKS ? MAX_LOG_BLOCKS : end - first + 1n
  const collected: Awaited<ReturnType<PublicClient['getLogs']>> = []
  let madeProgress = false
  for (let requests = 0; nextEnd >= first && requests < MAX_LOG_REQUESTS; requests++) {
    const fromBlock = nextEnd - first + 1n > span ? nextEnd - span + 1n : first
    try {
      const result = await client.getLogs({ address: market.referee, event, args: { gameId: projectNumber(market.projectId) }, fromBlock, toBlock: nextEnd, strict: true })
      if (collected.length + result.length > MAX_SCORECARDS_PER_PAGE) {
        if (span === 1n) {
          if (collected.length) break
          throw new Error('A single block exceeds the 100-result read limit.')
        }
        span = span > 1n ? span / 2n : 1n
        continue
      }
      collected.push(...result)
      madeProgress = true
      nextEnd = fromBlock - 1n
      if (collected.length === MAX_SCORECARDS_PER_PAGE) break
    } catch (error) {
      if (!isLogRangeLimit(error) || span === 1n) throw error
      span = span > 1n ? span / 2n : 1n
    }
  }
  if (!madeProgress) throw new Error('Results history could not be read within 16 Center requests. Try again later.')
  const logs = parseEventLogs({ abi: DEFIFA_ABI.DefifaVotingReferee, logs: collected, eventName: 'ScorecardSubmitted', strict: true })
    .sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1)
  const read = readAt(client, market)
  const id = projectNumber(market.projectId)
  const timestampByBlock = new Map<string, Promise<number>>()
  const forwardedId = logs.length ? await read<bigint>(market.referee, 'DefifaVotingReferee', 'forwardedScorecardIdOf', [id]) : 0n
  const cards = await Promise.all(logs.map(async log => {
    const args = log.args as unknown as SubmittedArgs
    if (args.gameId !== id || log.blockNumber === null || log.removed) throw new Error('The result log does not match this snapshot.')
    const blockKey = log.blockNumber.toString()
    if (!timestampByBlock.has(blockKey)) timestampByBlock.set(blockKey, client.getBlock({ blockNumber: log.blockNumber }).then(block => Number(block.timestamp)))
    const submittedAt = await timestampByBlock.get(blockKey)!
    const attestationsBegin = Math.max(market.definition.resolvesAt, submittedAt + 1)
    const forwarded = forwardedId === args.scorecardId
    const [refereeState, count, quorum, hasAttested, weight, governorState, queuedAt] = await Promise.all([
      read<number>(market.referee, 'DefifaVotingReferee', 'stateOf', [id, args.scorecardId]),
      read<bigint>(market.referee, 'DefifaVotingReferee', 'attestationCountOf', [id, args.scorecardId]),
      read<bigint>(market.referee, 'DefifaVotingReferee', 'quorumOf', [id, args.scorecardId]),
      account ? read<boolean>(market.referee, 'DefifaVotingReferee', 'hasAttestedTo', [id, args.scorecardId, account]) : false,
      account ? read<bigint>(market.referee, 'DefifaVotingReferee', 'getBWAAttestationWeight', [id, args.scorecardId, account, submittedAt - 1]) : null,
      forwarded ? read<number>(market.governor, 'DefifaGovernor', 'stateOf', [id, args.scorecardId]) : null,
      forwarded ? read<bigint>(market.governor, 'DefifaGovernor', 'scorecardSubmittedAtOf', [id, args.scorecardId]) : null,
    ])
    // Once forwarded, the governor's queue, timelock and ratification are the result's state.
    const state = Number(governorState ?? refereeState)
    if (!STATE_NAMES[state]) throw new Error('The referee returned an unknown result state.')
    return {
      scorecardId: args.scorecardId.toString(), weights: args.tierWeights.map(item => ({ tierId: Number(item.id), weight: item.cashOutWeight.toString() })),
      submitter: args.caller, state, stateName: STATE_NAMES[state], submittedAt, attestationsBegin,
      gracePeriodEnds: attestationsBegin + grace, attestationCount: count.toString(), quorum: quorum.toString(), accountWeight: weight?.toString() ?? null,
      hasAttested, forwarded, ratifiableAt: queuedAt === null ? null : Number(queuedAt) + timelock,
      canAttest: !!account && market.phase === 3 && !forwarded && [1, 3].includes(Number(refereeState)) && !hasAttested && weight !== null && weight > 0n,
      canRevoke: !!account && !forwarded && Number(refereeState) === 1 && hasAttested,
      canForward: !!account && market.phase === 3 && forwardedId === 0n && Number(refereeState) === 3,
      canRatify: !!account && market.phase === 3 && forwarded && state === 3,
    }
  }))
  return { scorecards: cards.reverse(), next: nextEnd >= first ? nextEnd.toString() : null, complete: nextEnd < first }
}

function isLogRangeLimit(error: unknown): boolean {
  // Provider JSON-RPC wrappers retain the original details in the cause chain. Deliberately
  // exclude generic -32005/rate-limit errors: retrying a smaller range cannot fix those.
  let current: unknown = error
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    const value = current as { message?: unknown; details?: unknown; cause?: unknown }
    const text = `${typeof value.message === 'string' ? value.message : ''} ${typeof value.details === 'string' ? value.details : ''}`
    if (/block range (?:is )?too (?:large|wide)|(?:query|response) (?:returned|size exceeded|exceeds).*?(?:results|size|limit)|query returned more than|(?:limited to|maximum|exceeds?).*?\d[\d,]*\s*(?:blocks|block range)|(?:eth_getlogs|getlogs).*?block range.*?(?:limit|exceed)/i.test(text)) return true
    current = value.cause
  }
  return false
}

/** A page is bounded, explicit about completeness, and read at the same block as its market. */
export async function readLifecycle(
  chainId: number, projectId: string, account?: Address, options: LifecyclePageOptions = {},
): Promise<LifecycleSnapshot> {
  const client = publicClientForChain(chainId)
  await assertChain(client, chainId)
  const owner = account ? signer(account) : null
  const block = await client.getBlock(options.blockNumber === undefined ? undefined : { blockNumber: uint(options.blockNumber, 'snapshot block') })
  await verifyDefifaDeployment(client, chainId, block.number)
  const market = await readMarketAt(client, chainId, projectId, block.number, Number(block.timestamp))
  const d = deploymentForChain(chainId)
  const read = readAt(client, market)
  const id = projectNumber(projectId)
  const [grace, timelock, safety, positions, delegates] = await Promise.all([
    read<bigint>(market.referee, 'DefifaVotingReferee', 'attestationGracePeriodOf', [id]),
    read<bigint>(market.governor, 'DefifaGovernor', 'timelockDurationOf', [id]),
    read<readonly [bigint, number]>(d.deployer, 'DefifaDeployer', 'safetyParamsOf', [id]),
    readPositions(client, market, owner),
    owner ? Promise.all(market.ranges.map(async range => ({ tierId: range.tierId, delegate: await read<Address>(market.hook, 'DefifaHook', 'getTierDelegateOf', [owner, BigInt(range.tierId)]) }))) : [],
  ])
  const cards = await readScorecards(client, market, owner, Number(grace), Number(timelock), options.scorecardCursor)
  return {
    market, account: owner, positions, delegates, scorecards: cards.scorecards,
    scorecardsNextCursor: cards.next, scorecardsComplete: cards.complete,
    attestationGraceSeconds: Number(grace), timelockSeconds: Number(timelock),
    noContestAfter: market.definition.entryClosesAt + Number(safety[1]),
    ...phaseCapabilities(market, !!owner),
  }
}

function idsAndAmounts(positions: readonly OwnedPosition[]) {
  return [positions.map(position => BigInt(position.tierId)), positions.map(position => BigInt(position.count))] as const
}

function cashOutMetadata(chainId: number, positions: readonly OwnedPosition[]): Hex {
  return hookMetadata(deploymentForChain(chainId).implementation, 'cashOut',
    encodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], idsAndAmounts(positions)))
}

function cashOutArgs(market: MarketSnapshot, account: Address, positions: readonly OwnedPosition[], minimum: bigint) {
  return [account, projectNumber(market.projectId), 0n, NATIVE_TOKEN, minimum, account, cashOutMetadata(market.chainId, positions)] as const
}

async function quoteAt(client: PublicClient, market: MarketSnapshot, positions: readonly OwnedPosition[], account: Address): Promise<CashOutQuote> {
  if (!phaseCapabilities(market, true).cashOutMode) throw new Error('Positions cannot be cashed out during this game phase.')
  if (market.phase === 5 && !market.noContestTriggered) throw new Error('Open the native no-contest refunds before cashing out.')
  await assertOwned(client, market, positions, account)
  const d = deploymentForChain(market.chainId)
  const read = readAt(client, market)
  const [simulation, rewards, defifaToken, baseProtocolToken] = await Promise.all([
    client.simulateContract({ address: d.terminal, abi: DEFIFA_ABI.JBMultiTerminal, functionName: 'cashOutTokensOf', args: cashOutArgs(market, account, positions, 0n), account, blockNumber: BigInt(market.blockNumber) }),
    read<readonly [bigint, bigint]>(market.hook, 'DefifaHook', 'tokensClaimableFor', idsAndAmounts(positions)),
    read<Address>(market.hook, 'DefifaHook', 'DEFIFA_TOKEN'),
    read<Address>(market.hook, 'DefifaHook', 'BASE_PROTOCOL_TOKEN'),
  ])
  const decimals = await Promise.all([defifaToken, baseProtocolToken].map(address => client.readContract({ address, abi: ERC20_ABI, functionName: 'decimals', blockNumber: BigInt(market.blockNumber) })))
  if (decimals.some(value => value !== 18)) throw new Error('The protocol reward token decimals are not supported.')
  return {
    blockNumber: market.blockNumber, reclaimWei: (simulation.result as bigint).toString(),
    defifaTokenWei: rewards[0].toString(), baseProtocolTokenWei: rewards[1].toString(), defifaToken, baseProtocolToken,
  }
}

export async function readCashOutQuote(market: MarketSnapshot, positions: OwnedPosition[], account: Address): Promise<CashOutQuote> {
  const current = await freshMarket(market)
  return quoteAt(current.client, current.market, positionsFor(current.market, positions), signer(account))
}

function actionCall(market: MarketSnapshot, action: LifecycleAction, account: Address): Pick<PreparedTransaction, 'to' | 'data' | 'value' | 'title' | 'details'> {
  const d = deploymentForChain(market.chainId)
  const id = projectNumber(market.projectId)
  let to: Address = market.referee
  let abi = DEFIFA_ABI.DefifaVotingReferee
  let fn: string
  let args: readonly unknown[]
  let title: string
  const details = [{ label: 'Market', value: `${market.projectId} · ${market.definition.prompt}` }]
  switch (action.kind) {
    case 'transfer': {
      const [position] = positionsFor(market, [{ tierId: action.tierId, count: action.count }])
      const recipient = signer(action.to)
      if (sameAddress(recipient, account)) throw new Error('Choose a different recipient for these positions.')
      to = market.hook; abi = DEFIFA_ABI.DefifaHook; fn = 'safeTransferFrom'
      args = [account, recipient, BigInt(position.tierId), BigInt(position.count), '0x']; title = 'Send positions'
      details.push({ label: 'Range', value: market.ranges.find(range => range.tierId === position.tierId)!.label },
        { label: 'Positions', value: String(position.count) }, { label: 'Recipient', value: recipient })
      break
    }
    case 'delegate': {
      const delegate = signer(action.delegatee)
      if (!Array.isArray(action.tierIds) || !action.tierIds.length || action.tierIds.length > market.ranges.length
        || new Set(action.tierIds).size !== action.tierIds.length || action.tierIds.some(tierId => !market.ranges.some(range => range.tierId === tierId))) {
        throw new Error('Select unique ranges from this market to delegate.')
      }
      to = market.hook; abi = DEFIFA_ABI.DefifaHook; fn = 'setTierDelegatesTo'
      args = [action.tierIds.map(tierId => ({ delegatee: delegate, tierId: BigInt(tierId) }))]; title = 'Delegate attestation power'
      details.push({ label: 'Ranges', value: action.tierIds.join(', ') }, { label: 'Delegate', value: delegate })
      break
    }
    case 'submit-scorecard': case 'forward': case 'ratify': {
      const weights = nativeWeights(market, action.weights)
      if (action.kind === 'ratify') { to = market.governor; abi = DEFIFA_ABI.DefifaGovernor }
      fn = { 'submit-scorecard': 'submitScorecardFor', forward: 'forwardScorecardFor', ratify: 'ratifyScorecardFrom' }[action.kind]; args = [id, weights]
      title = { 'submit-scorecard': 'Propose result', forward: 'Queue result', ratify: 'Ratify result' }[action.kind]
      details.push(...weights.map(item => ({ label: `Range ${item.id}`, value: `${item.cashOutWeight} / ${SCORECARD_WEIGHT_TOTAL}` })))
      break
    }
    case 'attest': case 'revoke':
      fn = action.kind === 'attest' ? 'attestToScorecardFrom' : 'revokeAttestationFrom'; args = [id, uint(action.scorecardId, 'result ID', false)]
      title = action.kind === 'attest' ? 'Attest result' : 'Revoke attestation'
      details.push({ label: 'Result', value: action.scorecardId }); break
    case 'fulfill': case 'no-contest':
      to = d.deployer; abi = DEFIFA_ABI.DefifaDeployer
      fn = action.kind === 'fulfill' ? 'fulfillCommitmentsOf' : 'triggerNoContestFor'; args = [id]
      title = action.kind === 'fulfill' ? 'Fulfill game commitments' : 'Open no-contest refunds'; break
    case 'cash-out': {
      const positions = positionsFor(market, action.positions)
      const minimum = uint(action.minReclaimedWei, 'minimum reclaim amount')
      to = d.terminal; abi = DEFIFA_ABI.JBMultiTerminal; fn = 'cashOutTokensOf'; args = cashOutArgs(market, account, positions, minimum)
      title = market.phase === 4 ? 'Cash out positions and claim protocol tokens' : 'Refund positions'
      details.push(...positions.map(position => ({ label: `Burn in ${market.ranges.find(range => range.tierId === position.tierId)!.label}`, value: String(position.count) })),
        { label: 'Minimum ETH (wei)', value: minimum.toString() }); break
    }
  }
  return { to, data: encodeFunctionData({ abi, functionName: fn, args }), value: 0n, title, details }
}

async function assertAction(client: PublicClient, market: MarketSnapshot, action: LifecycleAction, account: Address) {
  // Build first so invalid inputs never cause arbitrary reads.
  actionCall(market, action, account)
  const read = readAt(client, market)
  const id = projectNumber(market.projectId)
  switch (action.kind) {
    case 'transfer': await assertOwned(client, market, [{ tierId: action.tierId, count: action.count }], account); break
    case 'delegate': if (market.phase !== 1) throw new Error('Attestation delegation can only change while entry is open.'); break
    case 'submit-scorecard':
      if (market.phase !== 3) throw new Error('Results can only be proposed during the native scoring phase.')
      if (nativeWeights(market, action.weights).some(weight => weight.cashOutWeight > 0n && BigInt(market.tiers.find(tier => BigInt(tier.tierId) === weight.id)!.supply) === 0n)) {
        throw new Error('A range with no circulating Positions cannot receive a result payout weight.')
      }
      break
    case 'attest': case 'revoke': {
      const cardId = uint(action.scorecardId, 'result ID', false)
      const [state, attested] = await Promise.all([
        read<number>(market.referee, 'DefifaVotingReferee', 'stateOf', [id, cardId]),
        read<boolean>(market.referee, 'DefifaVotingReferee', 'hasAttestedTo', [id, cardId, account]),
      ])
      if (action.kind === 'attest' && (market.phase !== 3 || ![1, 3].includes(Number(state)) || attested)) throw new Error('This wallet cannot attest to that result now.')
      if (action.kind === 'revoke' && (Number(state) !== 1 || !attested)) throw new Error('An attestation can only be revoked while its result is active.')
      break
    }
    case 'forward': {
      const cardId = await read<bigint>(market.referee, 'DefifaVotingReferee', 'scorecardIdOf', [market.hook, nativeWeights(market, action.weights)])
      const [state, forwarded] = await Promise.all([
        read<number>(market.referee, 'DefifaVotingReferee', 'stateOf', [id, cardId]),
        read<bigint>(market.referee, 'DefifaVotingReferee', 'forwardedScorecardIdOf', [id]),
      ])
      if (market.phase !== 3 || Number(state) !== 3 || forwarded !== 0n) throw new Error('The result has not reached quorum after its grace period, or another result is queued.')
      break
    }
    case 'ratify': {
      const cardId = await read<bigint>(market.governor, 'DefifaGovernor', 'scorecardIdOf', [market.hook, nativeWeights(market, action.weights)])
      const state = await read<number>(market.governor, 'DefifaGovernor', 'stateOf', [id, cardId]).catch(() => null)
      if (market.phase !== 3 || state !== 3) throw new Error('The result has not been queued through its timelock.')
      break
    }
    case 'fulfill': if (market.phase !== 4 || market.commitmentsFulfilled) throw new Error('There are no pending ratified game commitments.'); break
    case 'no-contest': if (market.phase !== 5 || market.noContestTriggered) throw new Error('Native no-contest refunds are not awaiting activation.'); break
    case 'cash-out': {
      const quote = await quoteAt(client, market, positionsFor(market, action.positions), account)
      if (BigInt(quote.reclaimWei) < uint(action.minReclaimedWei, 'minimum reclaim amount')) throw new Error('The cash-out amount fell below the reviewed minimum. Refresh its quote.')
      break
    }
  }
}

export async function prepareLifecycleAction(market: MarketSnapshot, action: LifecycleAction, account: Address): Promise<PreparedTransaction> {
  action = structuredClone(action)
  const owner = signer(account)
  const current = await freshMarket(market)
  await assertAction(current.client, current.market, action, owner)
  const request = { chainId: current.market.chainId, account: owner, ...actionCall(current.market, action, owner) }
  return {
    ...request,
    reverify: async () => {
      const latest = await freshMarket(current.market)
      if (action.kind === 'cash-out' && latest.market.phase !== current.market.phase) throw new Error('The game phase changed. Review this cash-out again.')
      await assertAction(latest.client, latest.market, action, owner)
    },
    verifyReceipt: receipt => verifyLifecycleReceipt(request, receipt),
  }
}

function receiptEvents<T>(receipt: TransactionReceipt, contract: keyof typeof DEFIFA_ABI, address: Address, name: string): T[] {
  return parseEventLogs({ abi: DEFIFA_ABI[contract], logs: receipt.logs, eventName: name, strict: true })
    .filter(log => sameAddress(log.address, address)).map(log => log.args as T)
}

function exactWeights(a: NativeWeight[], b: NativeWeight[]): boolean {
  return a.length === b.length && a.every((item, index) => item.id === b[index].id && item.cashOutWeight === b[index].cashOutWeight)
}

/** Reconstruct only supported direct native calls. This is also the reload-recovery authority. */
export async function verifyLifecycleReceipt(request: LifecycleRequest, receipt: TransactionReceipt): Promise<void> {
  if (receipt.status !== 'success' || request.value !== 0n) throw new Error('The receipt does not confirm a native lifecycle action.')
  const account = signer(request.account)
  const client = publicClientForChain(request.chainId)
  const d = await verifyDefifaDeployment(client, request.chainId, receipt.blockNumber)
  const decoded = decodeDefifaTransactionCall(request, d)
  const { contract } = decoded
  const args = decoded.args as readonly unknown[]
  let id: bigint
  if (contract === 'DefifaHook') id = await contractRead<bigint>(client, request.to, contract, 'projectId', [], receipt.blockNumber)
  else id = BigInt(args[contract === 'JBMultiTerminal' ? 1 : 0] as bigint)
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  const market = await readMarketAt(client, request.chainId, id.toString(), block.number, Number(block.timestamp))
  const read = readAt(client, market)
  let action: LifecycleAction
  switch (decoded.functionName) {
    case 'safeTransferFrom':
      if (args.length !== 5 || !sameAddress(args[0], account) || (args[3] as bigint) > BigInt(MAX_POSITIONS)) throw new Error('The recorded position transfer is not supported.')
      action = { kind: 'transfer', to: args[1] as Address, tierId: Number(args[2]), count: Number(args[3]) }; break
    case 'setTierDelegatesTo': {
      const delegations = args[0] as { delegatee: Address; tierId: bigint }[]
      if (!delegations.length || delegations.some(item => !sameAddress(item.delegatee, delegations[0].delegatee))) throw new Error('The recorded delegation is not supported.')
      action = { kind: 'delegate', tierIds: delegations.map(item => Number(item.tierId)), delegatee: delegations[0].delegatee }; break
    }
    case 'submitScorecardFor': case 'forwardScorecardFor': case 'ratifyScorecardFrom':
      action = { kind: ({ submitScorecardFor: 'submit-scorecard', forwardScorecardFor: 'forward', ratifyScorecardFrom: 'ratify' } as const)[decoded.functionName],
        weights: (args[1] as NativeWeight[]).map(item => ({ tierId: Number(item.id), weight: item.cashOutWeight.toString() })) }; break
    case 'attestToScorecardFrom': case 'revokeAttestationFrom':
      action = { kind: decoded.functionName === 'attestToScorecardFrom' ? 'attest' : 'revoke', scorecardId: String(args[1]) }; break
    case 'fulfillCommitmentsOf': action = { kind: 'fulfill' }; break
    case 'triggerNoContestFor': action = { kind: 'no-contest' }; break
    case 'cashOutTokensOf': {
      if (!sameAddress(args[0], account) || args[2] !== 0n || !sameAddress(args[3], NATIVE_TOKEN) || !sameAddress(args[5], account)) {
        throw new Error('The recorded cash-out holder, token or beneficiary is not supported.')
      }
      const metadata = args[6] as Hex
      if (metadata.length > 14_000) throw new Error('The recorded cash-out metadata exceeds the selection limit.')
      const [ids, amounts] = decodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], `0x${metadata.slice(130)}`)
      if (ids.length !== amounts.length || amounts.some(amount => amount > BigInt(MAX_POSITIONS))) throw new Error('The recorded cash-out selection is not supported.')
      action = { kind: 'cash-out', positions: ids.map((tierId, index) => ({ tierId: Number(tierId), count: Number(amounts[index]) })), minReclaimedWei: String(args[4]) }; break
    }
    default: throw new Error('This is not a supported Defifa lifecycle action.')
  }
  const expected = actionCall(market, action, account)
  if (!sameAddress(expected.to, request.to) || expected.data !== request.data) throw new Error('The recorded lifecycle calldata does not match the supported action.')
  switch (action.kind) {
    case 'transfer': {
      if (!receiptMoves(market.hook, receipt).some(move => move.id === BigInt(action.tierId) && move.value === BigInt(action.count)
        && sameAddress(move.from, account) && sameAddress(move.to, action.to))) {
        throw new Error('The receipt does not confirm the reviewed position transfer.')
      }
      break
    }
    case 'delegate': {
      const events = receiptEvents<{ delegator: Address; toDelegate: Address; caller: Address }>(receipt, 'DefifaHook', market.hook, 'DelegateChanged')
      if (events.some(item => !sameAddress(item.delegator, account) || !sameAddress(item.toDelegate, action.delegatee) || !sameAddress(item.caller, account))) {
        throw new Error('The confirmed tier delegate changes differ from the reviewed request.')
      }
      // Re-selecting an existing delegate is an idempotent successful call with no event.
      // End-of-block state can include a later delegation; it cannot invalidate this receipt.
      break
    }
    case 'submit-scorecard': {
      const weights = nativeWeights(market, action.weights)
      const cardId = await read<bigint>(market.referee, 'DefifaVotingReferee', 'scorecardIdOf', [market.hook, weights])
      const events = receiptEvents<SubmittedArgs>(receipt, 'DefifaVotingReferee', d.referee, 'ScorecardSubmitted')
      if (!events.some(item => item.gameId === id && item.scorecardId === cardId && sameAddress(item.caller, account) && exactWeights(item.tierWeights, weights))) {
        throw new Error('The receipt does not confirm the complete reviewed result.')
      }
      await read<number>(market.referee, 'DefifaVotingReferee', 'stateOf', [id, cardId]); break
    }
    case 'forward': {
      const weights = nativeWeights(market, action.weights)
      const cardId = await read<bigint>(market.referee, 'DefifaVotingReferee', 'scorecardIdOf', [market.hook, weights])
      const forwarded = receiptEvents<{ gameId: bigint; scorecardId: bigint; caller: Address }>(receipt, 'DefifaVotingReferee', d.referee, 'ScorecardForwarded')
      const queued = receiptEvents<SubmittedArgs>(receipt, 'DefifaGovernor', d.governor, 'ScorecardSubmitted')
      if (!forwarded.some(item => item.gameId === id && item.scorecardId === cardId && sameAddress(item.caller, account))
        || !queued.some(item => item.gameId === id && item.scorecardId === cardId && exactWeights(item.tierWeights, weights))) {
        throw new Error('The receipt does not confirm the result was queued with the governor.')
      }
      break
    }
    case 'attest': case 'revoke': {
      type Attestation = { gameId: bigint; scorecardId: bigint; caller: Address; account?: Address; weight: bigint }
      const events = receiptEvents<Attestation>(receipt, 'DefifaVotingReferee', d.referee, action.kind === 'attest' ? 'ScorecardAttested' : 'AttestationRevoked')
      if (!events.some(item => item.gameId === id && item.scorecardId === BigInt(action.scorecardId) && sameAddress(item.caller, account) && item.weight > 0n
        && (action.kind === 'attest' || sameAddress(item.account, account)))) throw new Error('The receipt does not confirm the reviewed attestation change.')
      // Another same-block transaction can revoke/restore this attestation. Its authenticated
      // receipt event, not the later end-of-block getter, proves this request's effect.
      break
    }
    case 'ratify': {
      const weights = nativeWeights(market, action.weights)
      const cardId = await read<bigint>(market.governor, 'DefifaGovernor', 'scorecardIdOf', [market.hook, weights])
      const events = receiptEvents<{ gameId: bigint; scorecardId: bigint; caller: Address }>(receipt, 'DefifaGovernor', d.governor, 'ScorecardRatified')
      const setWeights = receiptEvents<{ tierWeights: NativeWeight[]; caller: Address }>(receipt, 'DefifaHook', market.hook, 'TierCashOutWeightsSet')
      const matched = market.ratifiedWeights?.every(item => BigInt(item.weight) === (weights.find(weight => weight.id === BigInt(item.tierId))?.cashOutWeight ?? 0n))
      if (!events.some(item => item.gameId === id && item.scorecardId === cardId && sameAddress(item.caller, account))
        || !setWeights.some(item => sameAddress(item.caller, d.governor) && exactWeights(item.tierWeights, weights))
        || market.ratifiedScorecardId !== cardId.toString() || !matched || !market.commitmentsFulfilled || market.phase !== 4) {
        throw new Error('The receipt does not confirm the ratified result and native fulfillment.')
      }
      break
    }
    case 'fulfill':
      if (!market.commitmentsFulfilled || market.phase !== 4) throw new Error('The game commitments are not confirmed fulfilled.'); break
    case 'no-contest': {
      const events = receiptEvents<{ gameId: bigint; caller: Address }>(receipt, 'DefifaDeployer', d.deployer, 'QueuedNoContest')
      if (!events.some(item => item.gameId === id && sameAddress(item.caller, account)) || !market.noContestTriggered || market.phase !== 5) {
        throw new Error('The receipt does not confirm native no-contest activation.')
      }
      break
    }
    case 'cash-out': {
      const positions = positionsFor(market, action.positions)
      const burns = quantitiesOf(market, receiptMoves(market.hook, receipt).filter(move => sameAddress(move.from, account) && sameAddress(move.to, zeroAddress)))
      const expected = market.ranges.map(range => positions.find(position => position.tierId === range.tierId)?.count ?? 0)
      type CashOutEvent = { projectId: bigint; holder: Address; beneficiary: Address; reclaimAmount: bigint; cashOutCount: bigint; metadata: Hex; caller: Address }
      const events = receiptEvents<CashOutEvent>(receipt, 'JBMultiTerminal', d.terminal, 'CashOutTokens')
      if (JSON.stringify(burns) !== JSON.stringify(expected) || !events.some(item => item.projectId === id
        && sameAddress(item.holder, account) && sameAddress(item.beneficiary, account) && sameAddress(item.caller, account) && item.cashOutCount === 0n
        && item.reclaimAmount >= BigInt(action.minReclaimedWei) && item.metadata === cashOutMetadata(market.chainId, positions))) {
        throw new Error('The receipt does not confirm every position burn and the reviewed reclaim amount.')
      }
      if (market.phase === 4) {
        const claims = receiptEvents<{ beneficiary: Address; defifaTokenAmount: bigint; baseProtocolTokenAmount: bigint; caller: Address }>(receipt, 'DefifaHook', market.hook, 'ClaimedTokens')
        const claim = claims.find(item => sameAddress(item.beneficiary, account) && sameAddress(item.caller, d.terminal))
        if (!claim) throw new Error('The receipt does not confirm the protocol token claim.')
        const tokens = await Promise.all([
          read<Address>(market.hook, 'DefifaHook', 'DEFIFA_TOKEN'), read<Address>(market.hook, 'DefifaHook', 'BASE_PROTOCOL_TOKEN'),
        ])
        const amounts = [claim.defifaTokenAmount, claim.baseProtocolTokenAmount]
        for (let i = 0; i < tokens.length; i++) {
          if (amounts[i] === 0n) continue
          const transfers = parseEventLogs({ abi: ERC20_ABI, logs: receipt.logs, eventName: 'Transfer', strict: true })
          if (!transfers.some(log => sameAddress(log.address, tokens[i]) && sameAddress(log.args.from, market.hook)
            && sameAddress(log.args.to, account) && log.args.value === amounts[i])) throw new Error('The receipt does not confirm the claimed protocol token transfer.')
        }
      }
      break
    }
  }
}

/** Bounds one voters read: delegate and weight reads for at most this many (holder, range) pairs. */
const MAX_VOTER_HOLDINGS = 2_000
const HOLDINGS_QUERY = `query Holdings($chainId: Int!, $projectId: Int!, $after: String) {
  defifaHoldings(where: { chainId: $chainId, projectId: $projectId, count_gt: 0 }, limit: 1000, after: $after) {
    items { hook owner tierId count } pageInfo { hasNextPage endCursor } } }`

export type ResultVoters = {
  /** Delegates holding attestation weight on this result, largest first. */
  voters: { account: Address; weight: string; attested: boolean }[]
  /** Positions whose holders never delegated, so their weight counts for no one. */
  undelegated: number
}

type Holding = { hook: string; owner: string; tierId: number; count: number }

/**
 * Who can attest a result and how much each can add. Bendystraw lists the holders (ERC-1155 has no
 * on-chain enumeration); each holder's range delegate and each delegate's weight at the result's
 * snapshot (submission - 1) are read on chain.
 */
export async function readResultVoters(client: PublicClient, market: MarketSnapshot, scorecardId: bigint, submittedAt: number): Promise<ResultVoters> {
  const read = readAt(client, market)
  const id = projectNumber(market.projectId)
  const holdings: Holding[] = []
  for (let after: string | null = null, page = 0; page === 0 || after; page++) {
    if (page * 1000 >= MAX_VOTER_HOLDINGS) throw new Error(`Voters are listed for games up to ${MAX_VOTER_HOLDINGS} holdings.`)
    const data: { defifaHoldings: { items: Holding[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await bendystraw(
      market.chainId, HOLDINGS_QUERY, { chainId: market.chainId, projectId: Number(id), after })
    holdings.push(...data.defifaHoldings.items.filter(item => sameAddress(item.hook, market.hook)))
    after = data.defifaHoldings.pageInfo.hasNextPage ? data.defifaHoldings.pageInfo.endCursor : null
  }
  const delegated = await Promise.all(holdings.map(async holding => ({ ...holding,
    delegate: await read<Address>(market.hook, 'DefifaHook', 'getTierDelegateOf', [getAddress(holding.owner), BigInt(holding.tierId)]) })))
  const delegates = [...new Set(delegated.filter(pair => !sameAddress(pair.delegate, zeroAddress)).map(pair => pair.delegate.toLowerCase()))] as Address[]
  const voters = await Promise.all(delegates.map(async account => {
    const [weight, attested] = await Promise.all([
      read<bigint>(market.referee, 'DefifaVotingReferee', 'getBWAAttestationWeight', [id, scorecardId, account, submittedAt - 1]),
      read<boolean>(market.referee, 'DefifaVotingReferee', 'hasAttestedTo', [id, scorecardId, account]),
    ])
    return { account, weight, attested }
  }))
  return {
    voters: voters.filter(voter => voter.weight > 0n).sort((a, b) => a.weight === b.weight ? 0 : a.weight > b.weight ? -1 : 1)
      .map(voter => ({ account: voter.account, weight: voter.weight.toString(), attested: voter.attested })),
    undelegated: delegated.filter(pair => sameAddress(pair.delegate, zeroAddress)).reduce((sum, pair) => sum + pair.count, 0),
  }
}
