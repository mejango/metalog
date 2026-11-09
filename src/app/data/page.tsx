import Link from 'next/link'

export const metadata = { title: 'Data' }

export default function DataPage() {
  return <article className="prose"><h1>Data</h1>
    <p>Every live market has a JSON view. No wallet is required.</p>
    <pre>GET /api/markets/:chainId/:projectId</pre>
    <p>The response includes the question, observation rule, range boundaries, live tier supply, pool balance and chain block. Percentages use percentage points: <code>2.5</code> means +2.5%.</p>
    <p>Each range includes its lower bound and excludes its upper bound. A null bound denotes an overflow tail.</p>
    <pre>GET /api/markets/:chainId/:projectId/play?account=0x…</pre>
    <p>The play view adds the wallet&apos;s positions per range, results and available actions. Results history reports its completeness and continuation cursor. Keep the same <code>blockNumber</code> and pass <code>scorecardsNextCursor</code> as <code>scorecardCursor</code>.</p>
    <pre>POST /api/preview{`\n\n`}{JSON.stringify({ market: '<market definition>', coefficients: [0, 1, 0, 0, 0, 0], positions: 100 }, null, 2)}</pre>
    <p>Preview returns the curve probabilities, integer position allocation, difference from the curve and exact payment in wei. Supply <code>quantities</code>, one whole position count per range, instead of <code>positions</code> for a manual allocation. <code>allocation.mode</code> distinguishes <code>curve</code> from <code>manual</code>; the coefficients remain the reference curve. This endpoint sends no transaction.</p>
    <h2>SIPmath export</h2>
    <pre>{'POST /api/preview?format=sipmath\nGET /api/markets/:chainId/:projectId?format=sipmath'}</pre>
    <p>Use the same preview body, or select Download SIPmath in the editor. The file includes the forecast, position allocation and source evidence, with seeded sampling and five calibration trials. Manual entries export the allocation; their reference curve stays in the audit metadata.</p>
    <p>Continuous outcomes use percentage points. Allocation and supply variables return tier IDs with exact range definitions, including overflow. They do not specify an outcome within a range. The ratified result remains settlement evidence.</p>
    <p>The export uses the canonical <code>SIPmath_3_0</code> wire profile described by the <a href="https://www.probabilitymanagement.org/s/SIPmath-31-Standard-2025-01-31.pdf">SIPmath 3.1 standard</a>. Trials start at 1. Seeds reproduce a variable; combining markets requires an explicit dependence model. No copula is inferred.</p>
    <p>Supply shares measure committed positions. They are stake-weighted, not a count of independent opinions. Refunds and redemptions change the live supply. The ratified result controls payouts.</p>
    <p>After entry closes, <code>openingDistribution</code> preserves the opening stake shares where they can be reconstructed. <code>ratifiedPayoutShares</code> reports the result’s actual allocation, not a probability estimate.</p>
    <p><code>tradingDistribution: null</code> means no trading estimate is available. Prices alone do not establish probabilities; a usable estimate also needs executable quotes, supply, payout assumptions and freshness.</p>
    <p><Link href="/markets/example">Try a curve and download its JSON</Link></p>
  </article>
}
