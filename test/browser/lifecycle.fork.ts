import { expect, test, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { parseEventLogs, zeroAddress, type Abi } from 'viem'
import type { LifecycleSnapshot } from '../../src/lib/defifa-lifecycle'
import DEFIFA_ABI from '../../src/lib/defifa-abi.json' with { type: 'json' }
import { injectForkWallet, startBrowserFork } from './lifecycle.harness'

test('the built website creates, enters, refunds, transfers, settles and claims on the native EVM', async ({ page }, testInfo) => {
  const environment = await startBrowserFork()
  const { fork, baseURL } = environment
  const wallet = await injectForkWallet(page, fork)
  const pageErrors: string[] = []
  const evidence: { action: string; hash: string; blockNumber: string }[] = []
  page.on('pageerror', error => pageErrors.push(error.message))

  async function capture(name: string) {
    const path = testInfo.outputPath(`${name}.png`)
    await page.screenshot({ path, fullPage: true })
    await testInfo.attach(name, { path, contentType: 'image/png' })
  }

  async function transact(button: ReturnType<Page['getByRole']>, action: string) {
    const before = wallet.transactions.length
    await expect(button).toBeEnabled()
    await button.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Base Sepolia', { exact: true })).toBeVisible()
    // Preparation ended at the hand-off; the transaction status card owns the line from here.
    expect(await page.getByText(/^Preparing (transaction|entry|market)…$/).count()).toBe(0)
    await dialog.getByRole('button', { name: 'Continue to wallet', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => wallet.transactions.length, { timeout: 90_000 }).toBe(before + 1)
    const hash = wallet.transactions[before]
    const receipt = await fork.client.waitForTransactionReceipt({ hash, timeout: 90_000 })
    expect(receipt.status).toBe('success')
    await expect(page.getByRole('complementary', { name: 'Transaction status' }).getByText('Transaction confirmed.', { exact: true })).toBeVisible({ timeout: 90_000 })
    evidence.push({ action, hash, blockNumber: String(receipt.blockNumber) })
    console.info(`${action}: ${hash} at local block ${receipt.blockNumber}`)
    return receipt
  }
  const nfts = () => page.getByRole('tabpanel', { name: 'Your positions', exact: true })
  // The tab count is the wallet's total ERC-1155 balance across ranges.
  const held = (count: number) => expect(page.getByRole('tab', { name: `Your position ${count}`, exact: true })).toBeVisible()
  const rangeLabel = (index: number) => nfts().locator('.inventory-table tbody tr').nth(index).locator('td').first()
  const tab = (id: 'market' | 'nfts' | 'results') => page.locator(`#tab-${id}`).click()
  // Refresh lives on the positions tab; return to the tab the step was using.
  async function refresh() {
    const current = await page.getByRole('tab', { selected: true }).getAttribute('id')
    await tab('nfts')
    const button = nfts().getByRole('button', { name: 'Refresh', exact: true })
    await expect(button).toBeEnabled()
    await button.click()
    await expect(button).toBeEnabled()
    await expect(nfts().getByText('Updating market and wallet positions…', { exact: true })).toBeHidden()
    await page.locator(`#${current}`).click()
  }
  async function snapshot(): Promise<LifecycleSnapshot> {
    const pathname = new URL(page.url()).pathname
    const response = await page.request.get(`${baseURL}/api${pathname}/play?account=${fork.accounts[0]}`)
    expect(response.ok(), await response.text()).toBe(true)
    return response.json()
  }
  async function createMarket(question: string) {
    await page.goto(`${baseURL}/create`)
    const start = Math.ceil((Number((await fork.client.getBlock()).timestamp) + 180) / 60) * 60
    const date = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 16)
    await page.getByLabel('Question', { exact: true }).fill(question)
    await page.getByLabel('Observation source', { exact: true }).fill('Local Anvil fork browser qualification; no public transaction.')
    await page.getByLabel('Entry opens (UTC)', { exact: true }).fill(date(start))
    await page.getByLabel('Entry closes / observation starts (UTC)', { exact: true }).fill(date(start + 600))
    await page.getByLabel('Observation ends (UTC)', { exact: true }).fill(date(start + 900))
    await page.getByLabel('Ranges', { exact: true }).fill('3')
    await page.getByLabel('Price per position (ETH)', { exact: true }).fill('0.001')
    await page.getByRole('combobox', { name: 'Network', exact: true }).selectOption('84532')
    const receipt = await transact(page.getByRole('button', { name: 'Review market', exact: true }), 'Create market')
    await expect(page).toHaveURL(/\/markets\/84532\/\d+$/)
    await expect(page.getByRole('heading', { level: 1, name: question, exact: true })).toBeVisible()
    expect(receipt.logs.length).toBeGreaterThan(0)
    return { start, close: start + 600, end: start + 900 }
  }
  async function enter(quantities: number[]) {
    await tab('market')
    await page.getByRole('button', { name: 'By range', exact: true }).click()
    const counts = page.getByRole('region', { name: 'Position counts', exact: true }).getByRole('textbox')
    await expect(counts).toHaveCount(3)
    for (let index = 0; index < quantities.length; index++) await counts.nth(index).fill(String(quantities[index]))
    const receipt = await transact(page.getByRole('button', { name: 'Review entry', exact: true }), 'Enter market')
    const minted = parseEventLogs({ abi: DEFIFA_ABI.DefifaHook as Abi, eventName: 'TransferSingle', logs: receipt.logs })
      .map(log => log.args as { from: string; value: bigint }).filter(args => args.from === zeroAddress)
      .concat(parseEventLogs({ abi: DEFIFA_ABI.DefifaHook as Abi, eventName: 'TransferBatch', logs: receipt.logs })
        .map(log => log.args as { from: string; values: bigint[] }).filter(args => args.from === zeroAddress)
        .map(args => ({ from: args.from, value: args.values.reduce((sum, value) => sum + value, 0n) })))
    expect(minted.reduce((sum, args) => sum + args.value, 0n)).toBe(BigInt(quantities.reduce((sum, count) => sum + count, 0)))
    return receipt
  }

  try {
    await page.goto(`${baseURL}/create`)
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await page.getByRole('button', { name: 'Local fork wallet', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible()
    const schedule = await createMarket('Browser qualification: percentage change?')
    expect(wallet.chainSwitches).toEqual([84532])
    await expect(page.getByRole('button', { name: 'Review entry', exact: true })).toBeDisabled()
    await fork.advanceTo(schedule.start + 1)
    await refresh()
    await enter([2, 2, 2])
    await held(6)
    await tab('nfts')
    const first = (await rangeLabel(0).textContent())!, third = (await rangeLabel(2).textContent())!

    await nfts().getByLabel(`Positions to burn in ${first}`, { exact: true }).fill('1')
    await transact(nfts().getByRole('button', { name: 'Review refund', exact: true }), 'Refund one position')
    await held(5)
    await expect(nfts().getByLabel(`Positions to burn in ${first}`, { exact: true })).toHaveValue('0')
    const afterRefund = await snapshot()
    expect(afterRefund.market.potWei).toBe('5000000000000000')
    expect(afterRefund.positions).toEqual([{ tierId: 1, count: 1 }, { tierId: 2, count: 2 }, { tierId: 3, count: 2 }])

    await nfts().getByLabel(`Actions for ${third}`, { exact: true }).click()
    await nfts().getByRole('menuitem', { name: 'Transfer', exact: true }).click()
    await page.getByLabel('Positions to send', { exact: true }).fill('1')
    await page.getByLabel('Transfer recipient', { exact: true }).fill(fork.accounts[1])
    await transact(nfts().getByRole('button', { name: 'Review transfer', exact: true }), 'Transfer position')
    await held(4)
    await wallet.select(fork.accounts[1])
    await held(1)
    await expect(rangeLabel(0)).toHaveText(third)
    await wallet.select(fork.accounts[0])
    await held(4)

    await fork.advanceTo(schedule.close + 2)
    await refresh()
    await expect(nfts().getByRole('button', { name: 'Review refund', exact: true })).toHaveCount(0)
    await tab('market')
    await expect(page.getByRole('button', { name: 'Review entry', exact: true })).toHaveCount(0)
    await tab('results')
    // With nothing proposed yet, the proposal form is already open.
    await expect(page.getByRole('textbox', { name: /^Proposed payout for/ }).first()).toBeVisible()
    const weights = page.getByRole('textbox', { name: /^Proposed payout for/ })
    for (const [index, value] of ['50', '30', '20'].entries()) await weights.nth(index).fill(value)
    await transact(page.getByRole('button', { name: 'Review result', exact: true }), 'Propose result')
    const proposal = (await snapshot()).scorecards[0]
    expect(proposal.stateName).toBe('Pending')
    const card = page.locator('details.scorecard').filter({ hasText: proposal.scorecardId })
    await card.locator('summary').first().click()
    const attest = card.getByRole('button', { name: `Attest result ${proposal.scorecardId}`, exact: true })
    const revoke = card.getByRole('button', { name: `Revoke attestation for result ${proposal.scorecardId}`, exact: true })
    const ratify = card.getByRole('button', { name: `Ratify result ${proposal.scorecardId}`, exact: true })
    await expect(attest).toBeDisabled()
    await fork.advanceTo(schedule.end + 2)
    await refresh()
    await transact(attest, 'Attest result')
    await expect(card.getByText('Attested', { exact: true })).toBeVisible()
    await transact(revoke, 'Revoke attestation')
    await expect(card.getByText('Not attested', { exact: true })).toBeVisible()
    await transact(attest, 'Reattest result')
    await wallet.select(fork.accounts[1])
    await held(1)
    await expect(card).toBeVisible()
    if (await card.getAttribute('open') === null) await card.locator('summary').first().click()
    await transact(attest, 'Recipient attests result')
    await wallet.select(fork.accounts[0])
    await held(4)
    if (await card.getAttribute('open') === null) await card.locator('summary').first().click()
    const queue = card.getByRole('button', { name: `Queue result ${proposal.scorecardId}`, exact: true })
    await expect(queue).toBeDisabled()
    const attested = await snapshot()
    expect(BigInt(attested.scorecards[0].attestationCount)).toBeGreaterThanOrEqual(BigInt(attested.scorecards[0].quorum))
    await fork.advanceTo(attested.scorecards[0].gracePeriodEnds + 2)
    await refresh()
    if (await card.getAttribute('open') === null) await card.locator('summary').first().click()
    await transact(queue, 'Queue result with the governor')
    const queued = (await snapshot()).scorecards[0]
    expect(queued).toMatchObject({ forwarded: true, stateName: 'Queued' })
    await expect(ratify).toBeDisabled()
    await fork.advanceTo(queued.ratifiableAt! + 2)
    await refresh()
    if (await card.getAttribute('open') === null) await card.locator('summary').first().click()
    await transact(ratify, 'Ratify result and fulfill commitments')
    await tab('nfts')
    await expect(page.getByRole('heading', { name: 'Claim payout', exact: true })).toBeVisible()
    await capture('owned-nfts-and-scorecard-desktop')
    await page.setViewportSize({ width: 390, height: 844 })
    await capture('owned-nfts-and-scorecard-mobile')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.setViewportSize({ width: 1280, height: 900 })
    await nfts().getByRole('button', { name: 'Select all', exact: true }).click()
    await transact(nfts().getByRole('button', { name: 'Review claim payout', exact: true }), 'Claim payout and burn positions')
    await expect(nfts().getByText('You do not hold any positions in this game.', { exact: true })).toBeVisible()
    const settled = await snapshot()
    expect(settled.market.ratifiedScorecardId).toBe(proposal.scorecardId)
    expect(settled.market.commitmentsFulfilled).toBe(true)
    expect(settled.positions).toEqual([])
    await capture('settled-market')

    const timeoutSchedule = await createMarket('Browser qualification: timeout and refund?')
    await fork.advanceTo(timeoutSchedule.start + 1)
    await refresh()
    await enter([1, 1, 1])
    await held(3)
    const timeout = await snapshot()
    await fork.advanceTo(timeout.noContestAfter + 1)
    await refresh()
    await tab('results')
    await page.locator('#panel-results summary', { hasText: /^No contest$/ }).click()
    await transact(page.getByRole('button', { name: 'Review no contest', exact: true }), 'Trigger native no contest')
    await fork.advanceTo(Number((await fork.client.getBlock()).timestamp) + 1)
    await refresh()
    await tab('nfts')
    await nfts().getByRole('button', { name: 'Select all', exact: true }).click()
    await transact(nfts().getByRole('button', { name: 'Review refund', exact: true }), 'Refund no-contest positions')
    await expect(nfts().getByText('You do not hold any positions in this game.', { exact: true })).toBeVisible()
    const refunded = await snapshot()
    expect(refunded.market.noContestTriggered).toBe(true)
    expect(refunded.market.potWei).toBe('0')
    expect(refunded.positions).toEqual([])
    expect(pageErrors).toEqual([])
  } finally {
    const path = testInfo.outputPath('local-fork-evidence.json')
    await writeFile(path, JSON.stringify({ chainId: fork.chainId, fork: fork.anchor, metadataPins: wallet.metadataPins, transactions: evidence, pageErrors, serverLog: environment.diagnostic() }, null, 2))
    await testInfo.attach('local-fork-evidence', { path, contentType: 'application/json' })
    await environment.stop()
  }
})
