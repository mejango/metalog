import { decodeFunctionData, encodeFunctionData, isAddress, type Address, type Hex } from 'viem'
import { DEFIFA_ABI, deploymentForChain, sameAddress, type Deployment } from './defifa-deployment'

export type MarketTransactionScope = { chainId: number; projectId: string; hook: Address }
type TransactionCall = { chainId: number; to: Address; data: Hex; value: bigint | string }
export type TransactionScope = { kind: 'creation' }
  | { kind: 'market'; chainId: number; projectId: string; hook?: Address }
  | { kind: 'unknown' }

export function isMarketTransactionScope(value: unknown): value is MarketTransactionScope {
  if (!value || typeof value !== 'object') return false
  const scope = value as MarketTransactionScope
  return Number.isSafeInteger(scope.chainId) && scope.chainId > 0
    && typeof scope.projectId === 'string' && /^[1-9][0-9]{0,77}$/.test(scope.projectId)
    && BigInt(scope.projectId) < 2n ** 256n && isAddress(scope.hook) && BigInt(scope.hook) !== 0n
}

/** Shared native-call decoding; callers still verify the supported action and effects. */
export function decodeDefifaTransactionCall(request: { to: Address; data: Hex }, deployment: Deployment) {
  let contract: keyof typeof DEFIFA_ABI
  if (sameAddress(request.to, deployment.governor)) contract = 'DefifaGovernor'
  else if (sameAddress(request.to, deployment.referee)) contract = 'DefifaVotingReferee'
  else if (sameAddress(request.to, deployment.deployer)) contract = 'DefifaDeployer'
  else if (sameAddress(request.to, deployment.terminal)) contract = 'JBMultiTerminal'
  else contract = 'DefifaHook'
  return { contract, ...decodeFunctionData({ abi: DEFIFA_ABI[contract], data: request.data }) }
}

/** Classifies direct native identity only; no title, memo, storage claim or RPC is authority. */
export function classifyTransactionScope(request: TransactionCall, trustedMarket?: MarketTransactionScope): TransactionScope {
  try {
    if (!Number.isSafeInteger(request.chainId) || request.chainId <= 0) return { kind: 'unknown' }
    const deployment = deploymentForChain(request.chainId)
    const decoded = decodeDefifaTransactionCall(request, deployment)
    const args = decoded.args as readonly unknown[]
    // Trailing bytes or noncanonical encoding must not manufacture a supported identity.
    if (encodeFunctionData({ abi: DEFIFA_ABI[decoded.contract], functionName: decoded.functionName, args })
      .toLowerCase() !== request.data.toLowerCase()) return { kind: 'unknown' }
    const value = BigInt(request.value)
    if (value < 0n || value >= 2n ** 256n) return { kind: 'unknown' }
    if (decoded.contract === 'DefifaDeployer' && decoded.functionName === 'launchGameWith') return { kind: 'creation' }
    let id: unknown
    if (decoded.contract === 'JBMultiTerminal') {
      if (decoded.functionName === 'pay') id = args[0]
      else if (decoded.functionName === 'cashOutTokensOf' && value === 0n) id = args[1]
      else return { kind: 'unknown' }
    } else if (decoded.contract === 'DefifaGovernor' || decoded.contract === 'DefifaVotingReferee') {
      const supported = decoded.contract === 'DefifaGovernor' ? ['ratifyScorecardFrom']
        : ['submitScorecardFor', 'attestToScorecardFrom', 'revokeAttestationFrom', 'forwardScorecardFor']
      if (value !== 0n || !supported.includes(decoded.functionName)) return { kind: 'unknown' }
      id = args[0]
    } else if (decoded.contract === 'DefifaDeployer') {
      if (value !== 0n || !['fulfillCommitmentsOf', 'triggerNoContestFor'].includes(decoded.functionName)) return { kind: 'unknown' }
      id = args[0]
    } else {
      if (value !== 0n || !isMarketTransactionScope(trustedMarket) || trustedMarket.chainId !== request.chainId
        || !sameAddress(request.to, trustedMarket.hook)
        || !(decoded.functionName === 'safeTransferFrom' && args.length === 5 || decoded.functionName === 'setTierDelegatesTo')) return { kind: 'unknown' }
      return { kind: 'market', chainId: trustedMarket.chainId, projectId: trustedMarket.projectId, hook: trustedMarket.hook }
    }
    if (typeof id !== 'bigint' || id <= 0n) return { kind: 'unknown' }
    return { kind: 'market', chainId: request.chainId, projectId: id.toString() }
  } catch { return { kind: 'unknown' } }
}

/** Bind a stored/caller-provided scope to the original immutable native call. */
export function transactionMatchesMarketScope(request: TransactionCall, scope: MarketTransactionScope): boolean {
  if (!isMarketTransactionScope(scope)) return false
  const classified = classifyTransactionScope(request, scope)
  return classified.kind === 'market' && classified.chainId === scope.chainId && classified.projectId === scope.projectId
    && (!classified.hook || sameAddress(classified.hook, scope.hook))
}
