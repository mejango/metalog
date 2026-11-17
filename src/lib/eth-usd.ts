import { useQuery } from '@tanstack/react-query'

/** ETH/USD for display only. Amounts stay in ETH, so a failed read just leaves them in ETH. */
export function useEthUsd(): number | undefined {
  // ponytail: Coinbase spot, no fallback source; add one if display gaps matter.
  return useQuery({
    queryKey: ['eth-usd'],
    queryFn: async () => {
      const response = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot')
      if (!response.ok) throw Object.assign(new Error('ETH price unavailable'), { status: response.status })
      const price = Number((await response.json()).data.amount)
      if (!(price > 0)) throw new Error('ETH price unavailable')
      return price
    },
    staleTime: 60_000, refetchInterval: 60_000,
  }).data
}

/** Whole dollars from $1,000, cents from a cent, and three significant digits below a cent. */
export function usdText(value: number) {
  const digits = value >= 1000 ? { maximumFractionDigits: 0 } : value >= .01 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumSignificantDigits: 3 }
  return `$${value.toLocaleString('en-US', digits)}`
}
