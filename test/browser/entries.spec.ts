import { expect, test } from '@playwright/test'
import type { LifecycleSnapshot } from '../../src/lib/defifa-lifecycle'
import type { EntryHistoryEntry } from '../../src/lib/entries'
import type { ActivityPage } from '../../src/lib/activity'
import { EXAMPLE_MARKET } from '../../src/lib/example'
import { marketRanges, validateMarket } from '../../src/domain/market'

const definition = validateMarket({ ...EXAMPLE_MARKET, rangeCount: 3, rangeWidth: 1, rangeBoundaries: undefined })
const account = '0x1111111111111111111111111111111111111111'
const hash = `0x${'ab'.repeat(32)}` as const
const market: LifecycleSnapshot = {
  market: { chainId: 8453, projectId: '27', hook: account, governor: account, referee: account, definition, ranges: marketRanges(definition),
    phase: 3, stage: 'settlement', blockNumber: '100', blockTimestamp: definition.resolvesAt + 1, potWei: '4000000000000',
    tiers: [1, 2, 3].map(tierId => ({ tierId, supply: tierId === 2 ? '2' : '1', entrySupply: tierId === 2 ? '2' : '1', priceWei: definition.unitPriceWei, remainingSupply: '999999999' })),
    ratifiedScorecardId: null, ratifiedWeights: null, cashOutWeightTotal: '1000000000000000000', commitmentsFulfilled: false, noContestTriggered: false },
  account: null, positions: [], delegates: [],
  scorecards: [], scorecardsNextCursor: null, scorecardsComplete: true, attestationGraceSeconds: 86400, timelockSeconds: 3600,
  noContestAfter: definition.resolvesAt + 1000000, canSubmitScorecard: false, canDelegate: false, canFulfill: false, canTriggerNoContest: false, cashOutMode: null,
}
const entry: EntryHistoryEntry = { status: 'verified-curve', transactionHash: hash, blockNumber: '95', timestamp: definition.entryOpensAt + 600,
  account, beneficiary: account, stakeWei: '4000000000000', quantities: [1, 2, 1], coefficients: [0, 1, 0, 0, 0, 0] }
const manualHash = `0x${'cd'.repeat(32)}` as const
const activity: ActivityPage = { schema: 'metalog.activity.v2', complete: true, nextCursor: null, events: [
  { kind: 'exit', transactionHash: `0x${'ef'.repeat(32)}`, timestamp: definition.resolvesAt, account, quantities: [0, 1, 0] },
  { kind: 'entry', transactionHash: hash, timestamp: definition.entryOpensAt + 600, account, quantities: [1, 2, 1] },
  { kind: 'entry', transactionHash: manualHash, timestamp: definition.entryOpensAt + 300, account, quantities: [0, 4, 0] },
] }

test('crowd activity lists entries and exits; an opened entry shows its checked record', async ({ page }) => {
  const entryReads: URL[] = []
  await page.route('**/api/markets/8453/27/play?*', route => route.fulfill({ json: market }))
  await page.route('**/api/markets/8453/27/activity?*', route => {
    const url = new URL(route.request().url())
    expect(url.searchParams.get('blockNumber')).toBe('100')
    // Two block windows: the older one loads on its own, with no button to press.
    return route.fulfill({ json: url.searchParams.get('cursor') === '92'
      ? { ...activity, events: activity.events.slice(1) } : { ...activity, complete: false, nextCursor: '92', events: activity.events.slice(0, 1) } })
  })
  await page.route('**/api/markets/8453/27/entries?*', route => {
    const url = new URL(route.request().url()); entryReads.push(url)
    expect(url.searchParams.get('blockNumber')).toBe('100')
    return route.fulfill({ json: { entry: url.searchParams.get('tx') === manualHash
      ? { ...entry, status: 'verified-manual', transactionHash: manualHash, quantities: [0, 4, 0] }
      : entry } })
  })
  await page.goto('/markets/8453/27')
  await expect(page.getByRole('heading', { name: definition.prompt, exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Entries', exact: true })).toHaveCount(0)
  await page.getByRole('tab', { name: /^Market/ }).click()
  const feed = page.getByRole('region', { name: 'Activity', exact: true })
  const rows = feed.getByRole('listitem')
  await expect(rows).toHaveCount(3)
  await expect(feed.getByRole('button', { name: /activity|earlier/i })).toHaveCount(0)
  await expect(rows.nth(0)).toContainText('exited with 1 position')
  await expect(rows.nth(1)).toContainText('entered with 4 positions')
  expect(entryReads).toHaveLength(0)
  await rows.nth(1).locator('summary').click()
  await expect(rows.nth(1).getByRole('img', { name: 'Submitted curve and minted positions' })).toBeVisible()
  expect(entryReads.at(-1)!.searchParams.get('tx')).toBe(hash)
  await expect(rows.nth(1).getByRole('link', { name: 'View mint receipt' })).toHaveAttribute('href', `https://basescan.org/tx/${hash}`)
  await expect(rows.nth(1).getByText('Showing the last valid allocation while you edit.', { exact: true })).toHaveCount(0)
  await rows.nth(1).getByText('Raw record', { exact: true }).click()
  await expect(rows.nth(1).getByText('a-coefficients:', { exact: false })).toContainText('[0,1,0,0,0,0]')
  await rows.nth(2).locator('summary').click()
  await expect(rows.nth(2).getByText('Reference curve', { exact: true })).toBeVisible()
  await expect(rows.nth(0).locator('summary')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('missing curves and read failures are explicit and never replaced with fabricated forecasts', async ({ page }) => {
  let reads = 0
  await page.route('**/api/markets/8453/27/play?*', route => route.fulfill({ json: market }))
  await page.route('**/api/markets/8453/27/activity?*', route => route.fulfill({ json: activity }))
  await page.route('**/api/markets/8453/27/entries?*', route => ++reads === 1
    ? route.fulfill({ status: 503, json: { error: 'Entry history could not be verified. Try again.' } })
    : route.fulfill({ json: { entry: { ...entry, status: 'unsupported', coefficients: null, beneficiary: null, stakeWei: null, reason: 'Wrapped calls are not decoded.' } } }))
  await page.goto('/markets/8453/27')
  await page.getByRole('tab', { name: /^Market/ }).click()
  const row = page.getByRole('region', { name: 'Activity', exact: true }).getByRole('listitem').nth(1)
  await row.locator('summary').click()
  await expect(row.getByRole('alert')).toHaveText('Entry history could not be verified. Try again.')
  await row.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(row.getByText('Wrapped calls are not decoded.', { exact: true })).toBeVisible()
  await expect(row.getByRole('img')).toHaveCount(0)
  await expect(row.getByText('Curve unavailable, amount unavailable, multiple recipients', { exact: true })).toBeVisible()
})
