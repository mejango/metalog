'use client'

import { formatEther } from 'viem'
import type { MarketSnapshot } from '@/lib/defifa'
import type { EntryHistoryEntry } from '@/lib/entries'
import { downloadJson } from '@/lib/forecast'
import { PositionChart } from './PositionChart'

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

/** The checked record of one entry: submitted curve over minted positions, amount and receipt. */
export function EntryDetail({ entry, market, explorer }: { entry: EntryHistoryEntry; market: MarketSnapshot; explorer: string }) {
  const recognized = entry.status === 'verified-curve' || entry.status === 'verified-manual'
  const label = entry.status === 'verified-curve' ? 'Curve entry' : entry.status === 'verified-manual' ? 'By range entry' : 'Curve unavailable'
  return <div className="entry-detail">
    {recognized && entry.coefficients
      ? <PositionChart ranges={market.ranges} quantities={entry.quantities} coefficients={entry.coefficients} submitted reference={entry.status === 'verified-manual'} />
      : <p className="hint">{entry.reason || 'This transaction has no supported Metalog curve record.'}</p>}
    <p className="entry-label">{label}, {entry.stakeWei === null ? 'amount unavailable' : `${formatEther(BigInt(entry.stakeWei))} ETH`}
      {entry.beneficiary === null ? ', multiple recipients' : entry.beneficiary.toLowerCase() !== entry.account.toLowerCase() ? `, for ${short(entry.beneficiary)}` : ''}</p>
    <div className="actions">
      <a href={`${explorer}/tx/${entry.transactionHash}`} target="_blank" rel="noreferrer">View mint receipt</a>
      <button type="button" className="quiet" onClick={() => downloadJson(entry, `metalog-entry-${entry.transactionHash}.json`)}>Download entry JSON</button>
    </div>
    <details><summary>Raw record</summary>
      {entry.coefficients && <p className="entry-coefficients">a-coefficients: <code>{JSON.stringify(entry.coefficients)}</code></p>}
    </details>
  </div>
}
