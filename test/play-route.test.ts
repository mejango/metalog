import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ readLifecycle: vi.fn() }))
vi.mock('../src/lib/defifa-lifecycle', () => mocks)
import { GET } from '../src/app/api/markets/[chainId]/[projectId]/play/route'

const account = '0x1111111111111111111111111111111111111111'
const get = (query = '', chainId = '84532', projectId = '123') => GET(
  new Request(`https://metalog.test/api/markets/${chainId}/${projectId}/play${query}`),
  { params: Promise.resolve({ chainId, projectId }) },
)

describe('account lifecycle endpoint', () => {
  beforeEach(() => { mocks.readLifecycle.mockReset() })

  it('pins all continuation reads and disables caching wallet evidence', async () => {
    const evidence = { account, inventory: { tokens: [], complete: false, nextCursor: '400' } }
    mocks.readLifecycle.mockResolvedValue(evidence)
    const response = await get(`?account=${account}&blockNumber=1200&scorecardCursor=1000`)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toEqual(evidence)
    expect(mocks.readLifecycle).toHaveBeenCalledWith(84532, '123', account,
      { blockNumber: '1200', scorecardCursor: '1000' })
  })

  it('rejects malformed identifiers and unpinned pages before RPC reads', async () => {
    for (const query of ['?account=bad', '?scorecardCursor=0', '?blockNumber=-1', '?blockNumber=1e2', `?blockNumber=${2n ** 256n}`]) {
      expect((await get(query)).status).toBe(400)
    }
    expect((await get('', '123')).status).toBe(400)
    expect((await get('', '84532', '0')).status).toBe(400)
    expect(mocks.readLifecycle).not.toHaveBeenCalled()
  })

  it('reports unavailable evidence without turning it into zero holdings', async () => {
    mocks.readLifecycle.mockRejectedValue(new Error('HTTP failure at https://private.rpc/v2/secret-key'))
    const response = await get(`?account=${account}`)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Market data could not be verified. Try again.' })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})
