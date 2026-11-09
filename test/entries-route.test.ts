import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ readMarketAt: vi.fn(), readEntry: vi.fn(), assertChain: vi.fn(), getBlock: vi.fn() }))
vi.mock('../src/lib/defifa', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/defifa')>(), readMarketAt: mocks.readMarketAt }))
vi.mock('../src/lib/entries', () => ({ readEntry: mocks.readEntry }))
vi.mock('../src/lib/defifa-deployment', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/defifa-deployment')>(), assertChain: mocks.assertChain }))
vi.mock('../src/lib/wallet', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/wallet')>(), publicClientForChain: () => ({ getBlock: mocks.getBlock }) }))
import { marketRanges } from '../src/domain/market'
import { EXAMPLE_MARKET } from '../src/lib/example'
import { GET } from '../src/app/api/markets/[chainId]/[projectId]/entries/route'

const tx = `0x${'1'.repeat(64)}`
const get = (query = `?tx=${tx}`, chainId = '8453', projectId = '27') => GET(new Request(`https://metalog.money/api/markets/${chainId}/${projectId}/entries${query}`), { params: Promise.resolve({ chainId, projectId }) })

describe('entry evidence endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getBlock.mockResolvedValue({ number: 100n, timestamp: 500n, hash: '0xabc' })
    mocks.assertChain.mockResolvedValue(undefined)
    mocks.readMarketAt.mockResolvedValue({ blockNumber: '100', hook: '0x123', ranges: marketRanges(EXAMPLE_MARKET) })
  })
  it('pins the read to the snapshot block and renders density evidence only for authenticated records', async () => {
    const quantities = marketRanges(EXAMPLE_MARKET).map((_, i) => i === 10 ? 4 : 0)
    mocks.readEntry.mockResolvedValueOnce({ status: 'verified-manual', coefficients: [0, 1], quantities })
    const response = await get(`?tx=${tx}&blockNumber=100`)
    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(mocks.getBlock).toHaveBeenCalledWith({ blockNumber: 100n })
    expect(mocks.readEntry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ blockNumber: '100' }), tx)
    const { entry } = await response.json()
    expect(entry.chart.buckets).toHaveLength(600)
    expect(entry.chart.positions[10]).toMatchObject({ quantity: 4, share: 1 })
    mocks.readEntry.mockResolvedValueOnce({ status: 'unrecognized', coefficients: null, quantities })
    expect((await (await get()).json()).entry.chart).toBeNull()
  })
  it('preserves verified receipts when valid cutoffs exceed chart display precision', async () => {
    const ranges = [
      { tierId: 1, label: 'Lower tail', lower: null, upper: 100000000000 },
      { tierId: 2, label: 'Narrow', lower: 100000000000, upper: 100000000000.0001 },
      { tierId: 3, label: 'Upper tail', lower: 100000000000.0001, upper: null },
    ]
    mocks.readMarketAt.mockResolvedValueOnce({ blockNumber: '100', hook: '0x123', ranges })
    mocks.readEntry.mockResolvedValueOnce({ status: 'verified-curve', coefficients: [0, 1], quantities: [4, 0, 0] })
    expect((await (await get()).json()).entry).toMatchObject({ status: 'verified-curve', quantities: [4, 0, 0], chart: null, chartError: expect.stringContaining('chart precision') })
  })
  it('rejects a missing or malformed transaction and bad snapshots before RPC requests', async () => {
    for (const query of ['', '?tx=0x12', `?tx=${tx}&blockNumber=-1`, `?tx=${tx}&blockNumber=${2n ** 256n}`]) expect((await get(query)).status).toBe(400)
    expect((await get(undefined, '999')).status).toBe(400)
    expect((await get(undefined, '8453', '0')).status).toBe(400)
    expect(mocks.getBlock).not.toHaveBeenCalled()
  })
  it('reports provider failure without leaking credentials', async () => {
    mocks.readEntry.mockRejectedValueOnce(new Error('RPC https://private.example/secret unavailable'))
    const response = await get()
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Entry history could not be verified. Try again.' })
  })
})
