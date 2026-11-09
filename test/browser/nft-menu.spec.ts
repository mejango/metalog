import { expect, test } from '@playwright/test'
import type { LifecycleSnapshot } from '../../src/lib/defifa-lifecycle'
import { EXAMPLE_MARKET } from '../../src/lib/example'
import { marketRanges, validateMarket } from '../../src/domain/market'

const account = '0x1111111111111111111111111111111111111111'
const delegate = '0x3333333333333333333333333333333333333333'
const now = Math.floor(Date.now() / 1000)
const definition = validateMarket({ ...EXAMPLE_MARKET, rangeCount: 3, rangeWidth: 1, rangeBoundaries: undefined, entryOpensAt: now - 60, entryClosesAt: now + 86_400, resolvesAt: now + 90_000 })
const snapshot: LifecycleSnapshot = {
  market: { chainId: 8453, projectId: '28', hook: account, governor: account, referee: account, definition, ranges: marketRanges(definition),
    phase: 1, stage: 'entry', blockNumber: '100', blockTimestamp: now, potWei: '4000000000000',
    tiers: [1, 2, 3].map(tierId => ({ tierId, supply: '2', entrySupply: null, priceWei: definition.unitPriceWei, remainingSupply: '999999999' })),
    ratifiedScorecardId: null, ratifiedWeights: null, cashOutWeightTotal: '1000000000000000000', commitmentsFulfilled: false, noContestTriggered: false },
  account, positions: [{ tierId: 1, count: 3 }, { tierId: 2, count: 1 }],
  delegates: [{ tierId: 2, delegate }],
  scorecards: [], scorecardsNextCursor: null, scorecardsComplete: true, attestationGraceSeconds: 86400, timelockSeconds: 3600,
  noContestAfter: now + 1000000, canSubmitScorecard: false, canDelegate: true, canFulfill: false, canTriggerNoContest: false, cashOutMode: 'refund',
}

test('transfer and delegation open from each range menu, inline under that range, with burn counts per range', async ({ page }) => {
  await page.addInitScript(account => {
    const provider = {
      on() { return provider }, removeListener() { return provider },
      async request({ method }: { method: string }) {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account]
        if (method === 'eth_chainId') return '0x2105'
        if (method === 'wallet_getPermissions' || method === 'wallet_requestPermissions') return [{ parentCapability: 'eth_accounts' }]
        if (method === 'wallet_getCapabilities') return {}
        throw new Error(`This presentation-only wallet cannot execute ${method}.`)
      },
    }
    Object.assign(window, { ethereum: provider })
  }, account)
  await page.route('**/api.coinbase.com/**', route => route.abort())
  await page.route('**/api/markets/8453/28/play?*', route => route.fulfill({ json: snapshot }))
  await page.route('**/api/markets/8453/28/activity*', route => route.fulfill({ json: { events: [], complete: true } }))
  await page.goto('/markets/8453/28')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByRole('button', { name: 'Injected', exact: true }).click()
  await page.getByRole('tab', { name: /^Your position/ }).click()
  await expect(page.getByText('Transfer an position', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Voting delegation', { exact: true })).toHaveCount(0)

  const rows = page.locator('.inventory-table tbody tr')
  await expect(rows.nth(0)).toContainText(`${snapshot.market.ranges[0].label}3`)
  // Refund counts per range are clamped to what the wallet holds.
  const burn = page.getByLabel(`Positions to burn in ${snapshot.market.ranges[0].label}`, { exact: true })
  await burn.fill('9')
  await expect(burn).toHaveValue('3')
  await page.getByRole('button', { name: 'Clear selection (3)', exact: true }).click()
  await expect(burn).toHaveValue('0')
  await page.getByRole('button', { name: 'Select all', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Clear selection (4)', exact: true })).toBeVisible()

  await page.getByLabel(`Actions for ${snapshot.market.ranges[0].label}`, { exact: true }).click()
  await page.getByRole('menuitem', { name: 'Transfer', exact: true }).click()
  await expect(page.getByRole('menu')).toBeHidden()
  const recipient = page.getByLabel('Transfer recipient', { exact: true })
  const count = page.getByLabel('Positions to send', { exact: true })
  await expect(count).toHaveValue('3')
  const review = page.getByRole('button', { name: 'Review transfer', exact: true })
  await expect(review).toBeDisabled()
  await recipient.fill(delegate)
  await expect(review).toBeEnabled()
  await count.fill('4')
  await expect(review).toBeDisabled()
  await count.fill('2')
  await expect(review).toBeEnabled()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(recipient).toHaveCount(0)

  await page.getByLabel(`Actions for ${snapshot.market.ranges[1].label}`, { exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delegate votes', exact: true }).click()
  await expect(page.getByText(delegate, { exact: true })).toBeVisible()
  const delegation = page.getByRole('button', { name: 'Review delegation', exact: true })
  await expect(delegation).toBeDisabled()
  await page.getByRole('button', { name: 'Use my wallet', exact: true }).click()
  await expect(delegation).toBeEnabled()
})
