'use client'

import { useEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { MarketSnapshot } from '@/lib/defifa'
import type { ActivityEvent, ActivityPage } from '@/lib/activity'
import type { EntryHistoryEntry } from '@/lib/entries'
import { EntryDetail } from './EntryDetail'
import { chainForId } from '@/lib/wallet'
import { RangeStrip } from './RangeStrip'

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`
const ago = (seconds: number) => {
  const elapsed = Math.max(0, Date.now() / 1000 - seconds)
  return elapsed < 3_600 ? `${Math.max(1, Math.round(elapsed / 60))}m ago` : elapsed < 86_400 ? `${Math.round(elapsed / 3_600)}h ago` : `${Math.round(elapsed / 86_400)}d ago`
}

/** Entries and exits, newest first, read only once the panel is open. */
export function Activity({ market, active }: { market: MarketSnapshot; active: boolean }) {
  const explorer = chainForId(market.chainId).blockExplorers.default.url
  const query = useInfiniteQuery({
    queryKey: ['market-activity', market.chainId, market.projectId], enabled: active,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const blockNumber = market.blockNumber
      const params = new URLSearchParams({ blockNumber, ...(pageParam ? { cursor: pageParam } : {}) })
      const response = await fetch(`/api/markets/${market.chainId}/${market.projectId}/activity?${params}`, { signal })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Activity could not be read.')
      return { ...data as ActivityPage, blockNumber }
    },
    getNextPageParam: last => last.nextCursor ?? undefined, staleTime: Infinity, refetchOnWindowFocus: false,
  })
  const events = query.data?.pages.flatMap(page => page.events) ?? []
  const { hasNextPage, isFetching, fetchNextPage, refetch } = query
  // A newer snapshot rereads every loaded page at its block; the shown pages stay until the reread completes.
  const readAt = query.data?.pages[0]?.blockNumber
  useEffect(() => {
    if (active && readAt !== undefined && readAt !== market.blockNumber && !isFetching && !query.error) void refetch()
  }, [active, readAt, market.blockNumber, isFetching, query.error, refetch])
  // Keep reading back while the end of the list is near the screen.
  const end = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    if (!end.current) return
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: '600px 0px' })
    observer.observe(end.current)
    return () => observer.disconnect()
  }, [])
  // Only once the reread is done: a page fetch would cancel it.
  useEffect(() => {
    if (active && near && hasNextPage && readAt === market.blockNumber && !isFetching && !query.error) void fetchNextPage()
  }, [active, near, hasNextPage, readAt, market.blockNumber, isFetching, fetchNextPage, query.error])
  return <section aria-labelledby="activity-heading" className="activity">
    <h3 id="activity-heading">Activity</h3>
    {query.error && <p className="error" role="alert">{query.error.message} <button type="button" onClick={() => void (query.isFetchNextPageError ? fetchNextPage() : refetch())}>Retry</button></p>}
    <ol className="activity-feed">
      {events.map(event => <ActivityRow key={`${event.transactionHash}:${event.kind}`} event={event} market={market} explorer={explorer} />)}
    </ol>
    <div ref={end} />
    {active && isFetching && !events.length && <p className="hint" role="status">Reading activity…</p>}
    {query.data && !events.length && !query.hasNextPage && <p className="hint">No entries or exits yet.</p>}
  </section>
}

function ActivityRow({ event, market, explorer }: { event: ActivityEvent; market: MarketSnapshot; explorer: string }) {
  const [open, setOpen] = useState(false)
  const count = event.quantities.reduce((sum, quantity) => sum + quantity, 0)
  const line = <>
    <span className="activity-toggle" aria-hidden="true">{event.kind === 'entry' ? '▸' : ''}</span>
    <RangeStrip values={event.quantities} />
    <span><a href={`${explorer}/address/${event.account}`} target="_blank" rel="noreferrer">{short(event.account)}</a>
      {event.kind === 'entry' ? ' entered with ' : ' exited with '}<strong>{count}</strong> position{count === 1 ? '' : 's'}</span>
    <a className="activity-time" href={`${explorer}/tx/${event.transactionHash}`} target="_blank" rel="noreferrer">{ago(event.timestamp)}</a>
  </>
  if (event.kind === 'exit') return <li data-kind="exit"><div className="activity-line">{line}</div></li>
  return <li data-kind="entry"><details onToggle={element => setOpen(element.currentTarget.open)}>
    <summary className="activity-line">{line}</summary>
    {open && <EntryRecord event={event} market={market} explorer={explorer} />}
  </details></li>
}

/** Read only when a row is opened; the same checks as the entry history API. */
function EntryRecord({ event, market, explorer }: { event: ActivityEvent; market: MarketSnapshot; explorer: string }) {
  const query = useQuery({
    queryKey: ['market-entry', market.chainId, market.projectId, event.transactionHash],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ blockNumber: market.blockNumber, tx: event.transactionHash })
      const response = await fetch(`/api/markets/${market.chainId}/${market.projectId}/entries?${params}`, { signal })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Entry could not be verified.')
      return data.entry as EntryHistoryEntry
    }, staleTime: Infinity, refetchOnWindowFocus: false, retry: false,
  })
  if (query.isPending) return <p className="hint" role="status">Checking entry receipt…</p>
  if (query.error) return <div className="actions"><p className="error" role="alert">{query.error.message}</p><button type="button" onClick={() => void query.refetch()}>Retry</button></div>
  return <EntryDetail entry={query.data} market={market} explorer={explorer} />
}
