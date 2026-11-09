import { projectNumber, readMarketAt } from '@/lib/defifa'
import { readActivity } from '@/lib/activity'
import { chainForId, publicClientForChain } from '@/lib/wallet'
import { assertChain } from '@/lib/defifa-deployment'

export async function GET(request: Request, { params }: { params: Promise<{ chainId: string; projectId: string }> }) {
  const { chainId, projectId } = await params
  const query = new URL(request.url).searchParams
  const blockNumber = query.get('blockNumber')
  const cursor = query.get('cursor')
  const headers = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }
  try {
    if (!/^\d{1,10}$/.test(chainId)) throw new Error('This network is not supported.')
    chainForId(Number(chainId))
    projectNumber(projectId)
    if (blockNumber !== null && !/^\d{1,78}$/.test(blockNumber)) throw new Error('The snapshot block is invalid.')
    if (cursor !== null && !/^\d{1,10}$/.test(cursor)) throw new Error('The activity cursor is invalid.')
  } catch (cause) {
    return Response.json({ error: cause instanceof Error ? cause.message : 'Invalid activity request.' }, { status: 400, headers })
  }
  try {
    const client = publicClientForChain(Number(chainId))
    await assertChain(client, Number(chainId))
    const block = await client.getBlock(blockNumber === null ? undefined : { blockNumber: BigInt(blockNumber) })
    const market = await readMarketAt(client, Number(chainId), projectId, block.number, Number(block.timestamp))
    return Response.json(await readActivity(market, cursor === null ? undefined : Number(cursor)), { headers })
  } catch {
    return Response.json({ error: 'Activity could not be read. Try again.' }, { status: 503, headers })
  }
}
