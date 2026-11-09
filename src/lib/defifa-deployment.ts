import { concat, getAddress, keccak256, pad, toHex, type Abi, type Address, type Hex, type PublicClient } from 'viem'
import artifacts from './defifa-deployments.json'
import abi from './defifa-abi.json'

export type Deployment = {
  deployer: Address
  governor: Address
  referee: Address
  implementation: Address
  hookLib: Address
  terminal: Address
  projects: Address
  controller: Address
  directory: Address
  store: Address
  deployerBlock: string
  deployerGetters: Record<string, string>
  hookGetters: Record<string, string>
}

export const DEFIFA_ABI = abi as Record<keyof typeof abi, Abi>

/** JBMetadataResolver layout for one hook payload: reserved word, lookup table (id, word offset 2), payload. */
export function hookMetadata(target: Address, purpose: 'pay' | 'cashOut', payload: Hex): Hex {
  const id = (BigInt(target.slice(0, 10)) ^ BigInt(keccak256(toHex(purpose)).slice(0, 10))).toString(16).padStart(8, '0')
  return concat([pad('0x', { size: 32 }), pad(`0x${id}02`, { dir: 'right', size: 32 }), payload])
}

export function deploymentForChain(chainId: number): Deployment {
  const deployment = artifacts.chains[String(chainId) as keyof typeof artifacts.chains]
  if (!deployment) throw new Error('Defifa is not configured on this network.')
  return deployment as Deployment
}

type Fingerprint = { bytes: number; hash: string; immutableRanges: number[][] }

/** Compiler-provided immutable slots are compared through their getters below. */
export function assertDeploymentCode(code: Hex | undefined, fingerprint: Fingerprint, name: string): void {
  if (!code || (code.length - 2) / 2 !== fingerprint.bytes) {
    throw new Error(`${name} deployment code is unavailable or does not match.`)
  }
  let body = code.slice(2)
  for (const [start, length] of fingerprint.immutableRanges) {
    body = body.slice(0, start * 2) + '0'.repeat(length * 2) + body.slice((start + length) * 2)
  }
  if (keccak256(`0x${body}`) !== fingerprint.hash) {
    throw new Error(`${name} deployment code does not match the pinned release.`)
  }
}

export function sameAddress(actual: unknown, expected: Address): boolean {
  return typeof actual === 'string' && actual.toLowerCase() === expected.toLowerCase()
}

export async function contractRead<T>(
  client: PublicClient,
  address: Address,
  contract: keyof typeof DEFIFA_ABI,
  functionName: string,
  args: readonly unknown[],
  blockNumber: bigint,
): Promise<T> {
  return await client.readContract({ address, abi: DEFIFA_ABI[contract], functionName, args, blockNumber }) as T
}

export async function assertChain(client: PublicClient, chainId: number): Promise<void> {
  deploymentForChain(chainId)
  if (await client.getChainId() !== chainId) throw new Error('The RPC network does not match this market.')
}

/** No cached verification authorizes a later write; every preparation/recheck pins fresh evidence. */
export async function verifyDefifaDeployment(client: PublicClient, chainId: number, blockNumber: bigint): Promise<Deployment> {
  await assertChain(client, chainId)
  const deployment = deploymentForChain(chainId)
  const fingerprints = artifacts.fingerprints
  await Promise.all(([
    ['DefifaDeployer', deployment.deployer],
    ['DefifaGovernor', deployment.governor],
    ['DefifaHook', deployment.implementation],
    ['DefifaHookLib', deployment.hookLib],
    ['DefifaVotingReferee', deployment.referee],
  ] as const).map(async ([name, address]) => {
    assertDeploymentCode(await client.getCode({ address, blockNumber }), fingerprints[name], name)
  }))

  // Core addresses are pinned to the release manifest; Defifa's immutable links must agree.
  // Their current bytecode is required, but is not claimed to be fingerprinted by this adapter.
  await Promise.all((['terminal', 'projects', 'controller', 'directory', 'store'] as const).map(async name => {
    const code = await client.getCode({ address: deployment[name], blockNumber })
    if (!code || code === '0x') throw new Error(`The configured ${name} contract is unavailable.`)
  }))

  const checkGetters = async (address: Address, contract: 'DefifaDeployer' | 'DefifaHook', getters: Record<string, string>) => {
    await Promise.all(Object.entries(getters).map(async ([functionName, expected]) => {
      const actual = await contractRead<unknown>(client, address, contract, functionName, [], blockNumber)
      const matches = expected.startsWith('0x')
        ? sameAddress(actual, getAddress(expected))
        : typeof actual === 'bigint' && actual === BigInt(expected)
      if (!matches) throw new Error(`${contract}.${functionName} does not match the configured deployment.`)
    }))
  }
  await Promise.all([
    checkGetters(deployment.deployer, 'DefifaDeployer', deployment.deployerGetters),
    checkGetters(deployment.implementation, 'DefifaHook', deployment.hookGetters),
    ...(['DefifaGovernor', 'DefifaVotingReferee'] as const).map(contract => contractRead<Address>(
      client, contract === 'DefifaGovernor' ? deployment.governor : deployment.referee, contract, 'CONTROLLER', [], blockNumber,
    ).then(controller => {
      if (!sameAddress(controller, deployment.controller)) throw new Error(`The ${contract} controller does not match.`)
    })),
  ])
  return deployment
}

export function assertGameClone(code: Hex | undefined, implementation: Address): void {
  const expected = `0x363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`
  if (code?.toLowerCase() !== expected) throw new Error('The game hook is not a canonical Defifa clone.')
}
