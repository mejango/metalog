import { decodeAbiParameters, decodeFunctionData, parseEventLogs, zeroAddress, type Address, type Hex, type TransactionReceipt } from 'viem'
import {
  createdMarketId, decodeEntryMemo, NATIVE_TOKEN, quantitiesOf, readMarket, readMarketAt, receiptMoves, signer, verifyRecordedEntry,
} from '../../src/lib/defifa'
import {
  actionCall, cashOutMetadata, ERC20_ABI, nativeWeights, positionsFor, readAt,
  type LifecycleAction, type NativeWeight, type SubmittedArgs,
} from '../../src/lib/defifa-lifecycle'
import { contractRead, DEFIFA_ABI, deploymentForChain, sameAddress, verifyDefifaDeployment, type Deployment } from '../../src/lib/defifa-deployment'
import { loadMarketMetadata } from '../../src/lib/market-metadata'
import { encodeMarketDefinition } from '../../src/domain/market'
import { MAX_POSITIONS } from '../../src/domain/allocation'
import { publicClientForChain } from '../../src/lib/wallet'
import type { PreparedTransaction } from '../../src/lib/transaction'

/**
 * Test-only evidence that a confirmed receipt shows the Defifa effects its reviewed call asked for. The app treats the
 * hold's settlement of the exact call as the outcome, as jbm and revnet do; these checks prove the calldata is right.
 */
export type LifecycleRequest = Pick<PreparedTransaction, 'chainId' | 'account' | 'to' | 'data' | 'value'>

/** Which Defifa contract a native call targets, and its decoded function. */
export function decodeDefifaTransactionCall(request: { to: Address; data: Hex }, deployment: Deployment) {
  let contract: keyof typeof DEFIFA_ABI
  if (sameAddress(request.to, deployment.governor)) contract = 'DefifaGovernor'
  else if (sameAddress(request.to, deployment.referee)) contract = 'DefifaVotingReferee'
  else if (sameAddress(request.to, deployment.deployer)) contract = 'DefifaDeployer'
  else if (sameAddress(request.to, deployment.terminal)) contract = 'JBMultiTerminal'
  else contract = 'DefifaHook'
  return { contract, ...decodeFunctionData({ abi: DEFIFA_ABI[contract], data: request.data }) }
}

/** The receipt's effects for any prepared Defifa write: a creation, an entry or a lifecycle action. */
export async function checkReceiptEffects(prepared: LifecycleRequest, receipt: TransactionReceipt): Promise<void> {
  const d = deploymentForChain(prepared.chainId)
  const { contract, functionName, args } = decodeDefifaTransactionCall(prepared, d)
  if (contract === 'DefifaDeployer' && functionName === 'launchGameWith') {
    return checkLaunch(prepared, (args![0] as { projectUri: string }).projectUri, receipt)
  }
  if (contract === 'JBMultiTerminal' && functionName === 'pay') {
    const [projectId, , amount, beneficiary, , memo, metadata] = args as readonly [bigint, Address, bigint, Address, bigint, string, Hex]
    const market = await readMarket(prepared.chainId, projectId.toString())
    verifyRecordedEntry(market, d.implementation, beneficiary, amount, decodeEntryMemo(memo, metadata), metadata, receipt)
    return
  }
  return verifyLifecycleReceipt(prepared, receipt)
}

async function checkLaunch(prepared: LifecycleRequest, projectUri: string, receipt: TransactionReceipt): Promise<void> {
  const client = publicClientForChain(prepared.chainId)
  const d = deploymentForChain(prepared.chainId)
  const projectId = createdMarketId(receipt)
  const launch = parseEventLogs({ abi: DEFIFA_ABI.DefifaDeployer, logs: receipt.logs, eventName: 'LaunchGame', strict: true })
    .find(log => sameAddress(log.address, d.deployer))
  if (!launch || !sameAddress((launch.args as { caller: Address }).caller, signer(prepared.account))) {
    throw new Error('The confirmed market does not match its creator.')
  }
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  const uri = await contractRead<string>(client, d.controller, 'JBController', 'uriOf', [BigInt(projectId)], block.number)
  if (uri !== projectUri) throw new Error('The confirmed metadata URI does not match the reviewed transaction.')
  const market = await readMarketAt(client, prepared.chainId, projectId, block.number, Number(block.timestamp))
  if (encodeMarketDefinition(market.definition) !== encodeMarketDefinition((await loadMarketMetadata(projectUri)).definition)) {
    throw new Error('The confirmed market definition does not match the reviewed transaction.')
  }
}

function receiptEvents<T>(receipt: TransactionReceipt, contract: keyof typeof DEFIFA_ABI, address: Address, name: string): T[] {
  return parseEventLogs({ abi: DEFIFA_ABI[contract], logs: receipt.logs, eventName: name, strict: true })
    .filter(log => sameAddress(log.address, address)).map(log => log.args as T)
}

function exactWeights(a: NativeWeight[], b: NativeWeight[]): boolean {
  return a.length === b.length && a.every((item, index) => item.id === b[index].id && item.cashOutWeight === b[index].cashOutWeight)
}

/** Reconstruct only supported direct native calls, then check the receipt shows the action's effects. */
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
