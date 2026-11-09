import { expect, test } from '@playwright/test'
import type { LifecycleSnapshot } from '../../src/lib/defifa-lifecycle'
import type { ActivityEvent } from '../../src/lib/activity'
import { EXAMPLE_MARKET } from '../../src/lib/example'
import { marketRanges, validateMarket } from '../../src/domain/market'

const now = Math.floor(Date.now() / 1000)
const definition = validateMarket({ ...EXAMPLE_MARKET, rangeCount: 3, rangeWidth: 1, rangeBoundaries: undefined, entryOpensAt: now - 60, entryClosesAt: now + 86_400, resolvesAt: now + 90_000 })
const zero = '0x0000000000000000000000000000000000000001'
const snapshot = (blockNumber: number): LifecycleSnapshot => ({
  market: { chainId: 8453, projectId: '29', hook: zero, governor: zero, referee: zero, definition, ranges: marketRanges(definition),
    phase: 1, stage: 'entry', blockNumber: String(blockNumber), blockTimestamp: now, potWei: '0',
    tiers: [1, 2, 3].map(tierId => ({ tierId, supply: '1', entrySupply: null, priceWei: definition.unitPriceWei, remainingSupply: '999999999' })),
    ratifiedScorecardId: null, ratifiedWeights: null, cashOutWeightTotal: '0', commitmentsFulfilled: false, noContestTriggered: false },
  account: null, positions: [], delegates: [], scorecards: [], scorecardsNextCursor: null, scorecardsComplete: true,
  attestationGraceSeconds: 86400, timelockSeconds: 3600, noContestAfter: now + 1_000_000,
  canSubmitScorecard: false, canDelegate: false, canFulfill: false, canTriggerNoContest: false, cashOutMode: null,
})
const event = (account: string, timestamp: number): ActivityEvent => ({
  kind: 'exit', transactionHash: `0x${account.slice(2, 10).repeat(8)}`, timestamp, account: account as ActivityEvent['account'], quantities: [1, 0, 0],
})
const newer = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const older = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

test('a market refresh keeps the older activity already loaded', async ({ page }) => {
  let block = 100
  await page.route('**/api.coinbase.com/**', route => route.abort())
  await page.route('**/api.exchange.coinbase.com/**', route => route.abort())
  await page.route('**/api/markets/8453/29/play?*', route => route.fulfill({ json: snapshot(block) }))
  const reads: string[] = []
  await page.route('**/api/markets/8453/29/activity?*', route => {
    const url = new URL(route.request().url())
    const at = url.searchParams.get('blockNumber')!, cursor = url.searchParams.get('cursor')
    reads.push(`${at}:${cursor ?? 'first'}`)
    if (!cursor) return route.fulfill({ json: { schema: 'metalog.activity.v2', events: [event(newer, now - 60)], complete: false, nextCursor: String(now - 60) } })
    // The older page answers once; a reload of it at a later block never completes.
    if (at !== '100') return
    return route.fulfill({ json: { schema: 'metalog.activity.v2', events: [event(older, now - 7200)], complete: true, nextCursor: null } })
  })
  await page.goto('/markets/8453/29')
  const feed = page.locator('.activity-feed')
  await expect(feed.getByText('0xbbbb…bbbb', { exact: true })).toBeVisible()

  block = 101
  await page.getByRole('tab', { name: /^Your position/ }).click()
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.getByRole('tab', { name: /^Market/ }).click()
  await expect.poll(() => reads).toContain('101:first')
  await expect(feed.getByText('0xaaaa…aaaa', { exact: true })).toBeVisible()
  await expect(feed.getByText('0xbbbb…bbbb', { exact: true })).toBeVisible()
})
