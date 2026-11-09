import { isAddress, type Address } from 'viem'
import { projectNumber, PUBLIC_MARKET_ERROR } from '@/lib/defifa'
import { readLifecycle } from '@/lib/defifa-lifecycle'
import { chainForId } from '@/lib/wallet'

/** Account evidence is private to this response; never cache a wallet's holdings. */
export async function GET(request: Request, { params }: { params: Promise<{ chainId: string; projectId: string }> }) {
  const { chainId, projectId } = await params
  const query = new URL(request.url).searchParams
  const account = query.get('account') || undefined
  const options: { blockNumber?: string; scorecardCursor?: string } = {}
  const headers = { 'Cache-Control': 'private, no-store' }
  try {
    if (!/^\d{1,10}$/.test(chainId)) throw new Error('This network is not supported.')
    chainForId(Number(chainId))
    projectNumber(projectId)
    if (account && !isAddress(account)) throw new Error('Enter a valid wallet address.')
    for (const key of ['blockNumber', 'scorecardCursor'] as const) {
      const value = query.get(key)
      if (value !== null) {
        if (!/^\d{1,78}$/.test(value) || BigInt(value) >= 2n ** 256n) throw new Error('The page cursor is invalid.')
        options[key] = value
      }
    }
    if (options.scorecardCursor && !options.blockNumber) {
      throw new Error('Pagination requires the original block number.')
    }
  } catch (cause) {
    return Response.json({ error: cause instanceof Error ? cause.message : 'Invalid market request.' }, { status: 400, headers })
  }
  try {
    return Response.json(await readLifecycle(Number(chainId), projectId, account as Address | undefined, options), { headers })
  } catch {
    return Response.json({ error: PUBLIC_MARKET_ERROR }, { status: 503, headers })
  }
}
