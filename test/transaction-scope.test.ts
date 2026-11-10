import { describe, expect, it } from 'vitest'
import { encodeFunctionData, type Address } from 'viem'
import { DEFIFA_ABI, deploymentForChain } from '../src/lib/defifa-deployment'
import { decodeDefifaTransactionCall } from './integration/effects'

const chainId = 8453
const deployment = deploymentForChain(chainId)
const hook = '0x0000000000000000000000000000000000000011' as Address
const account = '0x0000000000000000000000000000000000000022' as Address
function call(contract: keyof typeof DEFIFA_ABI, functionName: string, args: readonly unknown[], value = 0n) {
  const to = contract === 'DefifaGovernor' ? deployment.governor : contract === 'DefifaVotingReferee' ? deployment.referee : contract === 'DefifaDeployer' ? deployment.deployer
    : contract === 'JBMultiTerminal' ? deployment.terminal : hook
  return { chainId, to, data: encodeFunctionData({ abi: DEFIFA_ABI[contract], functionName, args }), value }
}

describe('native call decoding', () => {
  it('decodes native and hook calls for receipt checks', () => {
    const request = call('DefifaVotingReferee', 'attestToScorecardFrom', [27n, 1n])
    expect(decodeDefifaTransactionCall(request, deployment)).toMatchObject({ contract: 'DefifaVotingReferee', functionName: 'attestToScorecardFrom', args: [27n, 1n] })
    const transfer = call('DefifaHook', 'safeTransferFrom', [account, hook, 1n, 1n, '0x'])
    expect(decodeDefifaTransactionCall(transfer, deployment)).toMatchObject({ contract: 'DefifaHook', functionName: 'safeTransferFrom' })
  })
})
