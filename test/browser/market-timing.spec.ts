import { expect, test } from '@playwright/test'
import type { LifecycleSnapshot } from '../../src/lib/defifa-lifecycle'

const opening = Date.UTC(2026, 9, 11) / 1000
const snapshot: LifecycleSnapshot = {
  market: {
    chainId: 84532, projectId: '46', hook: '0x1111111111111111111111111111111111111111', governor: '0x2222222222222222222222222222222222222222', referee: '0x2222222222222222222222222222222222222222',
    definition: {
      schemaVersion: 1, settlement: 'defifa-scorecard', prompt: 'Timing regression market', source: 'Test source', resolutionRule: 'Observe the two UTC times.',
      entryOpensAt: opening, entryClosesAt: opening + 600, resolvesAt: opening + 1500, rangeCount: 3, rangeWidth: 1, unitPriceWei: '1000000000000',
    },
    ranges: [{ tierId: 1, lower: null, upper: -.5, label: '< -0.5%' }, { tierId: 2, lower: -.5, upper: .5, label: '-0.5% to < +0.5%' }, { tierId: 3, lower: .5, upper: null, label: '≥ +0.5%' }],
    phase: 1, stage: 'entry', blockNumber: '100', blockTimestamp: opening + 60, potWei: '0',
    tiers: [1, 2, 3].map(tierId => ({ tierId, supply: '0', entrySupply: null, priceWei: '1000000000000', remainingSupply: '999999999' })),
    ratifiedScorecardId: null, ratifiedWeights: null, cashOutWeightTotal: '1000000000000000000', commitmentsFulfilled: false, noContestTriggered: false,
  },
  account: null, positions: [], delegates: [],
  scorecards: [], scorecardsNextCursor: '99', scorecardsComplete: false, attestationGraceSeconds: 86400, timelockSeconds: 3600,
  noContestAfter: opening + 606300, canSubmitScorecard: false, canDelegate: true, canFulfill: false, canTriggerNoContest: false, cashOutMode: 'refund',
}

test('market dates distinguish entry from observation and historical snapshots disable actions without losing the draft', async ({ page }) => {
  let releasePinned!: () => void
  const pinnedResponse = new Promise<void>(resolve => { releasePinned = resolve })
  let releaseLatest!: () => void
  const latestResponse = new Promise<void>(resolve => { releaseLatest = resolve })
  let latestReads = 0
  await page.route('**/api/markets/84532/46/play?*', async route => {
    const pinned = new URL(route.request().url()).searchParams.get('blockNumber')
    if (pinned) {
      expect(pinned).toBe('100')
      await pinnedResponse
      return route.fulfill({ json: { ...snapshot, scorecardsNextCursor: null, scorecardsComplete: true } })
    }
    if (++latestReads === 1) return route.fulfill({ json: snapshot })
    await latestResponse
    return route.fulfill({ json: { ...snapshot, market: { ...snapshot.market, phase: 3, stage: 'settlement', blockNumber: '200', blockTimestamp: opening + 1600 }, scorecardsNextCursor: null, scorecardsComplete: true } })
  })
  await page.goto('/markets/84532/46')
  await expect(page.getByRole('heading', { name: 'Timing regression market', exact: true })).toBeVisible()
  const lamps = page.getByRole('list', { name: 'Game stages', exact: true }).getByRole('listitem')
  await expect(lamps.nth(0)).toHaveAttribute('aria-current', 'step')
  await expect(lamps.nth(0)).toContainText('Oct 11, 00:00 UTC')
  await expect(lamps.nth(1)).toContainText('Oct 11, 00:10 UTC')
  await expect(lamps.nth(2)).toContainText('Oct 11, 00:25 UTC')
  const viewTab = page.getByRole('tab', { name: /^Market/ })
  await expect(viewTab).toHaveAttribute('aria-selected', 'true')
  const entry = page.getByRole('button', { name: 'Connect to enter', exact: true })
  await expect(entry).toBeEnabled()
  const mean = page.getByRole('textbox', { name: 'Mean (%)', exact: true })
  await mean.fill('3.25')
  await page.getByRole('tab', { name: 'Results', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Results', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Scorecards', exact: true })).toHaveCount(0)
  await expect(page.getByText('Propose a result', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Load more results', exact: true }).click()
  await viewTab.click()
  await expect(page.getByRole('button', { name: 'Refresh to latest', exact: true })).toBeVisible()
  await expect(entry).toBeDisabled()
  await expect(page.getByText('Example only. No positions are minted.', { exact: true })).toHaveCount(0)
  releasePinned()
  const refresh = page.getByRole('button', { name: 'Refresh to latest', exact: true })
  await expect(refresh).toBeEnabled()
  await expect(entry).toBeDisabled()
  await refresh.click()
  await expect(mean).toHaveValue('3.25')
  await expect(page.getByText('Entry is closed.', { exact: true })).toHaveCount(0)
  releaseLatest()
  // The stage moved to results: the market tab stays open, the checkout folds away and keeps the draft.
  await expect(page.locator('.ticket')).toBeHidden()
  const hiddenMean = page.locator('input[aria-label="Mean (%)"]')
  await expect(viewTab).toHaveAttribute('aria-selected', 'true')
  await expect(lamps.nth(2)).toHaveAttribute('aria-current', 'step')
  await expect(refresh).toHaveCount(0)
  await expect(hiddenMean).toHaveValue('3.25')
  await expect(page.locator('.ticket button.primary')).toBeDisabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
