import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseAbi, zeroAddress, type TransactionReceipt } from 'viem'
import { TRANSACTION_GAS_CAP, writeIntentKey } from '@bananapus/nana-sdk-core/review'
import { allocateManualPositions } from '../../src/domain/allocation'
import { coefficientsFromMoments } from '../../src/domain/distribution'
import { MIN_NEW_UNIT_PRICE_WEI, validateMarket, type MarketDefinition } from '../../src/domain/market'
import { MAX_RANGE_COUNT } from '../../src/domain/ranges'
import {
  createdMarketId, prepareCreateMarket, prepareEntry, readMarket, receiptMoves,
  type MarketSnapshot,
} from '../../src/lib/defifa'
import { verifyDefifaDeployment } from '../../src/lib/defifa-deployment'
import { checkReceiptEffects } from './effects'
import { prepareLifecycleAction, readCashOutQuote, readLifecycle } from '../../src/lib/defifa-lifecycle'
import { marketIntent, type PreparedTransaction } from '../../src/lib/transaction'
import { forkChainIds, forkSender, startFork, type LocalFork } from './fork'

const smokeOnly = process.env.METALOG_FORK_SMOKE === 'true'
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)'])

describe.each(forkChainIds)('canonical Defifa contracts on local chain %i fork', chainId => {
  let fork: LocalFork
  let market: MarketSnapshot
  let definition: MarketDefinition
  const originalRpcConfiguration = process.env.METALOG_RPC_URLS
  const coefficients = coefficientsFromMoments(0, 1)
  const sent: { title: string; hash: string; blockNumber: string }[] = []

  let sender: ReturnType<typeof forkSender>
  let writes = 0
  /** Each write under its own hold: the app's scope rules are unit-tested; here the chain is. */
  async function execute(request: PreparedTransaction): Promise<TransactionReceipt> {
    expect(new URL(fork.url).hostname).toBe('127.0.0.1')
    const receipt = await sender.send(request, writeIntentKey('metalog-fork', { write: ++writes }))
    expect(receipt.status).toBe('success')
    sent.push({ title: request.title, hash: receipt.transactionHash, blockNumber: String(receipt.blockNumber) })
    return receipt
  }

  beforeAll(async () => {
    fork = await startFork(chainId)
    sender = forkSender(fork)
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
    const intent = marketIntent(market)
    const nonce = await fork.client.getTransactionCount({ address: request.account })
    await expect(sender.send(request, intent, true)).rejects.toThrow()
    // The hold refuses the same write again, then settles it from the chain alone: the mined entry, sent once.
    await expect(sender.send(request, intent)).rejects.toThrow()
    const recovered = await sender.settledReceipt(request, intent)
    expect(recovered.status).toBe('success')
    await checkReceiptEffects(request, recovered)
    expect(await fork.client.getTransactionCount({ address: request.account })).toBe(nonce + 1)
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

  it.skipIf(smokeOnly)('mints the largest entry at the minimum price for about the same gas as one position per range', async () => {
    const now = Number((await fork.client.getBlock()).timestamp)
    const wide = validateMarket({ ...definition, entryOpensAt: now + 120, entryClosesAt: now + 600, resolvesAt: now + 900,
      rangeCount: 13, unitPriceWei: MIN_NEW_UNIT_PRICE_WEI.toString() })
    const creation = await execute(await prepareCreateMarket(wide, chainId, fork.accounts[3]))
    await fork.advanceTo(wide.entryOpensAt + 1)
    const game = await readMarket(chainId, createdMarketId(creation))
    // 100M positions (1,000 ETH at the floor); the 1e9 cap would need more than a fork account holds.
    const LARGE = 100_000_000
    const spread = (total: number) => game.ranges.map((_, index) => Math.floor(total / game.ranges.length) + (index < total % game.ranges.length ? 1 : 0))
    const small = await execute(await prepareEntry(game, allocateManualPositions(coefficients, game.ranges, spread(game.ranges.length)), fork.accounts[3], coefficients))
    const large = await execute(await prepareEntry(await readMarket(chainId, game.projectId),
      allocateManualPositions(coefficients, game.ranges, spread(LARGE)), fork.accounts[4], coefficients))
    console.info('1155 entry gas', { ranges: game.ranges.length, onePerRange: small.gasUsed, maximum: large.gasUsed, positions: LARGE })
    // ERC-1155 mints one balance per range, so gas does not grow with the position count.
    expect(large.gasUsed).toBeLessThan(small.gasUsed * 12n / 10n)
    // Gas grows per range (about 182k each), so scaling the whole entry to the most ranges overestimates it;
    // it must still fit the 2^24 per-transaction cap the sent limit is clamped to. (A 61-range fork read times out cold.)
    expect(large.gasUsed * BigInt(MAX_RANGE_COUNT) / 13n).toBeLessThan(TRANSACTION_GAS_CAP)
  })
})
