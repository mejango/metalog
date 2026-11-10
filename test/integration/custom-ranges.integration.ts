import { expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFunctionData, zeroAddress } from 'viem'
import { allocatePositions } from '../../src/domain/allocation'
import { validateCoefficients } from '../../src/domain/distribution'
import { validateMarket } from '../../src/domain/market'
import {
  createdMarketId, DEFIFA_ABI, prepareCreateMarket, prepareEntry, readMarket, receiptMoves,
} from '../../src/lib/defifa'
import { creationIntent, marketIntent } from '../../src/lib/transaction'
import { loadMarketMetadata } from '../../src/lib/market-metadata'
import { forkSender, startFork } from './fork'
import { checkReceiptEffects } from './effects'

it('creates unequal ranges and recovers their curve-derived mint without sending twice on a Base Sepolia fork', async () => {
  const chainId = 84532
  const originalRpcConfiguration = process.env.METALOG_RPC_URLS
  const fork = await startFork(chainId)
  const sent: { title: string; hash: string; blockNumber: string }[] = []
  try {
    process.env.METALOG_RPC_URLS = JSON.stringify({ [chainId]: fork.url })
    const now = Number((await fork.client.getBlock()).timestamp)
    const definition = validateMarket({
      schemaVersion: 1, settlement: 'defifa-scorecard',
      prompt: 'Local custom-range qualification: percentage change?',
      source: 'Deterministic local integration fixture; no public-chain market is created.',
      resolutionRule: 'The ratified scorecard controls payouts.',
      entryOpensAt: now + 120, entryClosesAt: now + 600, resolvesAt: now + 900,
      rangeBoundaries: [-8, -1, 0.25, 6], unitPriceWei: '1000000000000',
      defaultAttestationDelegate: fork.accounts[1],
    })
    const account = fork.accounts[0]
    const sender = forkSender(fork)
    expect(new URL(fork.url).hostname).toBe('127.0.0.1')
    const preparedCreation = await prepareCreateMarket(definition, chainId, account)
    const launch = decodeFunctionData({ abi: DEFIFA_ABI.DefifaDeployer, data: preparedCreation.data }).args![0] as { projectUri: string }
    expect(launch.projectUri).toMatch(/^ipfs:\/\/Qm/)
    const published = await loadMarketMetadata(launch.projectUri)
    const creation = await sender.send(preparedCreation, creationIntent(chainId, definition))
    console.info('Local IPFS market created', { chainId, projectUri: published.projectUri, transactionHash: creation.transactionHash })
    expect(creation.status).toBe('success')
    sent.push({ title: 'Create custom ranges', hash: creation.transactionHash, blockNumber: String(creation.blockNumber) })

    let market = await readMarket(chainId, createdMarketId(creation))
    expect(market.definition).toEqual(definition)
    expect(market.definition).not.toHaveProperty('rangeCount')
    expect(market.definition).not.toHaveProperty('rangeWidth')
    expect(market.ranges).toEqual([
      { tierId: 1, lower: null, upper: -8, label: '< -8%' },
      { tierId: 2, lower: -8, upper: -1, label: '-8% to < -1%' },
      { tierId: 3, lower: -1, upper: 0.25, label: '-1% to < +0.25%' },
      { tierId: 4, lower: 0.25, upper: 6, label: '+0.25% to < +6%' },
      { tierId: 5, lower: 6, upper: null, label: '≥ +6%' },
    ])
    // readMarket also compares each decoded label and boundary-derived tier ID to the native hook.
    expect(market.tiers.map(tier => [tier.tierId, tier.priceWei, tier.supply])).toEqual(
      [1, 2, 3, 4, 5].map(id => [id, definition.unitPriceWei, '0']),
    )
    await fork.advanceTo(definition.entryOpensAt + 1)
    market = await readMarket(chainId, market.projectId)
    const coefficients = validateCoefficients([0, 2])
    const allocation = allocatePositions(coefficients, market.ranges, 100)
    // Independent closed-form logistic CDF checks the mass of every unequal interval, including tails.
    const cumulative = [0, ...[-8, -1, 0.25, 6].map(boundary => 1 / (1 + Math.exp(-boundary / 2))), 1]
    allocation.probabilities.forEach((probability, index) => {
      expect(probability).toBeCloseTo(cumulative[index + 1] - cumulative[index], 12)
    })
    expect(allocation.quantities).toEqual([2, 36, 15, 42, 5])
    const request = await prepareEntry(market, allocation, account, coefficients)
    expect(request.value).toBe(100n * BigInt(definition.unitPriceWei))
    console.info('Local 100-position entry prepared', { chainId, projectId: market.projectId })
    const intent = marketIntent(market)
    const nonce = await fork.client.getTransactionCount({ address: account })
    await expect(sender.send(request, intent, true)).rejects.toThrow()
    await expect(sender.send(request, intent)).rejects.toThrow()
    const recovered = await sender.settledReceipt(request, intent)
    expect(recovered.status).toBe('success')
    await checkReceiptEffects(request, recovered)
    console.info('Local 100-position entry recovered', { chainId, transactionHash: recovered.transactionHash })
    expect(await fork.client.getTransactionCount({ address: account })).toBe(nonce + 1)
    const mints = receiptMoves(market.hook, recovered).filter(move => move.from === zeroAddress)
    expect(mints.reduce((sum, move) => sum + move.value, 0n)).toBe(100n)
    // Native position labels are the onchain tier names. Full tokenURI also loads
    // two large onchain fonts; qualify that renderer on a full-node RPC.
    for (const range of market.ranges) {
      expect(await fork.client.readContract({ address: market.hook, abi: DEFIFA_ABI.DefifaHook,
        functionName: 'tierNameOf', args: [BigInt(range.tierId)] })).toBe(range.label)
    }
    market = await readMarket(chainId, market.projectId)
    expect(market.definition).toEqual(definition)
    expect(market.tiers.map(tier => tier.supply)).toEqual(['2', '36', '15', '42', '5'])
    expect(market.potWei).toBe(request.value.toString())
    for (const tierId of [1, 2, 3, 4, 5]) {
      expect(await fork.client.readContract({ address: market.hook, abi: DEFIFA_ABI.DefifaHook, functionName: 'getTierDelegateOf', args: [account, BigInt(tierId)] })).toBe(definition.defaultAttestationDelegate)
    }
    expect(request.details).toContainEqual({ label: 'Voting address', value: definition.defaultAttestationDelegate })
    sent.push({ title: 'Recovered custom-range curve entry', hash: recovered.transactionHash, blockNumber: String(recovered.blockNumber) })
  } finally {
    if (originalRpcConfiguration === undefined) delete process.env.METALOG_RPC_URLS
    else process.env.METALOG_RPC_URLS = originalRpcConfiguration
    try {
      const evidence = JSON.stringify({ chainId, fork: fork.anchor, scope: 'custom-range-create-entry-recovery', observedTransactions: sent })
      console.info(evidence)
      const directory = process.env.METALOG_FORK_EVIDENCE_DIR
      if (directory) {
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, `custom-ranges-${chainId}.json`), `${evidence}\n`)
      }
    } finally { await fork.stop() }
  }
// Center-backed cold forks fetch every token's storage; keep the 100-position
// qualification while bounding the whole test independently of production RPC.
}, 600_000)
