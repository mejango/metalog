'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { formatEther } from 'viem'
import { coefficientsFromMoments, parseCoefficientFields, type Coefficients } from '@/domain/distribution'
import { marketRanges, type MarketDefinition } from '@/domain/market'
import type { MarketSnapshot } from '@/lib/defifa'
import { downloadJson, forecastPreview, positionsForBudget } from '@/lib/forecast'
import { forecastSIPmath } from '@/lib/sipmath'
import { orderReturns } from '@/domain/book'
import { useLiveOutcome } from '@/lib/live-outcome'
import { useWallet } from '@/providers/Providers'
import { usePreparedWrite, useTransactions } from '@/providers/Transactions'
import { marketIntent } from '@/lib/transaction'
import { PositionChart } from './PositionChart'

const COEFFICIENT_LABELS = ['Median', 'Base spread', 'Tail asymmetry', 'Middle spread', 'Shape asymmetry', 'Tail spread']
type EditorMode = 'moments' | 'coefficients' | 'ranges'

export function ForecastEditor({ definition, market, current = true, onSubmitted, crowd, payout, live, exports, below }: {
  definition: MarketDefinition
  /** Live circulating supply per range, drawn behind your curve. */
  crowd?: number[]
  payout?: number[] | null
  /** Book-implied odds per range while the game plays out. */
  live?: (number | null)[] | null
  /** Market data exports, shown with the draft downloads. */
  exports?: ReactNode
  /** Shown under the chart; a function receives your curve's chance per range. */
  below?: ReactNode | ((yours: number[] | null) => ReactNode)
  market?: MarketSnapshot
  current?: boolean
  onSubmitted?: () => void
}) {
  const [mean, setMean] = useState('0')
  const [sigma, setSigma] = useState('2')
  const initialBudget = formatEther(BigInt(definition.unitPriceWei) * 100n)
  const [budgets, setBudgets] = useState({ moments: initialBudget, coefficients: initialBudget })
  const [coefficientFields, setCoefficientFields] = useState(() => coefficientsFromMoments(0, 2).map(String))
  const [expressiveInitialized, setExpressiveInitialized] = useState(false)
  const [mode, setMode] = useState<EditorMode>('moments')
  const [quantities, setQuantities] = useState<string[] | null>(null)
  const [referenceCurve, setReferenceCurve] = useState(() => coefficientsFromMoments(0, 2))
  const { address, isSigna, connect } = useWallet()
  const transactions = useTransactions()
  const { preparing: submitting, running, error, setError, run } = usePreparedWrite()
  const manual = mode === 'ranges'
  const budget = mode === 'coefficients' ? budgets.coefficients : budgets.moments
  const curve = useMemo(() => {
    try {
      if (mode === 'moments' && (mean.trim() === '' || sigma.trim() === '')) throw new Error('Enter a mean and standard deviation.')
      const coefficients = mode === 'ranges' ? referenceCurve : mode === 'moments' ? coefficientsFromMoments(Number(mean), Number(sigma)) : parseCoefficientFields(coefficientFields)
      return { coefficients, error: null }
    } catch (cause) {
      return { coefficients: null, error: cause instanceof Error ? cause.message : 'Check your curve.' }
    }
  }, [mean, sigma, coefficientFields, mode, referenceCurve])
  const [lastValidCurves, setLastValidCurves] = useState<Partial<Record<EditorMode, Coefficients>>>({})
  if (curve.coefficients && curve.coefficients !== lastValidCurves[mode]) setLastValidCurves({ ...lastValidCurves, [mode]: curve.coefficients })
  const displayedCurve = curve.coefficients ?? lastValidCurves[mode]!
  const ranges = useMemo(() => marketRanges(definition), [definition])
  // The stake is checked on its own so its error sits on the Buy field.
  const stake = useMemo(() => {
    try { return { payment: positionsForBudget(budget, definition.unitPriceWei), error: null } }
    catch (cause) { return { payment: null, error: cause instanceof Error ? cause.message : 'Check your stake.' } }
  }, [budget, definition.unitPriceWei])
  const automatic = useMemo(() => {
    try {
      if (!curve.coefficients) throw new Error(curve.error || 'Check your curve.')
      if (!stake.payment) throw new Error(stake.error)
      const payment = stake.payment
      const preview = forecastPreview({ market: definition, coefficients: curve.coefficients, positions: payment.count })
      return { payment, preview, error: null }
    } catch (cause) {
      return { payment: null, preview: null, error: cause instanceof Error ? cause.message : 'Check your stake.' }
    }
  }, [curve, stake, definition])
  const manualCounts = useMemo(() => quantities?.every(value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)))
    ? quantities.map(Number) : null, [quantities])
  const stakeError = manual || !curve.coefficients ? null : stake.error
  const model = useMemo(() => {
    if (!manual) return automatic
    try {
      if (!curve.coefficients) throw new Error(curve.error || 'Check your curve.')
      if (!manualCounts) throw new Error('Enter a whole position count of zero or more for every range.')
      const preview = forecastPreview({ market: definition, coefficients: curve.coefficients, quantities: manualCounts })
      return { preview, payment: { valueWei: BigInt(preview.payment.valueWei), remainderWei: 0n }, error: null }
    } catch (cause) {
      return { preview: null, payment: null, error: cause instanceof Error ? cause.message : 'Check your position counts.' }
    }
  }, [manual, manualCounts, automatic, curve, definition])
  // Retained evidence is display-only. Submission and export always use the current model.
  const [lastValidModels, setLastValidModels] = useState<Partial<Record<EditorMode, typeof model>>>({})
  if (model.preview && model !== lastValidModels[mode]) setLastValidModels({ ...lastValidModels, [mode]: model })
  const displayedModel = model.preview ? model : lastValidModels[mode]
  const tablePreview = displayedModel?.preview
  // While the game plays out, preset markets mark where the outcome stands now.
  const now = useLiveOutcome(definition, market?.stage === 'trading' ? 'live' : market && ['settlement', 'complete'].includes(market.stage) ? 'final' : null)
  // Pay this, collect that: what the order returns if the outcome lands in each range.
  const returns = market && model.preview && model.payment ? orderReturns(BigInt(market.potWei), crowd ?? [],
    model.preview.allocation.quantities, model.payment.valueWei, model.preview.allocation.probabilities) : null
  const cost = model.payment?.valueWei ?? 0n
  const eth = (wei: bigint) => `${Number(formatEther(wei)).toLocaleString('en-US', { maximumSignificantDigits: 3 })} ETH`
  const times = (wei: bigint) => cost > 0n ? `${(Number(wei * 100n / cost) / 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}x` : ''
  function selectMode(next: EditorMode) {
    if (next === 'coefficients' && !expressiveInitialized) {
      setCoefficientFields(displayedCurve.map(String))
      setBudgets(previous => ({ ...previous, coefficients: model.preview && !manual ? budget : tablePreview ? formatEther(BigInt(tablePreview.payment.valueWei)) : initialBudget }))
      setExpressiveInitialized(true)
    }
    if (next === 'ranges' && !quantities && tablePreview) {
      setQuantities(tablePreview.allocation.quantities.map(String))
      setReferenceCurve(tablePreview.distribution.coefficients)
    }
    setMode(next)
  }
  function changeCurve(value: Coefficients) {
    if (mode === 'moments') {
      setMean(String(value[0]))
      setSigma(String(value[1] * Math.PI / Math.sqrt(3)))
    } else setCoefficientFields(value.map(String))
  }
  function downloadSIPmath() {
    if (!model.preview) return
    setError('')
    try {
      const { market, distribution, allocation } = model.preview
      downloadJson(forecastSIPmath({ market, coefficients: distribution.coefficients,
        ...(allocation.mode === 'manual' ? { quantities: allocation.quantities } : { positions: allocation.count }),
      }), 'metalog-forecast.SIPmath')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Export could not be prepared.') }
  }
  async function submit() {
    if (!current) return
    if (!address) { connect(); return }
    if (isSigna) { connect({ externalOnly: true }); return }
    if (!market || !model.preview || !curve.coefficients) return
    const { allocation } = model.preview, coefficients = curve.coefficients
    await run(async () => (await import('@/lib/defifa')).prepareEntry(market, allocation, address, coefficients),
      (prepared, form) => transactions.execute(prepared, marketIntent(market), form), () => onSubmitted?.(), 'Entry could not be prepared.')
  }
  const closed = market && market.stage !== 'entry'
  // After entry, the chart shows the crowd and payout; the checkout stays mounted so a draft survives.
  const browsing = Boolean(market && closed && market.stage !== 'countdown')
  return <section aria-labelledby="your-view" className="forecast" data-browsing={browsing}>
    <div className="forecast-canvas">
      <PositionChart ranges={ranges} quantities={(manual && manualCounts) || tablePreview?.allocation.quantities || []}
        coefficients={displayedCurve} crowd={crowd} payout={payout} live={live} now={now} mine={!browsing} reference={manual} onChange={manual ? undefined : changeCurve}
          onPick={manual ? tierId => document.querySelector<HTMLInputElement>(`input[data-tier="${tierId}"]`)?.select() : undefined}
        readOnly={!model.preview && (!manual || !manualCounts)} />
      {typeof below === 'function' ? below(displayedModel?.preview?.allocation.probabilities ?? null) : below}
    </div>
    <div className="forecast-side">
    <div className="ticket" hidden={browsing}>
      <h2 id="your-view">Pay to play</h2>
      <p className="hint">{manual ? 'Click a range in the graph, or set counts below' : 'Drag the curve in the graph, or set values below'}</p>
      <div className="forecast-controls">
        <div className="mode-toggle" role="group" aria-label="Curve controls">
          <button type="button" aria-pressed={mode === 'moments'} onClick={() => selectMode('moments')}>Simple</button>
          <button type="button" aria-pressed={mode === 'coefficients'} onClick={() => selectMode('coefficients')}>Expressive</button>
          <button type="button" aria-pressed={manual} onClick={() => selectMode('ranges')}>By range</button>
        </div>
      </div>
      {mode === 'moments' ? <div className="forecast-moments">
        <label className="field"><span>Mean (%)</span><input aria-label="Mean (%)" inputMode="decimal" value={mean} onChange={event => setMean(event.target.value)} /></label>
        <label className="field"><span>Standard deviation (%)</span><input aria-label="Standard deviation (%)" inputMode="decimal" value={sigma} onChange={event => setSigma(event.target.value)} /></label>
      </div> : mode === 'coefficients' ? <>
        <div className="coefficient-fields">{COEFFICIENT_LABELS.map((label, index) => <label className="field" key={label}>
          <span>a<sub>{index + 1}</sub> | {label}</span>
          <input aria-label={`a${index + 1} | ${label}`} inputMode="decimal" spellCheck={false}
            aria-invalid={curve.error !== null} aria-describedby={curve.error ? 'forecast-error' : undefined}
            value={coefficientFields[index]}
            onChange={event => {
              const updated = [...coefficientFields]
              updated[index] = event.target.value
              setCoefficientFields(updated)
            }} />
        </label>)}</div>
        <p className="hint">Values in percentage points. Shape terms work together.</p>
      </> : <div className="table-wrap positions-table range-editor" role="region" aria-label="Position counts" tabIndex={0}>
        <table><tbody>
          {ranges.map((range, index) => <tr key={range.tierId}><td>{range.label}</td><td>
            <input className="quantity-input" data-tier={range.tierId} aria-label={`Positions for ${range.label}`} inputMode="numeric"
              aria-invalid={model.error !== null} aria-describedby={model.error ? 'forecast-error' : undefined}
              value={quantities?.[index] ?? ''} onChange={event => {
                const updated = [...(quantities ?? ranges.map(() => '0'))]
                updated[index] = event.target.value
                setQuantities(updated)
              }} />
          </td></tr>)}
        </tbody></table>
      </div>}
      <div className="ticket-stake">
        <label className="field"><span>Buy (ETH)</span><input className="stake-input" inputMode="decimal" readOnly={manual} value={manual ? (model.payment ? formatEther(model.payment.valueWei) : '') : budget} onChange={event => setBudgets(previous => ({ ...previous, [mode]: event.target.value }))}
          aria-invalid={stakeError !== null} aria-describedby={stakeError ? 'stake-error' : undefined} />
          {stakeError ? <small id="stake-error" className="error" role="alert">{stakeError}</small> : <small>{formatEther(BigInt(definition.unitPriceWei))} ETH per position</small>}</label>
        {displayedModel?.preview && displayedModel.payment && <div className="field">
          <span>{displayedModel.preview.allocation.count} positions for {formatEther(displayedModel.payment.valueWei)} ETH</span>
          <small>{!model.preview ? 'Last valid preview' : `${manual ? 'Difference from reference curve' : 'Rounding difference'}: ${(displayedModel.preview.allocation.totalVariationError * 100).toFixed(2)}%`}</small>
          {displayedModel.payment.remainderWei > 0n && <small>{formatEther(displayedModel.payment.remainderWei)} ETH stays in your wallet.</small>}
        </div>}
      </div>
      {returns && <p className="order-returns" aria-live="polite">
        Best case <strong data-gain={returns.best > cost}>{eth(returns.best)} ({times(returns.best)})</strong>
        <span className="pip" aria-hidden="true">|</span>
        Your curve expects <strong data-gain={returns.expectedWei > cost}>{eth(returns.expectedWei)} ({times(returns.expectedWei)})</strong></p>}
      {tablePreview && <div className="positions" role="region" aria-label="Positions">
        <h3>Your order, {tablePreview.allocation.count} positions{!model.preview && <small> | Last valid preview</small>}</h3>
        <table aria-label="Your order"><thead><tr><th>Range</th><th>{manual ? 'Reference' : 'Curve'}</th><th>Positions</th>{returns && <th title="What you collect if it ends in this range and the range takes the pot">If it ends here</th>}</tr></thead><tbody>
          {tablePreview.ranges.map((range, index) => tablePreview.allocation.quantities[index] > 0 && <tr key={range.tierId}>
            <td>{range.label}</td><td>{(tablePreview.allocation.probabilities[index] * 100).toFixed(1)}%</td><td>{tablePreview.allocation.quantities[index]}</td>
            {returns && <td data-gain={returns.collect[index] > cost}>{eth(returns.collect[index])} ({times(returns.collect[index])})</td>}
          </tr>)}
        </tbody></table>
      </div>}
      {model.error && !stakeError && <p id="forecast-error" className="error" role="alert">{model.error}</p>}
      <div className="actions ticket-actions">
        {market && <button className="primary" disabled={!current || !model.preview || Boolean(closed) || running || transactions.busy} onClick={submit}>
          {submitting ? 'Preparing entry…' : !address ? 'Connect to enter' : isSigna ? 'Use external wallet to enter' : 'Review entry'}
        </button>}
        <button className="quiet" disabled={!model.preview} onClick={() => model.preview && downloadJson(model.preview, 'metalog-forecast.json')}>Download draft</button>
        <button className="quiet" disabled={!model.preview} onClick={downloadSIPmath}>Download SIPmath</button>
      </div>
      {exports}
      {current && closed && <p className="hint">{market.stage === 'countdown' ? 'Entry has not opened.' : 'Entry is closed.'}</p>}
      {!market && <p className="hint">Example only. No positions are minted.</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
    </div>
  </section>
}
