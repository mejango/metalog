import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseAbi, zeroAddress, type Address, type TransactionReceipt } from 'viem'
import { allocateManualPositions } from '../../src/domain/allocation'
import { coefficientsFromMoments } from '../../src/domain/distribution'
import { validateMarket, type MarketDefinition } from '../../src/domain/market'
import {
  createdMarketId, prepareCreateMarket, prepareEntry, readMarket, receiptMoves, verifyDefifaTransactionReceipt,
  type MarketSnapshot,
} from '../../src/lib/defifa'
import { verifyDefifaDeployment } from '../../src/lib/defifa-deployment'
import { prepareLifecycleAction, readCashOutQuote, readLifecycle } from '../../src/lib/defifa-lifecycle'
import {
  executeTransaction, readPendingTransaction, recoverTransaction,
  type PreparedTransaction, type TransactionRuntime,
} from '../../src/lib/transaction'
import { forkChainIds, startFork, type LocalFork } from './fork'

const smokeOnly = process.env.METALOG_FORK_SMOKE === 'true'
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)'])

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

describe.each(forkChainIds)('canonical Defifa contracts on local chain %i fork', chainId => {
  let fork: LocalFork
  let market: MarketSnapshot
  let definition: MarketDefinition
  const originalRpcConfiguration = process.env.METALOG_RPC_URLS
  const coefficients = coefficientsFromMoments(0, 1)
  const sent: { title: string; hash: string; blockNumber: string }[] = []

  function runtime(account: Address, storage = memoryStorage()): TransactionRuntime {
    return {
      client: fork.client, storage,
      identity: () => ({ address: account, chainId, connectorUid: 'isolated-anvil', isSigna: false }),
      review: async () => true,
      onStatus: () => {},
      switchChain: async target => { expect(target).toBe(chainId) },
      send: async request => {
        expect(new URL(fork.url).hostname).toBe('127.0.0.1')
        return fork.wallet(account).sendTransaction(request)
      },
    }
  }

  async function execute(request: PreparedTransaction): Promise<TransactionReceipt> {
    const environment = runtime(request.account)
    const receipt = await executeTransaction(request, environment)
    expect(receipt.status).toBe('success')
    expect(readPendingTransaction(environment.storage)).toBeNull()
    await verifyDefifaTransactionReceipt(request, receipt)
    sent.push({ title: request.title, hash: receipt.transactionHash, blockNumber: String(receipt.blockNumber) })
    return receipt
  }

  beforeAll(async () => {
    fork = await startFork(chainId)
    // The normal server transport override points every app read/simulation at this same EVM.
    process.env.METALOG_RPC_URLS = JSON.stringify({ [chainId]: fork.url })
    const block = await fork.client.getBlock()
    await verifyDefifaDeployment(fork.client, chainId, block.number)
    const now = Number(block.timestamp)
    definition = validateMarket({
      schemaVersion: 1, settlement: 'defifa-scorecard',
      prompt: 'Local fork qualification: percentage change over the observation period?',
      source: 'Deterministic local integration fixture; no public-chain market is created.',
      resolutionRule: 'Holders propose and attest a scorecard. The ratified scorecard controls payouts.',
      entryOpensAt: now + 120, entryClosesAt: now + 600, resolvesAt: now + 900,
      rangeCount: 3, rangeWidth: 1, unitPriceWei: '100000000000000',
    })
  })

  afterAll(async () => {
    if (fork) {
      const evidence = JSON.stringify({ chainId, fork: fork.anchor, scope: smokeOnly ? 'create-entry-recovery' : 'native-lifecycle', observedTransactions: sent })
      try {
        console.info(evidence)
        const directory = process.env.METALOG_FORK_EVIDENCE_DIR
        if (directory) {
          await mkdir(directory, { recursive: true })
          await writeFile(join(directory, `${chainId}.json`), `${evidence}\n`)
        }
      } finally { await fork.stop() }
    }
    if (originalRpcConfiguration === undefined) delete process.env.METALOG_RPC_URLS
    else process.env.METALOG_RPC_URLS = originalRpcConfiguration
  })

  it('creates immutable terms, mints, and recovers a mined entry without sending twice', async () => {
    const create = await prepareCreateMarket(definition, chainId, fork.accounts[0])
    const creation = await execute(create)
    market = await readMarket(chainId, createdMarketId(creation))
    expect(market.definition).toEqual(definition)
    expect(market.stage).toBe('countdown')
    await fork.advanceTo(definition.entryOpensAt + 1)
    market = await readMarket(chainId, market.projectId)
    const allocation = allocateManualPositions(coefficients, market.ranges, [2, 2, 2])
    const request = await prepareEntry(market, allocation, fork.accounts[0], coefficients)
    const environment = runtime(fork.accounts[0])
    const send = environment.send
    let hash: `0x${string}` | undefined
    environment.send = vi.fn(async call => {
      hash = await send(call)
      throw new Error('Injected lost wallet response after the local transaction was mined')
    })
    await expect(executeTransaction(request, environment)).rejects.toThrow('lost wallet response')
    const saved = readPendingTransaction(environment.storage)!
    expect(saved.phase).toBe('unknown')
    expect(environment.send).toHaveBeenCalledTimes(1)
    // Reconstruct callbacks from only durable calldata, as a new browser session does.
    const restored = { ...saved, value: BigInt(saved.value), verifyReceipt: (receipt: TransactionReceipt) => verifyDefifaTransactionReceipt({ ...saved, value: BigInt(saved.value) }, receipt) }
    const recovered = await recoverTransaction(environment, hash, restored)
    expect(recovered.status).toBe('success')
    expect(environment.send).toHaveBeenCalledTimes(1)
    expect(readPendingTransaction(environment.storage)).toBeNull()
    const mints = receiptMoves(market.hook, recovered).filter(move => move.from === zeroAddress)
    expect(mints.reduce((sum, move) => sum + move.value, 0n)).toBe(6n)
    market = await readMarket(chainId, market.projectId)
    expect(market.tiers.map(tier => tier.supply)).toEqual(['2', '2', '2'])
    expect(market.potWei).toBe((BigInt(definition.unitPriceWei) * 6n).toString())
    sent.push({ title: 'Recovered entry without re-send', hash: recovered.transactionHash, blockNumber: String(recovered.blockNumber) })
  })

  it.skipIf(smokeOnly)('refunds, transfers, delegates, proposes, attests, revokes, ratifies and claims', async () => {
    const secondEntry = allocateManualPositions(coefficients, market.ranges, [1, 1, 1])
    await execute(await prepareEntry(market, secondEntry, fork.accounts[1], coefficients))
    let holder = await readLifecycle(chainId, market.projectId, fork.accounts[0])
    expect(holder.positions).toEqual([{ tierId: 1, count: 2 }, { tierId: 2, count: 2 }, { tierId: 3, count: 2 }])
    expect(holder.cashOutMode).toBe('refund')
    const refund = await readCashOutQuote(holder.market, [{ tierId: 1, count: 1 }], fork.accounts[0])
    expect(refund.reclaimWei).toBe(definition.unitPriceWei)
    await execute(await prepareLifecycleAction(holder.market, {
      kind: 'cash-out', positions: [{ tierId: 1, count: 1 }], minReclaimedWei: refund.reclaimWei,
    }, fork.accounts[0]))
    holder = await readLifecycle(chainId, market.projectId, fork.accounts[0])
    expect(holder.positions).toEqual([{ tierId: 1, count: 1 }, { tierId: 2, count: 2 }, { tierId: 3, count: 2 }])
    expect(holder.market.potWei).toBe((BigInt(definition.unitPriceWei) * 8n).toString())

    await execute(await prepareLifecycleAction(holder.market, { kind: 'transfer', tierId: 3, count: 1, to: fork.accounts[2] }, fork.accounts[0]))
    const recipient = await readLifecycle(chainId, market.projectId, fork.accounts[2])
    expect(recipient.positions).toEqual([{ tierId: 3, count: 1 }])
    await execute(await prepareLifecycleAction(recipient.market, {
      kind: 'delegate', tierIds: [3], delegatee: fork.accounts[2],
    }, fork.accounts[2]))
    await expect(prepareLifecycleAction(recipient.market, { kind: 'transfer', tierId: 3, count: 2, to: fork.accounts[3] }, fork.accounts[0])).rejects.toThrow(/holds/)

    await fork.advanceTo(definition.entryClosesAt + 2)
    market = await readMarket(chainId, market.projectId)
    await expect(prepareEntry(market, secondEntry, fork.accounts[1], coefficients)).rejects.toThrow(/not accepting/)
    await expect(prepareLifecycleAction(market, { kind: 'delegate', tierIds: [1], delegatee: fork.accounts[0] }, fork.accounts[0])).rejects.toThrow(/entry is open/)
    const weights = [
      { tierId: 1, weight: '500000000000000000' },
      { tierId: 2, weight: '300000000000000000' },
      { tierId: 3, weight: '200000000000000000' },
    ]
    await execute(await prepareLifecycleAction(market, { kind: 'submit-scorecard', weights }, fork.accounts[0]))
    let lifecycle = await readLifecycle(chainId, market.projectId, fork.accounts[0])
    expect(lifecycle.scorecardsComplete).toBe(true)
    expect(lifecycle.scorecards).toHaveLength(1)
    const cardId = lifecycle.scorecards[0].scorecardId
    expect(lifecycle.scorecards[0].weights).toEqual(weights)
    expect(lifecycle.scorecards[0].stateName).toBe('Pending')
    await expect(prepareLifecycleAction(lifecycle.market, { kind: 'attest', scorecardId: cardId }, fork.accounts[0])).rejects.toThrow(/cannot attest/)
    await fork.advanceTo(definition.resolvesAt + 2)
    await execute(await prepareLifecycleAction(lifecycle.market, { kind: 'attest', scorecardId: cardId }, fork.accounts[0]))
    lifecycle = await readLifecycle(chainId, market.projectId, fork.accounts[0])
    expect(lifecycle.scorecards[0].hasAttested).toBe(true)
    await execute(await prepareLifecycleAction(lifecycle.market, { kind: 'revoke', scorecardId: cardId }, fork.accounts[0]))
    lifecycle = await readLifecycle(chainId, market.projectId, fork.accounts[0])
    expect(lifecycle.scorecards[0].hasAttested).toBe(false)
    for (const account of fork.accounts.slice(0, 3)) {
      await execute(await prepareLifecycleAction(lifecycle.market, { kind: 'attest', scorecardId: cardId }, account))
    }
    lifecycle = await readLifecycle(chainId, market.projectId, fork.accounts[0])
    expect(BigInt(lifecycle.scorecards[0].attestationCount)).toBeGreaterThanOrEqual(BigInt(lifecycle.scorecards[0].quorum))
    await expect(prepareLifecycleAction(lifecycle.market, { kind: 'forward', weights }, fork.accounts[0])).rejects.toThrow(/quorum after its grace/)
    await expect(prepareLifecycleAction(lifecycle.market, { kind: 'ratify', weights }, fork.accounts[0])).rejects.toThrow(/timelock/)
    await fork.advanceTo(lifecycle.scorecards[0].gracePeriodEnds + 2)
    lifecycle = await readLifecycle(chainId, market.projectId, fork.accounts[0])
    expect(lifecycle.scorecards[0]).toMatchObject({ stateName: 'Succeeded', canForward: true, forwarded: false })
    await execute(await prepareLifecycleAction(lifecycle.market, { kind: 'forward', weights }, fork.accounts[0]))
    lifecycle = await readLifecycle(chainId, market.projectId, fork.accounts[0])
    expect(lifecycle.scorecards[0]).toMatchObject({ stateName: 'Queued', forwarded: true, canRatify: false })
    await expect(prepareLifecycleAction(lifecycle.market, { kind: 'ratify', weights }, fork.accounts[0])).rejects.toThrow(/timelock/)
    await fork.advanceTo(lifecycle.scorecards[0].ratifiableAt! + 2)
    lifecycle = await readLifecycle(chainId, market.projectId, fork.accounts[0])
    expect(lifecycle.scorecards[0].canRatify).toBe(true)
    await execute(await prepareLifecycleAction(lifecycle.market, { kind: 'ratify', weights }, fork.accounts[0]))
    holder = await readLifecycle(chainId, market.projectId, fork.accounts[0])
    expect(holder.market.ratifiedScorecardId).toBe(cardId)
    expect(holder.market.ratifiedWeights).toEqual(weights.map(item => ({ tierId: item.tierId, weight: item.weight })))
    expect(holder.market.commitmentsFulfilled).toBe(true)
    expect(holder.cashOutMode).toBe('cash-out')
    const ids = holder.positions
    const quote = await readCashOutQuote(holder.market, ids, fork.accounts[0])
    expect(BigInt(quote.reclaimWei)).toBeGreaterThan(0n)
    const previousPot = BigInt(holder.market.potWei)
    const rewardTokens = [quote.defifaToken, quote.baseProtocolToken]
    const balances = () => Promise.all(rewardTokens.map(address => fork.client.readContract({
      address, abi: tokenAbi, functionName: 'balanceOf', args: [fork.accounts[0]],
    })))
    const rewardsBefore = await balances()
    await execute(await prepareLifecycleAction(holder.market, { kind: 'cash-out', positions: ids, minReclaimedWei: quote.reclaimWei }, fork.accounts[0]))
    const rewardsAfter = await balances()
    expect(rewardsAfter).toEqual([rewardsBefore[0] + BigInt(quote.defifaTokenWei), rewardsBefore[1] + BigInt(quote.baseProtocolTokenWei)])
    holder = await readLifecycle(chainId, market.projectId, fork.accounts[0])
    expect(holder.positions).toEqual([])
    expect(BigInt(holder.market.potWei)).toBe(previousPot - BigInt(quote.reclaimWei))
  })

  it.skipIf(smokeOnly)('activates native no-contest refunds after timeout and returns the actual remaining stake', async () => {
    const now = Number((await fork.client.getBlock()).timestamp)
    const timeoutDefinition = { ...definition, entryOpensAt: now + 120, entryClosesAt: now + 600, resolvesAt: now + 900 }
    const creation = await execute(await prepareCreateMarket(timeoutDefinition, chainId, fork.accounts[3]))
    let timeoutMarket = await readMarket(chainId, createdMarketId(creation))
    await fork.advanceTo(timeoutDefinition.entryOpensAt + 1)
    timeoutMarket = await readMarket(chainId, timeoutMarket.projectId)
    const entry = allocateManualPositions(coefficients, timeoutMarket.ranges, [1, 1, 1])
    await execute(await prepareEntry(timeoutMarket, entry, fork.accounts[3], coefficients))
    let lifecycle = await readLifecycle(chainId, timeoutMarket.projectId, fork.accounts[3])
    await fork.advanceTo(lifecycle.noContestAfter + 1)
    lifecycle = await readLifecycle(chainId, timeoutMarket.projectId, fork.accounts[3])
    expect(lifecycle.canTriggerNoContest).toBe(true)
    const ids = lifecycle.positions
    await expect(readCashOutQuote(lifecycle.market, ids, fork.accounts[3])).rejects.toThrow(/Open.*no-contest/)
    await execute(await prepareLifecycleAction(lifecycle.market, { kind: 'no-contest' }, fork.accounts[3]))
    await fork.advanceTo(Number((await fork.client.getBlock()).timestamp) + 1)
    lifecycle = await readLifecycle(chainId, timeoutMarket.projectId, fork.accounts[3])
    expect(lifecycle.market.noContestTriggered).toBe(true)
    const quote = await readCashOutQuote(lifecycle.market, ids, fork.accounts[3])
    expect(quote.reclaimWei).toBe((BigInt(definition.unitPriceWei) * 3n).toString())
    await execute(await prepareLifecycleAction(lifecycle.market, { kind: 'cash-out', positions: ids, minReclaimedWei: quote.reclaimWei }, fork.accounts[3]))
    lifecycle = await readLifecycle(chainId, timeoutMarket.projectId, fork.accounts[3])
    expect(lifecycle.positions).toEqual([])
    expect(lifecycle.market.potWei).toBe('0')
  })
})
