import { encodeFunctionData, zeroAddress, type Abi, type Address } from 'viem'
import deployments from '../../src/lib/defifa-deployments.json' with { type: 'json' }
import abis from '../../src/lib/defifa-abi.json' with { type: 'json' }

/** ABI-valid native call identity only; not a valid market/effect-authority fixture. */
export const nativeCreationRequest = {
  chainId: 8453,
  to: deployments.chains['8453'].deployer as Address,
  value: 7n,
  data: encodeFunctionData({ abi: abis.DefifaDeployer as Abi, functionName: 'launchGameWith', args: [{
    name: 'Test identity', projectUri: '', contractUri: '', baseUri: '', tiers: [], tierPrice: 1n,
    token: { token: zeroAddress, decimals: 18, currency: 1 }, mintPeriodDuration: 600, refundPeriodDuration: 0,
    start: 1_800_000_000n, splits: [],
    defaultAttestationDelegate: zeroAddress, defaultTokenUriResolver: zeroAddress,
    terminal: deployments.chains['8453'].terminal, minParticipation: 0n, scorecardTimeout: 1000, timelockDuration: 3600n,
    referee: deployments.chains['8453'].referee, refereeData: '0x',
  }] }),
}
