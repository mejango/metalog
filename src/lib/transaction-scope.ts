import { decodeFunctionData, type Address, type Hex } from 'viem'
import { DEFIFA_ABI, sameAddress, type Deployment } from './defifa-deployment'

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
