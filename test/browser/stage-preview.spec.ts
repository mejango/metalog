import { expect, test } from '@playwright/test'
import type { LifecycleSnapshot } from '../../src/lib/defifa-lifecycle'

const opening = Math.floor(Date.now() / 1000) - 90_000
const snapshot: LifecycleSnapshot = {
  market: {
    chainId: 84532, projectId: '47', hook: '0x1111111111111111111111111111111111111111', governor: '0x2222222222222222222222222222222222222222', referee: '0x2222222222222222222222222222222222222222',
    definition: {
      schemaVersion: 1, settlement: 'defifa-scorecard', prompt: 'Preview market', source: 'Test source', resolutionRule: 'Observe it.',
      entryOpensAt: opening, entryClosesAt: opening + 86_400, resolvesAt: opening + 172_800, rangeCount: 3, rangeWidth: 1, unitPriceWei: '1000000000000',
    },
    ranges: [{ tierId: 1, lower: null, upper: -.5, label: '< -0.5%' }, { tierId: 2, lower: -.5, upper: .5, label: '-0.5% to < +0.5%' }, { tierId: 3, lower: .5, upper: null, label: '≥ +0.5%' }],
    phase: 3, stage: 'trading', blockNumber: '100', blockTimestamp: opening + 90_000, potWei: '0',
    tiers: [1, 2, 3].map(tierId => ({ tierId, supply: '0', entrySupply: null, priceWei: '1000000000000', remainingSupply: '999999999' })),
    ratifiedScorecardId: null, ratifiedWeights: null, cashOutWeightTotal: '1000000000000000000', commitmentsFulfilled: false, noContestTriggered: false,
  },
  account: null, positions: [], delegates: [],
  scorecards: [], scorecardsNextCursor: null, scorecardsComplete: true, attestationGraceSeconds: 86400, timelockSeconds: 3600,
  noContestAfter: opening + 606300, canSubmitScorecard: false, canDelegate: false, canFulfill: false, canTriggerNoContest: false, cashOutMode: null,
}

test('previewing another stage restyles the page and disables every action until back to live', async ({ page }) => {
  await page.route('**/api.coinbase.com/**', route => route.abort())
  await page.route('**/api/markets/84532/47/play?*', route => route.fulfill({ json: snapshot }))
  await page.goto('/markets/84532/47')
  const lamps = page.getByRole('list', { name: 'Game stages', exact: true }).getByRole('listitem')
  const entry = page.getByRole('button', { name: 'Connect to enter', exact: true })
  await expect(lamps.nth(1)).toHaveAttribute('aria-current', 'step')
  // The running segment shows its length and the time left.
  await expect(lamps.nth(1).locator('.lamp-left')).toHaveText(/^\d+h \d+m left$/)
  await expect(lamps.nth(0).locator('.lamp-left')).toHaveCount(0)
  await expect(page.getByText('Locked', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Preview Claims', exact: true }).click()
  await expect(page.getByText('nothing can be sent', { exact: false })).toBeVisible()
  await expect(lamps.nth(3)).toHaveAttribute('aria-current', 'step')
  await expect(lamps.nth(1)).toHaveAttribute('data-live', 'true')
  await expect(page.getByText('Claimable', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Preview Enter', exact: true }).click()
  await expect(page.getByText('Open', { exact: true })).toBeVisible()
  // The entry form appears as it would during entry, but a preview can never send it.
  await expect(entry).toBeVisible()
  await expect(entry).toBeDisabled()
  // Pay this, collect that: the best case, your curve's expectation and each range's return.
  await expect(page.locator('.order-returns')).toContainText(/Best case .+ ETH \(.+x\).*Your curve expects .+ ETH \(.+x\)/)
  await expect(page.getByRole('table', { name: 'Your order', exact: true }).getByRole('columnheader', { name: 'If it ends here' })).toBeVisible()
  await page.getByRole('button', { name: 'Preview Start', exact: true }).click()
  await expect(page.getByText('nothing can be sent', { exact: false })).toHaveCount(0)
  await expect(entry).toHaveCount(0)
  await page.getByRole('button', { name: 'Preview Enter', exact: true }).click()
  await page.getByRole('button', { name: 'Back to live', exact: true }).click()
  await expect(lamps.nth(1)).toHaveAttribute('aria-current', 'step')
  await expect(entry).toHaveCount(0)
})

test('dust left in a claimed pot reads as a floor', async ({ page }) => {
  await page.route('**/api.coinbase.com/**', route => route.fulfill({ json: { data: { amount: '2450' } } }))
  await page.route('**/api/markets/84532/47/play?*', route => route.fulfill({ json: { ...snapshot, market: { ...snapshot.market, potWei: '1' } } }))
  await page.goto('/markets/84532/47')
  await expect(page.locator('.pot strong')).toHaveText('<$0.01')
  await expect(page.locator('.pot-amounts')).toContainText('<0.000001 ETH')
})

test('in play, a preset market marks where its outcome stands now', async ({ page }) => {
  await page.route('**/api.coinbase.com/**', route => route.abort())
  const start = snapshot.market.definition.entryClosesAt
  await page.route('**/api.exchange.coinbase.com/products/ETH-USD/candles?*', route => route.fulfill({ json: [[start, 1, 1, 2000, 1, 1], [start - 60, 1, 1, 1, 1, 1]] }))
  await page.route('**/api.exchange.coinbase.com/products/ETH-USD/ticker', route => route.fulfill({ json: { price: '2010' } }))
  await page.route('**/api/markets/84532/47/play?*', route => route.fulfill({ json: { ...snapshot, market: { ...snapshot.market,
    definition: { ...snapshot.market.definition, source: 'Coinbase Exchange ETH-USD 60-second candles: https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=60' },
    tiers: snapshot.market.tiers.map(tier => ({ ...tier, supply: '3' })) } } }))
  await page.goto('/markets/84532/47')
  // 2000 to 2010 is +0.5%, the top range.
  await expect(page.locator('.chart-now text')).toHaveText('Now +0.5% | 3 positions here')
})

test('in play, the Market tab adds an order book that cannot trade without a venue', async ({ page }) => {
  await page.route('**/api.coinbase.com/**', route => route.abort())
  await page.route('**/api/markets/84532/47/play?*', route => route.fulfill({ json: { ...snapshot, market: { ...snapshot.market,
    potWei: '6000000000000', tiers: snapshot.market.tiers.map(tier => ({ ...tier, supply: '2' })) } } }))
  await page.route('**/api/markets/84532/47/activity?*', route => route.fulfill({ json: { schema: 'metalog.activity.v2', events: [], complete: true, nextCursor: null } }))
  await page.goto('/markets/84532/47')
  const book = page.getByRole('region', { name: 'Order book', exact: true })
  await expect(book).toBeVisible()
  await expect(page.getByRole('region', { name: 'Activity', exact: true })).toBeVisible()
  // Production has no venue: no sample prices or odds, and nothing can be bought or sold.
  await expect(book.getByText('Sample book', { exact: false })).toHaveCount(0)
  await expect(book.getByText('No trading venue is connected yet.', { exact: true })).toBeVisible()
  for (const button of await book.getByRole('button', { name: /^(Buy|Sell)$/ }).all()) await expect(button).toBeDisabled()
  // Your curve prices the book; with no asks there is no multiple and no row is called cheap or dear.
  await expect(book.getByRole('columnheader', { name: 'Your curve' })).toBeVisible()
  // With no proposal yet, a range's payout reads both ways: winning, or a 20% runner-up.
  await expect(book.getByRole('columnheader', { name: 'If it wins' })).toBeVisible()
  await expect(book.getByRole('columnheader', { name: 'If runner-up' })).toBeVisible()
  await expect(book.locator('tr[data-edge]')).toHaveCount(0)
  await book.getByRole('button', { name: snapshot.market.ranges[1].label, exact: true }).click()
  await expect(book.getByRole('button', { name: 'Review bid', exact: true })).toBeDisabled()
  // No venue, so the asked chance shows the crowd alone.
  await expect(page.getByText('on the book', { exact: false })).toHaveCount(0)
  // Entry is not play: the book is not shown.
  await page.getByRole('button', { name: 'Preview Enter', exact: true }).click()
  await expect(book).toHaveCount(0)
})
