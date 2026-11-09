'use client'

import { Fragment, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatEther, formatUnits, getAddress, isAddress } from 'viem'
import { MAX_POSITIONS } from '@/domain/allocation'
import { scorecardWeightsFromPercentages } from '@/domain/scorecard'
import type { LifecycleAction, LifecycleSnapshot, ResultVoters } from '@/lib/defifa-lifecycle'
import { chainForId } from '@/lib/wallet'
import { useWallet } from '@/providers/Providers'
import { usePreparedWrite, useTransactions } from '@/providers/Transactions'
import { utcTime } from './MarketFacts'
import { RangeStrip } from './RangeStrip'
import { useLiveOutcome } from '@/lib/live-outcome'
import { binForOutcome, formatPercentage } from '@/domain/ranges'

export function MarketLifecycle({ lifecycle, panel, current, loading, error, onRefresh, onPage, scorecardsPaged }: {
  lifecycle: LifecycleSnapshot
  /** Both panels stay mounted so selections and result drafts survive switching. */
  panel: 'nfts' | 'results' | null
  current: boolean
  loading: boolean
  error?: string
  onRefresh: () => void
  onPage: (cursor?: string) => void
  scorecardsPaged: boolean
}) {
  const { address, isSigna, connect } = useWallet()
  const transactions = useTransactions()
  const { market, positions } = lifecycle
  // Positions to burn per range, per wallet.
  const [selections, setSelections] = useState<Record<string, Record<number, number>>>({})
  const [recipient, setRecipient] = useState('')
  const [sendCount, setSendCount] = useState('')
  const [delegatee, setDelegatee] = useState('')
  // One range's menu action open inline beneath its row.
  const [rowAction, setRowAction] = useState<{ tierId: number; kind: 'menu' | 'transfer' | 'delegate' } | null>(null)
  const [percentages, setPercentages] = useState(() => market.ranges.map(() => '0'))
  const [resultView, setResultView] = useState<'weighted' | 'one-range'>('weighted')
  const [scoreTouched, setScoreTouched] = useState(false)
  // Preset markets can read their own result once observation ends; proposing it is one click.
  const observed = useLiveOutcome(market.definition, market.stage === 'settlement' ? 'final' : null)
  const observedRange = observed?.final ? binForOutcome(market.ranges, observed.value) : null
  const { preparing, error: actionError, run } = usePreparedWrite()
  const walletKey = address?.toLowerCase() ?? ''
  const selected = selections[walletKey] ?? {}
  const burning = positions.flatMap(position => {
    const count = Math.min(selected[position.tierId] ?? 0, position.count, MAX_POSITIONS)
    return count > 0 ? [{ tierId: position.tierId, count }] : []
  })
  const burnCount = burning.reduce((sum, position) => sum + position.count, 0)
  const matchingWallet = !!address && lifecycle.account?.toLowerCase() === walletKey
  const busy = preparing || transactions.busy || transactions.hasPendingForMarket(market)
  const canAct = current && matchingWallet && !isSigna && !busy
  const explorer = chainForId(market.chainId).blockExplorers.default.url
  const scoreDraft = useMemo(() => {
    try { return { weights: scorecardWeightsFromPercentages(market.ranges, percentages), error: null } }
    catch (cause) { return { weights: null, error: cause instanceof Error ? cause.message : 'Check the proposed percentages.' } }
  }, [market.ranges, percentages])
  const quote = useQuery({
    queryKey: ['cash-out-quote', market.chainId, market.projectId, market.blockNumber, walletKey, JSON.stringify(burning)],
    queryFn: async () => {
      const { readCashOutQuote } = await import('@/lib/defifa-lifecycle')
      return readCashOutQuote(market, burning, address!)
    },
    enabled: current && matchingWallet && !!lifecycle.cashOutMode && burning.length > 0,
    retry: false, staleTime: 0,
  })
  const quoteReady = current && matchingWallet && !!quote.data && !quote.isFetching && !quote.error
  const cashOutLabel = lifecycle.cashOutMode === 'cash-out' ? 'Claim payout' : 'Refund'

  function select(next: Record<number, number>) {
    setSelections(previous => ({ ...previous, [walletKey]: next }))
  }
  async function act(action: LifecycleAction) {
    if (!canAct || !address) return
    await run(async () => (await import('@/lib/defifa-lifecycle')).prepareLifecycleAction(market, action, address),
      prepared => transactions.executeMarket(prepared, market), () => {
        setRowAction(null)
        if (action.kind === 'transfer' || action.kind === 'cash-out') select({})
        onRefresh()
      }, 'The transaction could not be prepared.')
  }

  const propose = <>
      <details open={lifecycle.scorecards.length === 0 && lifecycle.canSubmitScorecard}><summary>Propose a result</summary>
        {observedRange && <div className="actions"><button type="button" onClick={() => {
          setPercentages(market.ranges.map(range => range.tierId === observedRange.tierId ? '100' : '0')); setResultView('weighted'); setScoreTouched(true)
        }}>Use the observed result: {formatPercentage(observed!.value, 2)}, {observedRange.label}</button></div>}
        <div className="mode-toggle" role="group" aria-label="Result payout controls">
          <button type="button" aria-pressed={resultView === 'weighted'} onClick={() => setResultView('weighted')}>Weighted</button>
          <button type="button" aria-pressed={resultView === 'one-range'} onClick={() => setResultView('one-range')}>One range</button>
        </div>
        <p className="hint">Assign payout percentages across ranges. They must total exactly 100%. Holders still decide whether to ratify the result.</p>
        {resultView === 'one-range' ? <><label className="field"><span>Propose one range</span><select className="result-range-select" value="" onChange={event => {
          if (!event.target.value) return
          setPercentages(market.ranges.map(range => String(range.tierId) === event.target.value ? '100' : '0'))
          setScoreTouched(true)
        }}><option value="">Choose a range to assign 100%</option>
          {market.ranges.filter(range => BigInt(market.tiers.find(tier => tier.tierId === range.tierId)?.supply ?? '0') > 0n).map(range => <option key={range.tierId} value={range.tierId}>{range.label}</option>)}
        </select></label><p className="hint">Choosing a range replaces the draft with 100% for that range. Switching views keeps your draft.</p></>
        : <div className="payout-editor">
          {market.ranges.map((range, index) => <label key={range.tierId}><input className="quantity-input" inputMode="decimal" aria-label={`Proposed payout for ${range.label} (%)`}
            value={percentages[index]} onChange={event => { setPercentages(previous => previous.map((value, i) => i === index ? event.target.value : value)); setScoreTouched(true) }} />
            <span className="hint">%</span><span>{range.label}</span></label>)}
        </div>}
        {scoreDraft.weights && <div className="table-wrap"><table aria-label="Proposed payout summary"><thead><tr><th>Range</th><th>Proposed payout</th></tr></thead><tbody>
          {scoreDraft.weights.map(item => <tr key={item.tierId}><td>{market.ranges.find(range => range.tierId === item.tierId)?.label}</td><td>{formatUnits(BigInt(item.weight), 16)}%</td></tr>)}
        </tbody></table></div>}
        {scoreTouched && scoreDraft.error && <p className="error" role="alert">{scoreDraft.error}</p>}
        {matchingWallet && !lifecycle.canSubmitScorecard && <p className="hint">Result proposals are unavailable in this phase.</p>}
        <div className="actions"><button type="button" disabled={!canAct || !lifecycle.canSubmitScorecard || !scoreDraft.weights}
          onClick={() => scoreDraft.weights && void act({ kind: 'submit-scorecard', weights: scoreDraft.weights })}>Review result</button></div>
      </details>
  </>
  return <>
    <section role="tabpanel" id="panel-nfts" aria-labelledby="your-nfts" hidden={panel !== 'nfts'}>
      <div className="row"><h2 id="your-nfts">Your positions</h2><button type="button" disabled={loading || busy} onClick={onRefresh}>Refresh</button></div>
      {loading && <p className="hint" role="status">Updating market and wallet positions…</p>}
      {error && <p className="error" role="alert">{error} Showing the last available market data. Refresh to enable actions.</p>}
      {preparing && <p role="status">Preparing transaction…</p>}
      {actionError && <p className="error" role="alert">{actionError}</p>}
      {!address ? <button type="button" onClick={() => connect()}>Connect to view your positions</button>
        : !matchingWallet ? <p role="status">{error ? 'Positions for this wallet are unavailable.' : 'Loading positions for this wallet…'}</p>
          : <>
            {positions.length === 0 ? <p>You do not hold any positions in this game.</p>
              : <div className="table-wrap"><table className="inventory-table"><thead><tr><th>Range</th><th>Held</th>
                {lifecycle.cashOutMode && <th>{cashOutLabel}</th>}<th><span className="sr-only">Actions</span></th></tr></thead><tbody>
                {positions.map(position => { const label = market.ranges.find(range => range.tierId === position.tierId)!.label; return <Fragment key={position.tierId}><tr>
                  <td>{label}</td><td>{position.count}</td>
                  {lifecycle.cashOutMode && <td><input type="number" inputMode="numeric" min={0} max={Math.min(position.count, MAX_POSITIONS)} step={1}
                    aria-label={`Positions to burn in ${label}`} value={selected[position.tierId] ?? 0} disabled={!current || busy}
                    onChange={event => select({ ...selected, [position.tierId]: Math.max(0, Math.min(Math.floor(Number(event.target.value) || 0), position.count, MAX_POSITIONS)) })} /></td>}
                  <td className="row-menu-cell"><button type="button" className="row-menu" aria-label={`Actions for ${label}`}
                    aria-expanded={rowAction?.tierId === position.tierId}
                    onClick={() => setRowAction(rowAction?.tierId === position.tierId ? null : { tierId: position.tierId, kind: 'menu' })}>⋯</button></td>
                </tr>
                {rowAction?.tierId === position.tierId && <tr className="row-action"><td colSpan={lifecycle.cashOutMode ? 4 : 3}>
                  {rowAction.kind === 'menu' ? <div role="menu" aria-label={`Actions for ${label}`} className="actions">
                    <button type="button" role="menuitem" onClick={() => { setRowAction({ tierId: position.tierId, kind: 'transfer' }); setRecipient(''); setSendCount(String(position.count)) }}>Transfer</button>
                    <button type="button" role="menuitem" onClick={() => setRowAction({ tierId: position.tierId, kind: 'delegate' })}>Delegate votes</button>
                  </div> : rowAction.kind === 'transfer' ? <>
                    <p className="hint">Ownership and payout rights of these positions move to the recipient.</p>
                    <label className="field"><span>Positions to send</span><input type="number" inputMode="numeric" min={1} max={Math.min(position.count, MAX_POSITIONS)} step={1}
                      value={sendCount} onChange={event => setSendCount(event.target.value)} /></label>
                    <label className="field"><span>Transfer recipient</span><input value={recipient} spellCheck={false} autoComplete="off" placeholder="0x…" onChange={event => setRecipient(event.target.value)} /></label>
                    <div className="actions">
                      <button type="button" disabled={!canAct || !isAddress(recipient) || !/^[1-9]\d*$/.test(sendCount) || Number(sendCount) > Math.min(position.count, MAX_POSITIONS)}
                        onClick={() => void act({ kind: 'transfer', tierId: position.tierId, count: Number(sendCount), to: getAddress(recipient) })}>Review transfer</button>
                      <button type="button" onClick={() => setRowAction(null)}>Cancel</button>
                    </div>
                  </> : <>
                    <p className="hint">Delegation applies to every position you hold in {label}.
                      {!lifecycle.canDelegate && ' It can change only while entry is open.'}</p>
                    {lifecycle.delegates.some(item => item.tierId === position.tierId) && <p className="hint">Current delegate <code>{lifecycle.delegates.find(item => item.tierId === position.tierId)!.delegate}</code></p>}
                    <label className="field"><span>Voting delegate</span><input value={delegatee} spellCheck={false} autoComplete="off" placeholder="0x…" onChange={event => setDelegatee(event.target.value)} /></label>
                    <div className="actions">
                      {address && <button type="button" onClick={() => setDelegatee(address)}>Use my wallet</button>}
                      <button type="button" disabled={!canAct || !lifecycle.canDelegate || !isAddress(delegatee)}
                        onClick={() => void act({ kind: 'delegate', tierIds: [position.tierId], delegatee: getAddress(delegatee) })}>Review delegation</button>
                      <button type="button" onClick={() => setRowAction(null)}>Cancel</button>
                    </div>
                  </>}
                </td></tr>}
                </Fragment> })}
              </tbody></table></div>}
            {lifecycle.cashOutMode && positions.length > 0 && <div className="actions">
              <button type="button" disabled={!current || busy} onClick={() => select(Object.fromEntries(positions.map(position => [position.tierId, Math.min(position.count, MAX_POSITIONS)])))}>Select all</button>
              {burnCount > 0 && <button type="button" disabled={busy} onClick={() => select({})}>Clear selection ({burnCount})</button>}
            </div>}
          </>}
      {isSigna && <p className="hint">Use an external wallet for game transactions. <button type="button" onClick={() => connect({ externalOnly: true })}>Use external wallet</button></p>}
      {lifecycle.cashOutMode && <div className="section">
        <h3>{cashOutLabel}</h3>
        <p className="hint">Choose how many positions to burn in each range. {lifecycle.cashOutMode === 'cash-out' ? 'The ratified result determines their payout.' : 'Refunding returns their available value.'}</p>
        {burnCount > 0 && matchingWallet && <>
          {quote.isFetching && <p role="status">Checking the selected positions and payout…</p>}
          {quote.error && <p className="error" role="alert">{quote.error.message}</p>}
          {quoteReady && quote.data && <dl className="facts">
            <dt>Positions burned</dt><dd>{burnCount}</dd>
            <dt>Minimum ETH received</dt><dd>{formatEther(BigInt(quote.data.reclaimWei))} ETH</dd>
            {BigInt(quote.data.defifaTokenWei) > 0n && <><dt>Defifa token reward</dt><dd>{formatEther(BigInt(quote.data.defifaTokenWei))} <a href={`${explorer}/token/${quote.data.defifaToken}`} target="_blank" rel="noreferrer">View token</a></dd></>}
            {BigInt(quote.data.baseProtocolTokenWei) > 0n && <><dt>Protocol token reward</dt><dd>{formatEther(BigInt(quote.data.baseProtocolTokenWei))} <a href={`${explorer}/token/${quote.data.baseProtocolToken}`} target="_blank" rel="noreferrer">View token</a></dd></>}
            <dt>Quote block</dt><dd>{quote.data.blockNumber}</dd>
          </dl>}
        </>}
        <div className="actions"><button type="button" disabled={!canAct || !quoteReady || !quote.data || burnCount === 0}
          onClick={() => quote.data && void act({ kind: 'cash-out', positions: burning, minReclaimedWei: quote.data.reclaimWei })}>Review {cashOutLabel.toLowerCase()}</button></div>
      </div>}
    </section>
    <section role="tabpanel" id="panel-results" aria-labelledby="scorecards" hidden={panel !== 'results'}>
      <h2 id="scorecards">Results</h2>
      <p className="hint">The ratified result controls payouts. Attestation grace is {duration(lifecycle.attestationGraceSeconds)}; the ratification timelock is {duration(lifecycle.timelockSeconds)}.</p>
      {/* With nothing proposed yet, proposing is the job; reading older blocks comes after. */}
      {lifecycle.scorecards.length === 0 && propose}
      {lifecycle.scorecards.length === 0 && <p>{lifecycle.scorecardsComplete ? 'No results have been proposed.' : 'No results proposed in recent blocks.'}</p>}
      {lifecycle.scorecards.map(card => <details key={card.scorecardId} className="scorecard">
        <summary><RangeStrip values={market.ranges.map(range => Number(card.weights.find(item => item.tierId === range.tierId)?.weight ?? 0))} />Result <code title={card.scorecardId}>{shortId(card.scorecardId)}</code> | {card.stateName}</summary>
        <dl className="facts">
          <dt>Result ID</dt><dd><code>{card.scorecardId}</code></dd>
          <dt>Submitted</dt><dd>{utcTime(card.submittedAt)}</dd>
          <dt>Proposed by</dt><dd><code>{card.submitter}</code></dd>
          <dt>Attestations begin</dt><dd>{utcTime(card.attestationsBegin)}</dd>
          <dt>Grace ends</dt><dd>{utcTime(card.gracePeriodEnds)}</dd>
          <dt>Attestations</dt><dd>{BigInt(card.attestationCount).toLocaleString('en-US')} of {BigInt(card.quorum).toLocaleString('en-US')} needed{BigInt(card.attestationCount) >= BigInt(card.quorum) ? ', quorum met' : ''}</dd>
          {matchingWallet && card.accountWeight !== null && <><dt>Your voting weight</dt><dd>{BigInt(card.accountWeight).toLocaleString('en-US')}</dd></>}
          {matchingWallet && <><dt>Your attestation</dt><dd>{card.hasAttested ? 'Attested' : 'Not attested'}</dd></>}
        </dl>
        {matchingWallet && card.accountWeight === '0' && <p className="hint">This wallet has no voting weight for this proposal. Weight uses balances and delegation before submission and discounts payout ranges.</p>}
        <div className="table-wrap"><table><thead><tr><th>Range</th><th>Proposed payout</th></tr></thead><tbody>
          {card.weights.filter(item => BigInt(item.weight) > 0n).map(item => <tr key={item.tierId}><td>{market.ranges.find(range => range.tierId === item.tierId)?.label}</td><td>{formatUnits(BigInt(item.weight), 16)}%</td></tr>)}
        </tbody></table></div>
        <div className="actions">
          <button type="button" aria-label={`Attest result ${card.scorecardId}`} disabled={!canAct || !card.canAttest}
            onClick={() => void act({ kind: 'attest', scorecardId: card.scorecardId })}>Attest</button>
          <button type="button" aria-label={`Revoke attestation for result ${card.scorecardId}`} disabled={!canAct || !card.canRevoke}
            onClick={() => void act({ kind: 'revoke', scorecardId: card.scorecardId })}>Revoke attestation</button>
          {card.forwarded ? <button type="button" aria-label={`Ratify result ${card.scorecardId}`} disabled={!canAct || !card.canRatify}
            onClick={() => void act({ kind: 'ratify', weights: card.weights })}>Ratify</button>
            : <button type="button" aria-label={`Queue result ${card.scorecardId}`} disabled={!canAct || !card.canForward}
              onClick={() => void act({ kind: 'forward', weights: card.weights })}>Queue for ratification</button>}
        </div>
        {ratifyNote(card, lifecycle.timelockSeconds) && <p className="hint">{ratifyNote(card, lifecycle.timelockSeconds)}</p>}
        {card.state !== 5 && <VoterList market={market} card={card} />}
      </details>)}
      <div className="actions">
        {scorecardsPaged && <button type="button" disabled={loading || busy} onClick={() => onPage()}>First results</button>}
        {lifecycle.scorecardsNextCursor && <button type="button" disabled={loading || busy} onClick={() => onPage(lifecycle.scorecardsNextCursor!)}>Load more results</button>}
      </div>
      {lifecycle.scorecards.length === 0 || propose}
      {lifecycle.canFulfill && <div className="actions"><button type="button" disabled={!canAct} onClick={() => void act({ kind: 'fulfill' })}>Review commitment fulfillment</button></div>}
      {!market.noContestTriggered && !market.ratifiedScorecardId && <details><summary>No contest</summary>
        <p className="hint">The native timeout is {utcTime(lifecycle.noContestAfter)}. A no-contest refund becomes available only when the game permits it.</p>
        <button type="button" disabled={!canAct || !lifecycle.canTriggerNoContest} onClick={() => void act({ kind: 'no-contest' })}>Review no contest</button>
      </details>}
    </section>
  </>
}

/** Who can attest a result, read only when opened: whom to ask, and whether quorum is reachable at all. */
function VoterList({ market, card }: { market: LifecycleSnapshot['market']; card: LifecycleSnapshot['scorecards'][number] }) {
  const [open, setOpen] = useState(false)
  const query = useQuery({
    queryKey: ['result-voters', market.chainId, market.projectId, market.blockNumber, card.scorecardId], enabled: open, staleTime: Infinity, retry: false,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ blockNumber: market.blockNumber, scorecard: card.scorecardId, submittedAt: String(card.submittedAt) })
      const response = await fetch(`/api/markets/${market.chainId}/${market.projectId}/voters?${params}`, { signal })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Voters could not be read.')
      return data as ResultVoters
    },
  })
  const explorer = chainForId(market.chainId).blockExplorers.default.url
  const total = query.data?.voters.reduce((sum, voter) => sum + BigInt(voter.weight), 0n) ?? 0n
  const waiting = query.data?.voters.filter(voter => !voter.attested) ?? []
  const short = (n: bigint) => n.toLocaleString('en-US')
  return <details className="result-voters" onToggle={event => setOpen(event.currentTarget.open)}><summary>Who can attest</summary>
    {query.isPending && open && <p className="hint" role="status">Reading voters…</p>}
    {query.error && <p className="error" role="alert">{query.error.message} <button type="button" onClick={() => void query.refetch()}>Retry</button></p>}
    {query.data && <>
      {total < BigInt(card.quorum)
        ? <p className="error">Every vote together is {short(total)} of {short(BigInt(card.quorum))} needed, so this result cannot reach quorum.</p>
        : waiting.length > 0 && <p className="hint">{waiting.length} account{waiting.length === 1 ? '' : 's'} with {short(waiting.reduce((sum, voter) => sum + BigInt(voter.weight), 0n))} have not attested.</p>}
      <div className="table-wrap"><table aria-label="Who can attest"><thead><tr><th>Account</th><th>Weight</th><th>Attested</th></tr></thead><tbody>
        {query.data.voters.map(voter => <tr key={voter.account}>
          <td><a href={`${explorer}/address/${voter.account}`} target="_blank" rel="noreferrer"><code>{voter.account.slice(0, 6)}…{voter.account.slice(-4)}</code></a></td>
          <td>{short(BigInt(voter.weight))}</td><td>{voter.attested ? 'Yes' : 'No'}</td>
        </tr>)}
      </tbody></table></div>
      {query.data.undelegated > 0 && <p className="hint">{query.data.undelegated} position{query.data.undelegated === 1 ? '' : 's'} were never delegated, so their weight counts for no one.</p>}
    </>}
  </details>
}

const shortId = (id: string) => id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id

/** Why a result cannot be ratified yet, from its state, quorum and the earliest the timelock can end. */
/** What the result waits on: attestations, the grace period, queueing, then the governor's timelock. */
function ratifyNote(card: LifecycleSnapshot['scorecards'][number], timelock: number) {
  const missing = BigInt(card.quorum) - BigInt(card.attestationCount)
  if (card.state === 0) return `Attestations open ${utcTime(card.attestationsBegin)}.`
  if (card.state === 1) return missing > 0n ? `Needs ${missing.toLocaleString('en-US')} more attestation weight.` : `Can be queued after ${utcTime(card.gracePeriodEnds)}.`
  if (card.state === 3 && !card.forwarded) return `Reached quorum. Queue it to start the ${duration(timelock)} timelock.`
  if (card.state === 4 && card.ratifiableAt !== null) return `Ratify from ${utcTime(card.ratifiableAt)}.`
  return null
}

function duration(seconds: number) {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hour${seconds === 3_600 ? '' : 's'}`
  return `${seconds} seconds`
}
