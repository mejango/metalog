import { expect, test, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { setTimeout as pause } from 'node:timers/promises'
import { concatHex, createPublicClient, createTestClient, createWalletClient, encodeEventTopics, http, numberToHex, type Address, type Hex } from 'viem'
import { baseSepolia } from 'viem/chains'
import { createHeldWriteStorage, createWriteHold, openStepHold, writeIntentKey, type WriteHoldClient } from '@bananapus/nana-sdk-core/review'
import DEFIFA_ABI from '../../src/lib/defifa-abi.json' with { type: 'json' }
import deploymentPins from '../../src/lib/defifa-deployments.json' with { type: 'json' }

// Anvil's first default account, on a plain local chain with Base Sepolia's ID.
const account = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address
const call = { chainId: baseSepolia.id, to: '0x0000000000000000000000000000000000000Bad' as Address, data: '0x12345678' as Hex, value: 0n,
  intent: writeIntentKey('metalog-market', { chainId: baseSepolia.id, projectId: '1' }), label: 'Enter market' }

async function startAnvil() {
  const probe = createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = (probe.address() as { port: number }).port
  await new Promise(resolve => probe.close(resolve))
  const anvil = spawn(process.env.ANVIL_BIN || 'anvil', ['--quiet', '--host', '127.0.0.1', '--port', String(port), '--chain-id', String(baseSepolia.id), '--prune-history', '500'], { stdio: 'ignore' })
  const url = `http://127.0.0.1:${port}`
  const client = createPublicClient({ chain: baseSepolia, transport: http(url), cacheTime: 0 })
  for (let attempt = 0; ; attempt++) {
    try { await client.getChainId(); break } catch { if (attempt > 100) throw new Error('Anvil did not start.'); await pause(100) }
  }
  return {
    url, client,
    control: createTestClient({ chain: baseSepolia, mode: 'anvil', transport: http(url) }),
    wallet: createWalletClient({ account, chain: baseSepolia, transport: http(url) }),
    stop: () => { anvil.kill('SIGKILL') },
  }
}
type Anvil = Awaited<ReturnType<typeof startAnvil>>

/** A real SDK hold record for `call`, made in memory here and loaded into the page's storage, as a reload finds it. */
async function heldWrite(anvil: Anvil, held: typeof call, send: (gate: { beforeSend: () => Promise<unknown>; afterSubmit: (hash: Hex) => void }) => Promise<Hex>) {
  const memory = new Map<string, string>()
  const hold = createWriteHold({ storage: createHeldWriteStorage({ durable: () => undefined, memory }) })
  await openStepHold(hold, account, false, held).send(anvil.client as unknown as WriteHoldClient, send).catch(() => undefined)
  return Object.fromEntries(memory)
}

/** The account connected through an injected wallet; every app RPC read goes to the local chain. */
async function open(page: Page, anvil: Anvil, records: Record<string, string>) {
  await page.addInitScript(({ records, account, chainId }) => {
    if (!sessionStorage.getItem('seeded')) for (const [key, value] of Object.entries(records)) localStorage.setItem(key, value)
    sessionStorage.setItem('seeded', '1')
    const provider = {
      on() { return provider }, removeListener() { return provider },
      async request({ method }: { method: string }) {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account]
        if (method === 'eth_chainId') return `0x${chainId.toString(16)}`
        if (method === 'wallet_getPermissions' || method === 'wallet_requestPermissions') return [{ parentCapability: 'eth_accounts' }]
        if (method === 'wallet_getCapabilities') return {}
        throw new Error(`This test wallet cannot execute ${method}.`)
      },
    }
    Object.assign(window, { ethereum: provider })
  }, { records, account, chainId: baseSepolia.id })
  await page.route('**/*', async route => {
    const request = route.request()
    let body: unknown
    try { body = request.method() === 'POST' ? request.postDataJSON() : undefined } catch { /* not JSON */ }
    const calls = Array.isArray(body) ? body : [body]
    if (!body || !calls.every(item => item && typeof item === 'object' && 'jsonrpc' in item)) return route.continue()
    const response = await page.request.post(anvil.url, { data: body })
    return route.fulfill({ response, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } })
  })
  await page.goto('/create')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByRole('button', { name: 'Injected', exact: true }).click()
}

test.describe('held writes found after a reload', () => {
  let anvil: Anvil
  test.beforeEach(async () => { anvil = await startAnvil() })
  test.afterEach(() => anvil.stop())

  test('a write still confirming shows its notice until it mines', async ({ page }) => {
    await anvil.control.setAutomine(false)
    const records = await heldWrite(anvil, call, async gate => {
      await gate.beforeSend()
      const hash = await anvil.wallet.sendTransaction({ to: call.to, data: call.data, value: call.value })
      gate.afterSubmit(hash)
      return hash
    })
    await open(page, anvil, records)
    const notice = page.locator('[data-phase="confirming"]')
    await expect(notice).toBeVisible()
    await anvil.control.mine({ blocks: 1 })
    await expect(notice).toHaveCount(0, { timeout: 60_000 })
  })

  test('a write whose wallet reply was lost settles from the hash the wallet shows', async ({ page }) => {
    let lost: Hex | undefined
    const records = await heldWrite(anvil, call, async gate => {
      await gate.beforeSend()
      lost = await anvil.wallet.sendTransaction({ to: call.to, data: call.data, value: call.value })
      throw new Error('The wallet reply was lost after it mined.')
    })
    await open(page, anvil, records)
    const notice = page.locator('[data-phase="held"]')
    await expect(notice).toBeVisible()
    await page.getByLabel('Original transaction hash', { exact: true }).fill(lost!)
    await page.getByRole('button', { name: 'Check transaction', exact: true }).click()
    await expect(notice).toHaveCount(0)
    await expect(page.getByLabel('Original transaction hash', { exact: true })).toHaveCount(0)
  })

  test('a creation that mined while away opens its market and joins Recently opened', async ({ page }) => {
    // Defifa's deployer on this chain, standing in: every call emits one LaunchGame of game 42 by this account.
    const deployer = deploymentPins.chains['84532'].deployer as Address
    const [signature, ...indexed] = encodeEventTopics({ abi: DEFIFA_ABI.DefifaDeployer, eventName: 'LaunchGame',
      args: { gameId: 42n, hook: call.to, governor: call.to } }) as Hex[]
    const word = (value: Hex) => concatHex(['0x7f', value])
    await anvil.control.setCode({ address: deployer, bytecode: concatHex([
      '0x73', account, '0x602052', ...[...indexed].reverse().map(word), word(signature), '0x60406000a400',
    ]) })
    const creation = { ...call, to: deployer, intent: writeIntentKey('metalog-create', { chainId: baseSepolia.id, definition: numberToHex(1, { size: 32 }) }), label: 'Create market' }
    await anvil.control.setAutomine(false)
    const records = await heldWrite(anvil, creation, async gate => {
      await gate.beforeSend()
      const hash = await anvil.wallet.sendTransaction({ to: creation.to, data: creation.data, value: creation.value })
      gate.afterSubmit(hash)
      return hash
    })
    await anvil.control.mine({ blocks: 1 })
    await open(page, anvil, records)
    await expect(page.getByRole('link', { name: 'Open created market', exact: true })).toHaveAttribute('href', `/markets/${baseSepolia.id}/42`)
    expect(await page.evaluate(() => localStorage.getItem('metalog:recent-markets:v1'))).toContain('42')
  })
})
