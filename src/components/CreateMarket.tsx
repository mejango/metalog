'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatEther, parseEther } from 'viem'
import { MIN_NEW_UNIT_PRICE_WEI, parseDefaultDelegate, validateMarket } from '@/domain/market'
import { createRanges, createCustomRanges, parseRangeBoundaries, parseRangeBoundary, redistributeRangeBoundaries, rangeBoundaryIssues, DEFAULT_RANGE_COUNT, DEFAULT_RANGE_WIDTH, MIN_RANGE_COUNT, MAX_RANGE_COUNT, MIN_RANGE_WIDTH, MAX_RANGE_WIDTH, type RangeBin } from '@/domain/ranges'
import { SUPPORTED_CHAINS } from '@/lib/wallet'
import { downloadJson } from '@/lib/forecast'
import { useWallet } from '@/providers/Providers'
import { usePreparedWrite, useTransactions } from '@/providers/Transactions'
import { creationIntent } from '@/lib/transaction'
import { RangePreview } from './RangePreview'
import { RANGE_PRESETS, buildRangePreset, type RangePresetId } from '@/domain/range-presets'
import { namedRanges, resizeRangeBoundaries, validateCustomRangeCount } from '@/domain/ranges'
import { ASSET_PRESETS, WINDOW_PRESETS, buildObservationPreset } from '@/domain/observation-presets'
import { shortTestSchedule } from '@/domain/schedule'

const dateInput = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 16)
const seconds = (value: string) => Math.floor(Date.parse(`${value}Z`) / 1000)
type RangeMode = 'simple' | 'advanced'
const describeBoundaryIssue = (message: string) => message.replace(/Boundary (\d+)/g, (_, number: string) => `Edge between ranges ${number} and ${Number(number) + 1}`)

export function CreateMarket({ now }: { now: number }) {
  const [prompt, setPrompt] = useState('')
  const [source, setSource] = useState('')
  const [rule, setRule] = useState('Percentage change = 100 × (end value / start value − 1). Use the specified source at the observation start and end. Payouts follow the ratified result.')
  const [delegate, setDelegate] = useState('')
  const [open, setOpen] = useState(dateInput(now + 600))
  const [close, setClose] = useState(dateInput(now + 24 * 3600))
  const [end, setEnd] = useState(dateInput(now + 48 * 3600))
  const [scheduleError, setScheduleError] = useState('')
  const testSchedule = useMemo(() => {
    try { return shortTestSchedule(now, seconds(close), seconds(end)) }
    catch { return null }
  }, [now, close, end])
  const [rangeCount, setRangeCount] = useState(String(DEFAULT_RANGE_COUNT))
  const [rangeWidth, setRangeWidth] = useState(String(DEFAULT_RANGE_WIDTH))
  const [rangeMode, setRangeMode] = useState<RangeMode>('simple')
  const [selectedRange, setSelectedRange] = useState<number | null>(null)
  const [selectedBoundary, setSelectedBoundary] = useState<number | null>(null)
  const [fixedBoundaries, setFixedBoundaries] = useState<number[]>([])
  const [editFailure, setEditFailure] = useState<{ index: number; message: string } | null>(null)
  const [boundaries, setBoundaries] = useState<string[] | null>(null)
  const [rangeNames, setRangeNames] = useState<string[] | undefined>()
  const [advancedCount, setAdvancedCount] = useState(String(DEFAULT_RANGE_COUNT))
  const [rangePreset, setRangePreset] = useState<RangePresetId | 'custom'>('custom')
  const [presetWidth, setPresetWidth] = useState('1')
  const [presetMean, setPresetMean] = useState('0')
  const [presetSigma, setPresetSigma] = useState('2')
  const [presetError, setPresetError] = useState('')
  const [assetPreset, setAssetPreset] = useState('custom')
  const [timePreset, setTimePreset] = useState('custom')
  const [observationError, setObservationError] = useState('')
  const [lastRanges, setLastRanges] = useState<Partial<Record<RangeMode, RangeBin[]>>>(() => ({ simple: createRanges() }))
  const [price, setPrice] = useState('0.001')
  const [chainId, setChainId] = useState(8453)
  const isTestnet = SUPPORTED_CHAINS.some(chain => chain.id === chainId && 'testnet' in chain && chain.testnet)
  const { preparing: busy, error, setError, run } = usePreparedWrite()
  const [showValidation, setShowValidation] = useState(false)
  const router = useRouter()
  const wallet = useWallet()
  const transactions = useTransactions()
  const rangeDraft = useMemo(() => {
    try {
      if (rangeMode === 'advanced') {
        const rangeBoundaries = parseRangeBoundaries(boundaries ?? [])
        return { configuration: { rangeBoundaries, ...(rangeNames ? { rangeNames } : {}) }, ranges: namedRanges(createCustomRanges(rangeBoundaries), rangeNames), error: null }
      }
      return { configuration: { rangeCount: Number(rangeCount), rangeWidth: Number(rangeWidth) }, ranges: createRanges(Number(rangeCount), Number(rangeWidth)), error: null }
    } catch (cause) { return { configuration: null, ranges: null, error: cause instanceof Error ? cause.message : 'Check the range boundaries.' } }
  }, [rangeMode, boundaries, rangeCount, rangeWidth, rangeNames])
  if (rangeDraft.ranges && (rangeMode === 'simple' || !editFailure) && rangeDraft.ranges !== lastRanges[rangeMode]) setLastRanges({ ...lastRanges, [rangeMode]: rangeDraft.ranges })
  const ranges = (rangeMode === 'advanced' && editFailure ? null : rangeDraft.ranges) ?? lastRanges[rangeMode] ?? []
  const boundaryIssues = rangeMode === 'advanced' ? { ...rangeBoundaryIssues(boundaries ?? []), ...(editFailure ? { [editFailure.index]: editFailure.message } : {}) } : {}
  const rangeError = rangeMode === 'advanced' && editFailure ? editFailure.message : rangeDraft.error
  const delegateDraft = useMemo(() => {
    try { return { address: parseDefaultDelegate(delegate), error: null } }
    catch (cause) { return { address: undefined, error: cause instanceof Error ? cause.message : 'Enter a valid delegate address.' } }
  }, [delegate])
  const priceError = !/^(?:\d+(?:\.\d{0,18})?|\.\d{1,18})$/.test(price) ? 'Enter an ETH price with up to 18 decimal places.'
    : parseEther(price) < MIN_NEW_UNIT_PRICE_WEI ? `Set at least ${formatEther(MIN_NEW_UNIT_PRICE_WEI)} ETH per position.` : null
  const draft = useMemo(() => {
    try {
      if (priceError) throw new Error(priceError)
      if (rangeError || !rangeDraft.configuration) throw new Error(rangeError || 'Check the ranges.')
      if (delegateDraft.error) throw new Error(delegateDraft.error)
      const definition = validateMarket({ schemaVersion: 1, settlement: 'defifa-scorecard', prompt, source, resolutionRule: rule,
        entryOpensAt: seconds(open), entryClosesAt: seconds(close), resolvesAt: seconds(end), ...rangeDraft.configuration, defaultAttestationDelegate: delegateDraft.address, unitPriceWei: parseEther(price).toString() })
      return { definition, error: null }
    } catch (cause) { return { definition: null, error: cause instanceof Error ? cause.message : 'Check the market details.' } }
  }, [prompt, source, rule, open, close, end, rangeDraft, rangeError, delegateDraft, price, priceError])
  function selectRangeMode(next: RangeMode) {
    if (next === 'advanced' && boundaries === null) {
      const seed = rangeDraft.ranges ?? lastRanges.simple!
      setBoundaries(seed.slice(0, -1).map(range => String(range.upper)))
      setAdvancedCount(String(seed.length))
      setLastRanges(previous => ({ ...previous, advanced: seed }))
    }
    setSelectedRange(null)
    setSelectedBoundary(null)
    setRangeMode(next)
  }
  function editBoundary(index: number, text: string, anchors = fixedBoundaries) {
    setRangePreset('custom')
    setPresetError('')
    const next = boundaries!.map((item, position) => position === index ? text : item)
    setBoundaries(next)
    try {
      const values = next.map((item, position) => parseRangeBoundary(item, position))
      if (editFailure && editFailure.index !== index) { parseRangeBoundaries(next) }
      const cached = lastRanges.advanced?.slice(0, -1).map(range => range.upper!)
      const base = cached?.length === next.length ? cached : parseRangeBoundaries(next)
      const fixed = [...new Set([...anchors, index])]
      const result = redistributeRangeBoundaries(base, index, values[index], fixed)
      setBoundaries(result.map((value, position) => position === index ? text : String(value)))
      setFixedBoundaries(fixed)
      setEditFailure(null)
    } catch (cause) {
      setEditFailure({ index, message: cause instanceof Error ? cause.message : 'Check this boundary.' })
    }
  }
  function setBoundaryFixed(index: number, fixed: boolean) {
    const nextFixed = fixed ? [...fixedBoundaries, index] : fixedBoundaries.filter(item => item !== index)
    setFixedBoundaries(nextFixed)
    if (!fixed && editFailure && editFailure.index !== index) {
      editBoundary(editFailure.index, boundaries![editFailure.index], nextFixed)
    } else if (!fixed && !rangeError) {
      const values = parseRangeBoundaries(boundaries!)
      setBoundaries(redistributeRangeBoundaries(values, 0, values[0], nextFixed).map(String))
    }
  }
  function removeBoundary(index: number) {
    const next = boundaries!.filter((_, position) => position !== index)
    setAdvancedCount(String(next.length + 1))
    setRangeNames(undefined)
    setRangePreset('custom')
    setPresetError('')
    const fixed = fixedBoundaries.filter(item => item !== index).map(item => item > index ? item - 1 : item)
    setFixedBoundaries(fixed)
    setEditFailure(null)
    setSelectedBoundary(null)
    setSelectedRange(null)
    try {
      const values = parseRangeBoundaries(next)
      setBoundaries(redistributeRangeBoundaries(values, 0, values[0], fixed).map(String))
    } catch { setBoundaries(next) }
  }
  function applyRanges() {
    try {
      if (rangePreset === 'equal-probability' && (!presetMean.trim() || !presetSigma.trim())) throw new Error('Enter a reference mean and standard deviation.')
      const layout = rangePreset === 'custom'
        ? { boundaries: resizeRangeBoundaries(parseRangeBoundaries(boundaries!), validateCustomRangeCount(Number(advancedCount))) }
        : buildRangePreset(rangePreset, { count: Number(advancedCount), width: Number(presetWidth), mean: Number(presetMean), sigma: Number(presetSigma) })
      setBoundaries(layout.boundaries.map(String))
      setRangeNames('names' in layout ? layout.names : undefined)
      setAdvancedCount(String(layout.boundaries.length + 1))
      setFixedBoundaries([])
      setEditFailure(null)
      setSelectedBoundary(null)
      setSelectedRange(null)
      setPresetError('')
    } catch (cause) { setPresetError(cause instanceof Error ? cause.message : 'Check the preset values.') }
  }
  function applyObservation() {
    try {
      const preset = buildObservationPreset(assetPreset, timePreset)
      const starts = seconds(close)
      if (!Number.isFinite(starts)) throw new Error('Set an observation start before applying this preset.')
      setEnd(dateInput(starts + preset.durationSeconds))
      setPrompt(preset.prompt)
      setSource(preset.source)
      setRule(preset.resolutionRule)
      setObservationError('')
      setScheduleError('')
    } catch (cause) { setObservationError(cause instanceof Error ? cause.message : 'Check the observation start.') }
  }
  function applyShortSchedule() {
    if (!isTestnet) return
    try {
      const schedule = shortTestSchedule(Date.now() / 1000, seconds(close), seconds(end))
      setOpen(dateInput(schedule.entryOpensAt))
      setClose(dateInput(schedule.entryClosesAt))
      setEnd(dateInput(schedule.resolvesAt))
      setScheduleError('')
    } catch (cause) { setScheduleError(cause instanceof Error ? cause.message : 'Check the observation dates.') }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault()
    if (busy || transactions.busy) return
    setShowValidation(true)
    setError('')
    if (!draft.definition) return
    if (!wallet.address) { wallet.connect(); return }
    if (wallet.isSigna) { wallet.connect({ externalOnly: true }); return }
    const definition = draft.definition, account = wallet.address
    await run(async () => (await import('@/lib/defifa')).prepareCreateMarket(definition, chainId, account),
      prepared => transactions.execute(prepared, creationIntent(chainId, definition)), async receipt => {
      const projectId = (await import('@/lib/defifa')).createdMarketId(receipt)
      if (!projectId) throw new Error('The transaction was confirmed, but its game ID could not be read. Check the transaction before creating again.')
      router.push(`/markets/${chainId}/${projectId}`)
    }, 'Market could not be prepared.')
  }
  return <form className="form-narrow" onSubmit={create} onChange={() => setError('')} onInvalid={event => {
    // Native constraints run before onSubmit, including required date inputs.
    // Keep that rejection visible beside the action as well as at the field.
    const field = event.target as HTMLInputElement
    if (field !== event.currentTarget.querySelector(':invalid')) return
    const label = field.labels?.[0]?.querySelector('span')?.textContent ?? 'Market details'
    setError(`${label}: ${field.validationMessage}`)
    setShowValidation(true)
  }}>
    <h1>Create market</h1>
    <div className="forecast-moments">
      <label className="field"><span>Asset preset</span><select className="network-select" value={assetPreset} onChange={event => setAssetPreset(event.target.value)}><option value="custom">Custom</option>{ASSET_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></label>
      <label className="field"><span>Time preset</span><select className="network-select" value={timePreset} onChange={event => setTimePreset(event.target.value)}><option value="custom">Custom</option>{WINDOW_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></label>
    </div>
    <div className="field"><div><button type="button" disabled={assetPreset === 'custom' || timePreset === 'custom'} onClick={applyObservation}>Apply market preset</button></div><small>Fills the question, source, rule and observation end. All fields stay editable.</small>{observationError && <small className="error" role="alert">{observationError}</small>}</div>
    <label className="field"><span>Question</span><input placeholder="What will Bitcoin’s price change be over 24 hours?" maxLength={280} required value={prompt} onChange={event => setPrompt(event.target.value)} /></label>
    <div className="grid">
      <label className="field"><span>Entry opens (UTC)</span><input type="datetime-local" required value={open} onChange={event => setOpen(event.target.value)} /></label>
      <label className="field"><span>Entry closes / observation starts (UTC)</span><input type="datetime-local" required value={close} onChange={event => { setClose(event.target.value); setScheduleError('') }} /></label>
    </div>
    <label className="field"><span>Observation ends (UTC)</span><input type="datetime-local" required value={end} onChange={event => { setEnd(event.target.value); setScheduleError('') }} /></label>
    <label className="field"><span>Observation source</span><input placeholder="Source, instrument and exact observation to use" maxLength={500} required value={source} onChange={event => setSource(event.target.value)} /></label>
    <label className="field"><span>Observation rule</span><textarea maxLength={2000} required value={rule} onChange={event => setRule(event.target.value)} /><small>Specify timestamps, precision and what to do if the source is unavailable.</small></label>
    <label className="field"><span id="default-delegate-label">Oracle</span><input aria-labelledby="default-delegate-label" aria-describedby="default-delegate-help" placeholder="0x… (optional)" autoComplete="off" spellCheck={false} value={delegate} aria-invalid={Boolean(delegateDraft.error)} onChange={event => setDelegate(event.target.value)} /><small id="default-delegate-help">Receives voting power from market positions. Leave blank to keep it with position holders. Holders can change their voting address while entries are open.</small>{delegateDraft.error && <small className="error" role="alert">{delegateDraft.error}</small>}</label>
    <div className="forecast-controls"><div className="mode-toggle" role="group" aria-label="Range layout">
      <button type="button" aria-pressed={rangeMode === 'simple'} onClick={() => selectRangeMode('simple')}>Simple</button>
      <button type="button" aria-pressed={rangeMode === 'advanced'} onClick={() => selectRangeMode('advanced')}>Advanced</button>
    </div></div>
    <div className="forecast-moments">
      {rangeMode === 'simple' && <>
        <label className="field"><span>Ranges</span><input type="number" min={MIN_RANGE_COUNT} max={MAX_RANGE_COUNT} step={2} required value={rangeCount} onChange={event => setRangeCount(event.target.value)} /></label>
        <label className="field"><span>Range width (%)</span><input type="number" min={MIN_RANGE_WIDTH} max={MAX_RANGE_WIDTH} step={MIN_RANGE_WIDTH} required value={rangeWidth} onChange={event => setRangeWidth(event.target.value)} /></label>
      </>}
      <label className="field"><span id="price-label">Price per position (ETH)</span><input aria-labelledby="price-label" inputMode="decimal" required value={price}
        aria-invalid={priceError !== null} aria-describedby={priceError ? 'price-error' : undefined} onChange={event => setPrice(event.target.value)} />
        {priceError && <small id="price-error" className="error" role="alert">{priceError}</small>}</label>
    </div>
    {rangeMode === 'advanced' && <div className="range-presets">
      <div className="forecast-moments">
        <label className="field"><span>Range preset</span><select className="network-select" value={rangePreset} onChange={event => { setRangePreset(event.target.value as RangePresetId | 'custom'); setPresetError('') }}><option value="custom">Custom</option>{RANGE_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></label>
        {!rangePreset.startsWith('kmac-') && <label className="field"><span>Ranges</span><input inputMode="numeric" value={advancedCount} onChange={event => { setAdvancedCount(event.target.value); setPresetError('') }} /></label>}
        {rangePreset === 'equal-width' && <label className="field"><span>Range width (%)</span><input inputMode="decimal" value={presetWidth} onChange={event => setPresetWidth(event.target.value)} /></label>}
        {rangePreset === 'equal-probability' && <>
          <label className="field"><span>Reference mean (%)</span><input inputMode="decimal" value={presetMean} onChange={event => setPresetMean(event.target.value)} /></label>
          <label className="field"><span>Reference SD (%)</span><input inputMode="decimal" value={presetSigma} onChange={event => setPresetSigma(event.target.value)} /></label>
        </>}
      </div>
      <div className="field"><div><button type="button" onClick={applyRanges}>{rangePreset === 'custom' ? 'Apply range count' : 'Apply range preset'}</button></div>
        <small>{rangePreset === 'custom' ? 'Redistributes edges evenly between the outer limits. Clears fixed edges and names.' : rangePreset === 'equal-probability' ? 'Equal probability under the reference Simple distribution, including both tails. Rounded to 4 decimals; this is not a market forecast.' : rangePreset === 'logarithmic' ? 'Concentrates ranges around 0% on a logarithmic −100% to +100% scale, with overflow tails.' : rangePreset.startsWith('kmac-') ? 'Seven named ranges from kmac. Time labels describe the suggested window; dates and observation rules stay separate.' : 'Equal-width ranges centered on 0%, with overflow tails.'} {rangePreset !== 'custom' && 'Applying replaces the current range layout.'}</small>
        {presetError && <small className="error" role="alert">{presetError}</small>}
      </div>
    </div>}
    <div aria-live="polite">{rangeError && <p className="range-alert error" role="alert">{describeBoundaryIssue(rangeError)} Chart shows the last valid ranges.</p>}</div>
    <RangePreview ranges={ranges} stale={Boolean(rangeError)} invalidBoundaries={Object.keys(boundaryIssues).map(key => { const index = Number(key); const raw = boundaries?.[index]?.trim(); const value = raw ? Number(raw) : NaN; return { index, value: Number.isFinite(value) ? value : null } })} selected={selectedRange} boundary={selectedBoundary}
      onSelect={tier => { setSelectedRange(tier); setSelectedBoundary(null) }}
      onBoundaryFocus={index => { setSelectedBoundary(index); setSelectedRange(index + 1) }}
      onBoundaryChange={rangeMode === 'advanced' ? (index, value) => editBoundary(index, value) : undefined} />
    <div>{rangeMode === 'advanced' ? <>
      <p className="hint">Each range has a lower and upper edge. Shared edges update both neighboring ranges.</p>
      <div className="range-boundaries">{boundaries && Array.from({ length: boundaries.length + 1 }, (_, rangeIndex) => {
        const tier = rangeIndex + 1
        return <div className="range-card" role="group" aria-label={`Range ${tier}`} key={tier} data-tier-id={tier} data-highlighted={selectedRange === tier}>
          <div className="row"><h3>Range {tier}</h3>{rangeIndex < boundaries.length && <button className="remove-boundary" type="button" aria-label={`Remove boundary ${tier}`} title={`Merge ranges ${tier} and ${tier + 1}`} disabled={boundaries.length <= MIN_RANGE_COUNT - 1} onClick={() => removeBoundary(rangeIndex)}>×</button>}</div>
          {rangeNames && <label className="field range-name"><span>Name</span><input aria-label={`Range ${tier} name`} maxLength={40} value={rangeNames[rangeIndex]} onChange={event => { setRangeNames(previous => previous!.map((name, index) => index === rangeIndex ? event.target.value : name)); setRangePreset('custom') }} /></label>}
          <div className="range-card-edges">{(['lower', 'upper'] as const).map(edge => {
            const index = edge === 'lower' ? rangeIndex - 1 : rangeIndex
            const id = `range-${tier}-${edge}`
            if (index < 0 || index >= boundaries.length) return <div className="field" key={edge}><span>{edge === 'lower' ? 'Lower' : 'Upper'}</span><small>No {edge} limit</small></div>
            const neighbor = edge === 'lower' ? tier - 1 : tier + 1
            const extent = index === 0 || index === boundaries.length - 1
            return <div className="field edge-field" key={edge} data-invalid={Boolean(boundaryIssues[index])}>
              <label htmlFor={id}><span>{edge === 'lower' ? 'Lower (%)' : 'Upper (%)'}</span></label>
              <input id={id} aria-label={`Range ${tier} ${edge} (%)`} data-edge={edge} data-boundary-index={index} onFocus={() => { setSelectedBoundary(index); setSelectedRange(tier) }} inputMode="decimal" maxLength={24} required value={boundaries[index]} aria-invalid={Boolean(boundaryIssues[index])} aria-describedby={`${id}-help ${id}-error`} onChange={event => editBoundary(index, event.target.value)} />
              <small id={`${id}-help`}>Shared with range {neighbor}</small>
              <label className="boundary-fixed"><input type="checkbox" aria-label={`Fix range ${tier} ${edge} edge`} checked={extent || fixedBoundaries.includes(index)} disabled={extent} onFocus={() => { setSelectedBoundary(index); setSelectedRange(tier) }} onChange={event => setBoundaryFixed(index, event.target.checked)} />{extent ? 'Extent' : 'Fixed'}</label>
              <small id={`${id}-error`} className="error">{boundaryIssues[index] && describeBoundaryIssue(boundaryIssues[index])}</small>
            </div>
          })}</div>
        </div>
      })}</div>
      <button type="button" disabled={(boundaries?.length ?? 0) >= MAX_RANGE_COUNT - 1} onClick={() => { setFixedBoundaries(previous => [...new Set([...previous, boundaries!.length - 1])]); setAdvancedCount(String(boundaries!.length + 2)); setRangeNames(undefined); setRangePreset('custom'); setBoundaries(previous => [...previous!, '']) }}>Add boundary</button>
    </> : <p className="hint">Equal-width ranges centered on 0%, plus one overflow range at each end.</p>}</div>
    <details><summary>View ranges</summary>{rangeError && <p className="hint">Showing the last valid ranges.</p>}<div className="table-wrap"><table><thead><tr><th>Tier</th><th>Range</th></tr></thead><tbody>{ranges.map(range => <tr key={range.tierId}><td>{range.tierId}</td><td>{range.label}</td></tr>)}</tbody></table></div></details>
    <div className="section">
      <label className="field"><span>Network</span><select className="network-select" value={chainId} onChange={event => setChainId(Number(event.target.value))}>{SUPPORTED_CHAINS.map(chain => <option key={chain.id} value={chain.id}>{chain.name}</option>)}</select></label>
      {isTestnet && <div className="field"><div><button type="button" onClick={applyShortSchedule}>Use short test schedule</button></div><small>{testSchedule ? <>Opens in 2–3 minutes, with 10 minutes for entry and {(testSchedule.resolvesAt - testSchedule.entryClosesAt) / 60} minutes for observation.</> : 'Preserves the observation duration entered above.'} Results still take at least 1 day to settle.</small>{scheduleError && <small className="error" role="alert">{scheduleError}</small>}</div>}
      <p className="hint">Payouts follow the ratified result. Entry can be refunded while minting is open.</p>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy || transactions.busy || Boolean(rangeError || delegateDraft.error)}>{busy ? 'Preparing market…' : !wallet.address ? 'Connect to create' : wallet.isSigna ? 'Use external wallet to create' : 'Review market'}</button>
        <button type="button" disabled={!draft.definition} onClick={() => draft.definition && downloadJson(draft.definition, 'metalog-market.json')}>Download definition</button>
      </div>
      {(error || (showValidation && draft.error && draft.error !== rangeError && draft.error !== delegateDraft.error && draft.error !== priceError)) && <p className="error" role="alert" style={{ marginTop: 14 }}>{error || draft.error}</p>}
    </div>
  </form>
}
