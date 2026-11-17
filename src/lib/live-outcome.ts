import { useQuery } from '@tanstack/react-query'
import type { MarketDefinition } from '@/domain/market'
import { percentChange, presetProduct } from '@/domain/observation-presets'

const EXCHANGE = 'https://api.exchange.coinbase.com/products'

/** The open of the exact one-minute candle at a timestamp, as the preset rule reads it. */
async function candleOpen(product: string, at: number) {
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString()
  const response = await fetch(`${EXCHANGE}/${product}/candles?granularity=60&start=${iso(at)}&end=${iso(at + 60)}`)
  if (!response.ok) throw Object.assign(new Error('Candle unavailable'), { status: response.status })
  const candle = (await response.json() as number[][]).find(row => row[0] === at)
  if (!candle || !(candle[3] > 0)) throw new Error('Candle unavailable')
  return candle[3]
}

/**
 * A preset market's outcome by its own rule: the start candle's open against the latest trade while
 * observing, then against the end candle's open once observation ends (final). Display only; the
 * ratified result settles.
 */
export function useLiveOutcome(definition: MarketDefinition, mode: 'live' | 'final' | null): { value: number; final: boolean } | undefined {
  const product = presetProduct(definition.source)
  const { entryClosesAt: start, resolvesAt: end } = definition
  const enabled = mode !== null && product !== null
  // The chain's stage says whether observation has ended; the wall clock never decides it here.
  const ended = mode === 'final'
  const open = useQuery({ queryKey: ['candle-open', product, start], enabled, staleTime: Infinity, queryFn: () => candleOpen(product!, start) }).data
  const close = useQuery({ queryKey: ['candle-open', product, end], enabled: enabled && ended, staleTime: Infinity, queryFn: () => candleOpen(product!, end) }).data
  const price = useQuery({
    queryKey: ['ticker', product], enabled: enabled && !ended, refetchInterval: 30_000,
    queryFn: async () => {
      const response = await fetch(`${EXCHANGE}/${product}/ticker`)
      if (!response.ok) throw Object.assign(new Error('Price unavailable'), { status: response.status })
      const value = Number((await response.json()).price)
      if (!(value > 0)) throw new Error('Price unavailable')
      return value
    },
  }).data
  const latest = ended ? close : price
  return open && latest ? { value: percentChange(open, latest), final: ended } : undefined
}
