import { describe, expect, it } from 'vitest'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import { DEFIFA_ABI, deploymentForChain } from '../src/lib/defifa-deployment'
import { classifyTransactionScope, decodeDefifaTransactionCall, isMarketTransactionScope, transactionMatchesMarketScope } from '../src/lib/transaction-scope'
import { nativeCreationRequest } from './fixtures/transaction-requests'

const chainId = 8453
const deployment = deploymentForChain(chainId)
const hook = '0x0000000000000000000000000000000000000011' as Address
const account = '0x0000000000000000000000000000000000000022' as Address
const scope = { chainId, projectId: '27', hook }
const native = '0x000000000000000000000000000000000000EEEe' as Address
function call(contract: keyof typeof DEFIFA_ABI, functionName: string, args: readonly unknown[], value = 0n) {
  const to = contract === 'DefifaGovernor' ? deployment.governor : contract === 'DefifaVotingReferee' ? deployment.referee : contract === 'DefifaDeployer' ? deployment.deployer
    : contract === 'JBMultiTerminal' ? deployment.terminal : hook
  return { chainId, to, data: encodeFunctionData({ abi: DEFIFA_ABI[contract], functionName, args }), value }
}

describe('native transaction intent scope', () => {
  it('recognizes direct native creation independently of existing markets, without trusting labels', () => {
    expect(classifyTransactionScope(nativeCreationRequest)).toEqual({ kind: 'creation' })
    expect(transactionMatchesMarketScope(nativeCreationRequest, scope)).toBe(false)
    expect(classifyTransactionScope({ ...nativeCreationRequest, to: hook }, scope)).toEqual({ kind: 'unknown' })
    expect(classifyTransactionScope({ ...nativeCreationRequest, data: '0x', title: 'Create market' } as typeof nativeCreationRequest)).toEqual({ kind: 'unknown' })
  })
  it.each([
    ['JBMultiTerminal', 'pay', [27n, native, 7n, account, 0n, '', '0x'], 7n],
    ['JBMultiTerminal', 'cashOutTokensOf', [account, 27n, 0n, native, 0n, account, '0x'], 0n],
    ['DefifaVotingReferee', 'submitScorecardFor', [27n, [{ id: 1n, cashOutWeight: 1n }]], 0n],
    ['DefifaVotingReferee', 'forwardScorecardFor', [27n, [{ id: 1n, cashOutWeight: 1n }]], 0n],
    ['DefifaVotingReferee', 'attestToScorecardFrom', [27n, 1n], 0n],
    ['DefifaVotingReferee', 'revokeAttestationFrom', [27n, 1n], 0n],
    ['DefifaGovernor', 'ratifyScorecardFrom', [27n, [{ id: 1n, cashOutWeight: 1n }]], 0n],
    ['DefifaDeployer', 'fulfillCommitmentsOf', [27n], 0n],
    ['DefifaDeployer', 'triggerNoContestFor', [27n], 0n],
  ] as const)('uses registered %s %s calldata identity, not presentation', (contract, name, args, value) => {
    const request = call(contract, name, args, value)
    expect(classifyTransactionScope({ ...request, title: 'Create market' } as typeof request)).toEqual({ kind: 'market', chainId, projectId: '27' })
    expect(transactionMatchesMarketScope(request, scope)).toBe(true)
    expect(transactionMatchesMarketScope(request, { ...scope, projectId: '28' })).toBe(false)
    expect(transactionMatchesMarketScope(request, { ...scope, chainId: 84532 })).toBe(false)
  })

  it.each([
    ['safeTransferFrom', [account, hook, 1n, 2n, '0x']],
    ['setTierDelegatesTo', [[{ delegatee: account, tierId: 1n }]]],
  ] as const)('requires the exact independently verified hook for %s', (name, args) => {
    const request = call('DefifaHook', name, args)
    expect(classifyTransactionScope(request)).toEqual({ kind: 'unknown' })
    expect(classifyTransactionScope(request, scope)).toEqual({ kind: 'market', ...scope })
    expect(transactionMatchesMarketScope(request, scope)).toBe(true)
    expect(transactionMatchesMarketScope(request, { ...scope, hook: account })).toBe(false)
    expect(transactionMatchesMarketScope(request, { ...scope, chainId: 84532 })).toBe(false)
  })

  it('rejects malformed/unknown selectors, wrong native targets, extra bytes and unsupported variants', () => {
    const request = call('JBMultiTerminal', 'pay', [27n, native, 7n, account, 0n, '', '0x'], 7n)
    for (const changed of [
      { data: '0x' as Hex }, { data: '0xffffffff' as Hex }, { data: `${request.data}00` as Hex },
      { to: account }, { chainId: 99999 }, { value: -1n },
    ]) expect(classifyTransactionScope({ ...request, ...changed }, scope)).toEqual({ kind: 'unknown' })
    expect(classifyTransactionScope(call('DefifaGovernor', 'stateOf', [27n, 1n]))).toEqual({ kind: 'unknown' })
    expect(classifyTransactionScope(call('DefifaHook', 'balanceOf', [account, 1n]), scope)).toEqual({ kind: 'unknown' })
    expect(classifyTransactionScope(call('DefifaVotingReferee', 'stateOf', [27n, 1n]))).toEqual({ kind: 'unknown' })
    expect(classifyTransactionScope(call('DefifaDeployer', 'fulfillCommitmentsOf', [27n], 1n))).toEqual({ kind: 'unknown' })
    expect(classifyTransactionScope(call('JBMultiTerminal', 'pay', [0n, native, 7n, account, 0n, '', '0x'], 7n))).toEqual({ kind: 'unknown' })
  })

  it('validates persisted scope shape and binds it to the original call', () => {
    const request = call('DefifaVotingReferee', 'attestToScorecardFrom', [27n, 1n])
    expect(isMarketTransactionScope(scope)).toBe(true)
    for (const value of [null, { ...scope, projectId: '027' }, { ...scope, projectId: '0' },
      { ...scope, projectId: (2n ** 256n).toString() }, { ...scope, hook: '0x0' }, { ...scope, chainId: 1.5 }]) {
      expect(isMarketTransactionScope(value)).toBe(false)
      expect(transactionMatchesMarketScope(request, value as typeof scope)).toBe(false)
    }
    expect(transactionMatchesMarketScope(request, scope)).toBe(true)
  })

  it('keeps shared recovery decoding behavior for native and hook calls', () => {
    const request = call('DefifaVotingReferee', 'attestToScorecardFrom', [27n, 1n])
    expect(decodeDefifaTransactionCall(request, deployment)).toMatchObject({ contract: 'DefifaVotingReferee', functionName: 'attestToScorecardFrom', args: [27n, 1n] })
    const transfer = call('DefifaHook', 'safeTransferFrom', [account, hook, 1n, 1n, '0x'])
    expect(decodeDefifaTransactionCall(transfer, deployment)).toMatchObject({ contract: 'DefifaHook', functionName: 'safeTransferFrom' })
  })
})
