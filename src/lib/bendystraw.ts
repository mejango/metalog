import { chainForId } from './wallet'

// Server-side only: the keyless route answers servers; browsers on other origins are refused by CORS.
const HOSTS = { mainnet: 'https://bendystraw.xyz/graphql', testnet: 'https://testnet.bendystraw.xyz/graphql' }

/** Bendystraw discovers; callers re-read anything it returns on chain before showing it as verified. */
export async function bendystraw<T>(chainId: number, query: string, variables: Record<string, unknown>): Promise<T> {
  const host = chainForId(chainId).testnet ? HOSTS.testnet : HOSTS.mainnet
  const response = await fetch(host, {
    method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json() as { data?: T; errors?: unknown[] }
  if (!response.ok || body.errors?.length || !body.data) throw new Error('The game index could not be read.')
  return body.data
}
