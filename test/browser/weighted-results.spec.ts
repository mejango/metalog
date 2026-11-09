import { expect, test } from '@playwright/test'
import type { LifecycleSnapshot } from '../../src/lib/defifa-lifecycle'
import { EXAMPLE_MARKET } from '../../src/lib/example'
import { marketRanges, validateMarket } from '../../src/domain/market'

const account = '0x1111111111111111111111111111111111111111'
const definition = validateMarket({ ...EXAMPLE_MARKET, rangeCount: 3, rangeWidth: 1, rangeBoundaries: undefined })
const snapshot: LifecycleSnapshot = {
  market: { chainId: 8453, projectId: '27', hook: account, governor: account, referee: account, definition, ranges: marketRanges(definition),
    phase: 3, stage: 'settlement', blockNumber: '100', blockTimestamp: definition.resolvesAt + 1, potWei: '4000000000000',
    tiers: [1, 2, 3].map(tierId => ({ tierId, supply: '2', entrySupply: '2', priceWei: definition.unitPriceWei, remainingSupply: '999999999' })),
    ratifiedScorecardId: null, ratifiedWeights: null, cashOutWeightTotal: '1000000000000000000', commitmentsFulfilled: false, noContestTriggered: false },
  account, positions: [], delegates: [],
  scorecards: [{ scorecardId: '7', weights: [{ tierId: 1, weight: '600000000000000000' }, { tierId: 2, weight: '400000000000000000' }],
    submitter: account, state: 3, stateName: 'Succeeded', submittedAt: definition.resolvesAt + 1, attestationsBegin: definition.resolvesAt + 2,
    gracePeriodEnds: definition.resolvesAt + 3, attestationCount: '10', quorum: '10', accountWeight: '10', hasAttested: true, forwarded: true, ratifiableAt: null, canAttest: false, canRevoke: false, canForward: false, canRatify: true }],
  scorecardsNextCursor: null, scorecardsComplete: true, attestationGraceSeconds: 86400, timelockSeconds: 3600,
  noContestAfter: definition.resolvesAt + 1000000, canSubmitScorecard: true, canDelegate: false, canFulfill: false, canTriggerNoContest: false, cashOutMode: null,
}

test('weighted results are the default, preserve drafts across views and require exactly 100%', async ({ page }, testInfo) => {
  const writes: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && /eth_send|wallet_send/.test(request.postData() ?? '')) writes.push(request.url())
  })
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
  await page.route('**/api/markets/8453/27/play?*', route => route.fulfill({ json: snapshot }))
  await page.goto('/markets/8453/27')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByRole('button', { name: 'Injected', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible()
  await page.getByText('Propose a result', { exact: true }).click()
  const editor = page.locator('details').filter({ has: page.locator('summary', { hasText: 'Propose a result' }) })
  const weighted = editor.getByRole('button', { name: 'Weighted', exact: true })
  const one = editor.getByRole('button', { name: 'One range', exact: true })
  await expect(weighted).toHaveAttribute('aria-pressed', 'true')
  await expect(editor.getByRole('combobox', { name: 'Propose one range', exact: true })).toHaveCount(0)
  await expect(editor.getByText('They must total exactly 100%.', { exact: false })).toBeVisible()
  const inputs = editor.getByRole('textbox', { name: /^Proposed payout for/ })
  await expect(inputs).toHaveCount(3)
  await inputs.nth(0).fill('60')
  await inputs.nth(1).fill('40')
  const review = editor.getByRole('button', { name: 'Review result', exact: true })
  await expect(review).toBeEnabled()
  const summary = editor.getByRole('table', { name: 'Proposed payout summary', exact: true })
  await expect(summary.getByRole('row')).toHaveCount(3)
  await expect(summary.getByRole('row').nth(1)).toHaveText(`${snapshot.market.ranges[0].label}60%`)
  await expect(summary.getByRole('row').nth(2)).toHaveText(`${snapshot.market.ranges[1].label}40%`)
  await one.click()
  await expect(one).toHaveAttribute('aria-pressed', 'true')
  const rangeSelect = editor.getByRole('combobox', { name: 'Propose one range', exact: true })
  await rangeSelect.focus()
  await expect(rangeSelect).toBeFocused()
  await expect(rangeSelect).toHaveCSS('outline-style', 'solid')
  await expect(rangeSelect).toHaveCSS('padding-right', '36px')
  await expect(rangeSelect).toHaveCSS('background-size', '12px')
  await expect(rangeSelect).toHaveCSS('background-position', 'calc(100% - 12px) 50%')
  const geometry = await rangeSelect.evaluate(select => {
    const context = document.createElement('canvas').getContext('2d')!
    context.font = getComputedStyle(select).font
    return {
      width: select.getBoundingClientRect().width,
      textWidth: Math.max(...Array.from((select as HTMLSelectElement).options, option => context.measureText(option.text).width)),
      available: select.parentElement!.getBoundingClientRect().width,
    }
  })
  expect(geometry.width).toBeGreaterThanOrEqual(geometry.textWidth + 48)
  expect(geometry.width).toBeLessThanOrEqual(geometry.textWidth + 60)
  expect(geometry.width).toBeLessThan(geometry.available)
  await editor.screenshot({ path: testInfo.outputPath('compact-result-select.png') })
  await expect(inputs).toHaveCount(0)
  await expect(summary.getByRole('row').nth(1)).toContainText('60%')
  await weighted.click()
  await expect(inputs.nth(0)).toHaveValue('60')
  await expect(inputs.nth(1)).toHaveValue('40')
  await inputs.nth(1).fill('39')
  await expect(editor.getByRole('alert')).toHaveText('Result percentages must add to exactly 100%.')
  await expect(review).toBeDisabled()
  await expect(summary).toHaveCount(0)
  await one.click()
  await editor.getByRole('combobox', { name: 'Propose one range', exact: true }).selectOption('3')
  await expect(review).toBeEnabled()
  await expect(summary.getByRole('row')).toHaveCount(2)
  await expect(summary.getByRole('row').nth(1)).toHaveText(`${snapshot.market.ranges[2].label}100%`)
  await weighted.click()
  await expect(inputs.nth(0)).toHaveValue('0')
  await expect(inputs.nth(1)).toHaveValue('0')
  await expect(inputs.nth(2)).toHaveValue('100')
  await page.locator('.scorecard > summary').click()
  const proposed = page.locator('.scorecard')
  await expect(proposed.getByRole('row').nth(1)).toHaveText(`${snapshot.market.ranges[0].label}60%`)
  await expect(proposed.getByRole('row').nth(2)).toHaveText(`${snapshot.market.ranges[1].label}40%`)
  await expect(proposed.getByRole('button', { name: 'Ratify result 7', exact: true })).toBeEnabled()
  expect(writes).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
