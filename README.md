# Metalog

A minimal Defifa interface for percentage-change markets.

Source: [mejango/metalog](https://github.com/mejango/metalog).

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:3020. Requires Node 22.16 or later. The example curve works without a wallet or RPC. This directory is an independent Next.js app.

For design work on live games, run `npm run dev:live`. It serves `/api/markets` from metalog.money, because local server reads from Juicebox Center hit its public-origin rate limit. Local API changes do not apply in this mode.

## Hosting

[Public example](https://metalog-production.up.railway.app/markets/example). Railway project `c708f483-caab-4951-bcd6-6becdc95a83e`, service `metalog`, uses the checked-in Dockerfile and `railway.json` to run the full standalone Next app. The configured site origin is `https://metalog.money`; Signa remains disabled until that origin is registered with Signa. The example does not mint positions.

After the checks below pass, publish this directory with `railway up --project c708f483-caab-4951-bcd6-6becdc95a83e --service metalog --environment production --ci`. Railway retains successful deployments for rollback; verify the public example and `/api/preview` after each release. Source uploads and Docker builds exclude environment files, dependencies and generated artifacts.

## What works

- Market definition with exact observation dates/rule and two overflow ranges. Simple creates equal-width NFT ranges centered on zero; Advanced has an explicit 3–61 range count and editable edges, with equal-width, equal-probability, logarithmic and kmac seven-tier presets. Both layouts retain their drafts when switching. Kmac names are editable and remain in native NFT names, Center metadata and exports.
- Optional Bitcoin, Ethereum and Solana USD observation templates with 15-minute, 1-hour or 1-day windows. Applying fills editable fields; Custom keeps full control. Range recipes and observation templates are independent.
- Simple mean/deviation, Expressive coefficients and By range NFT counts retain independent drafts. One chart overlays the curve and allocation bars on the same percentage axis, with exact bucket details, overflow totals and two read-only positions columns without inner scrolling.
- Native Defifa 2.0 ERC-1155 creation, entry, position transfers, voting delegation, scorecard proposals/attestations (DefifaVotingReferee), queueing and ratification (governor), refunds and payout claims. Every write uses external-wallet review, simulation, receipt-effect verification and reload recovery.
- Signa connection using the shared SDK, enabled after origin/callback registration.
- Block-pinned market reads, circulating and reconstructed opening supply, ratified scorecard weights, and native JSON plus reproducible SIPmath export/preview.

The ratified Defifa scorecard controls payouts. There is no automatic oracle, exchange, invented trade history or price-derived probability feed. NFT transfers move positions between wallets; they do not execute a sale.

## Play a market

Use an injected external wallet on Ethereum, Optimism, Base or Arbitrum, or their Sepolia testnets. The wallet needs the network's ETH for gas, creation fees and entries.

1. **Create:** choose the network, question, observation rule, dates and ranges. An optional **Oracle** receives voting power from market positions; leave it blank for position holders to retain it. Review the creation fee and confirm in your wallet. The resulting market URL can be shared.
2. **Enter:** while entry is open, choose Simple, Expressive or By range, review the exact NFT allocation and stake, then mint. Entry refunds burn the selected NFTs. Optional voting delegation is available during entry.
3. **Transfer:** select one owned NFT, enter its recipient and review the transfer. Positions remain transferable after entry closes; new entries stop at that time.
4. **Propose and attest:** record the observed result in a proposed scorecard whose range weights total 100%. Nonzero weights require circulating NFTs in that range. Eligible holders or their delegates attest using Defifa's adjusted voting weight; revocation is available while the proposal is active. Attestation power uses a snapshot before submission, so acquiring an NFT later does not confer a vote on that proposal.
5. **Ratify and claim:** once the contract's quorum, grace and timelock requirements are met, ratify the exact proposal. Ratification fulfills commitments in the same transaction. Select NFTs and review their payout, protocol-token rewards and minimum ETH return before burning them to claim.
6. **No contest:** if the native timeout is reached without a ratified scorecard, trigger no contest, then refund selected NFTs. The contract determines eligibility and timing.

Settlement has a **minimum one-day attestation grace period** and this app configures a **one-hour timelock**. A short entry/observation schedule does not shorten those waits. A proposed winner is not a guaranteed payout: the ratified weights are authoritative, and governance can fail to reach agreement.

The Oracle receives voting power and remains subject to scorecard ratification. Holders can change their voting address during entry. Each entry review shows its voting address; minting assigns that address the voting power of all existing positions in the affected tiers.

On a testnet, **Use short test schedule** sets entry to open in 2–3 minutes with 10 minutes for entry. It preserves the observation duration already entered, including applied time presets. An invalid duration shows an error without changing the dates. The form shows the resulting duration. Changing networks preserves the dates you entered. **Recently opened** keeps up to 20 market links in this browser, including confirmed creations; opening a link reads its current chain state again.

Entry and observation dates are shown separately on each market. Paginated history is pinned to its original block; **Refresh to latest** restores current action availability. Scorecard history uses at most 500 blocks per Center request, with explicit continuation when a page cannot cover the full history. A failed request never means there are no scorecards.

## SIPmath downloads

Use **Download SIPmath** in any forecast mode, or append `?format=sipmath` to the preview or individual market API. The file uses the canonical SIPmath_3_0 profile described by SIPmath 3.1: exact Metalog_1_0 curves, categorical tier lookups, reproducible HDR_2_0 streams and native audit data. Manual entries export tier categories; their curve remains reference evidence. No copula or within-range outcome is inferred. [Export semantics and compatibility evidence](docs/DESIGN.md#sipmath-export).

## Configuration

Copy `.env.example` to `.env.local` as needed. Public settings are fixed at build time.

`METALOG_MARKETS` is a comma-separated listing such as `8453:123,84532:456`. It is a curated list, not a chain index. Anyone can open a compatible market by its chain and project ID without listing it. Creation returns the shareable market URL.

Signa uses fixed `https://signa.center` / `https://api.signa.center` trust origins. Register the app origin and exact `/center/callback` URI with Signa, then set `NEXT_PUBLIC_SIGNA_ENABLED=true`. Its current connector supplies read-only Base account access. All Defifa writes require an injected external wallet; there is no Para dependency or Signa arbitrary-signing route.

RPC, IPFS pinning and gateway reads use the shared SDK's Juicebox Center service, defaulting to `https://juicebox.center`. `NEXT_PUBLIC_JBCENTER_URL` can select another Center deployment; that service must allow the site's actual origin. `NEXT_PUBLIC_SITE_URL` supplies the server request origin (production defaults to `https://metalog.money`); browser requests use their real Origin. No private keys or API secrets belong in public environment variables. Center failures remain explicit; production never falls back to other public RPC providers. Creation pins one project/collection manifest with the exact tier ranges and verifies gateway readback before review. Tier names remain onchain; Defifa generates their NFT metadata without additional pins. Receipt recovery uses the original manifest URI.

`METALOG_RPC_URLS` is a test-only map of chain IDs to server-side local HTTP Anvil nodes, for example `{"84532":"http://127.0.0.1:8545"}`. Only `localhost`, `127.0.0.1` and `::1` are allowed. An overridden chain fails closed. This setting does not change the browser or wallet's RPC: local integration tests must direct those to the same fork. Restart the server after changing it.

Defifa 2.0.1 ERC-1155 addresses (deployer, governor, voting referee, hook, hook library, tier store), minimized ABIs and runtime fingerprints are pinned in `src/lib/defifa-*`. Writes freshly verify the configured release and game invariants. Deployment identities were verified on all eight networks on 2026-11-09; this is a code-identity check, not a public-chain transaction test or a promise of RPC availability.

## Owners

| Location | Responsibility |
| --- | --- |
| `src/domain` | Distribution, exact range boundaries, allocation, definition validation |
| `src/lib/defifa*` | Pinned deployments, native Defifa calls, chain evidence and receipt effects |
| `src/lib/bendystraw.ts` | Server-side discovery reads (market list, activity, holders for the voter list); results are re-read on chain |
| `src/lib/transaction.ts` | Shared SDK execution adapter and durable transaction evidence |
| `src/lib/wallet*`, `src/providers` | One chain/RPC policy, wagmi, Query, lazy Signa and connection state |
| `src/lib/forecast.ts`, `market-data.ts` | Identical UI/API interpretation and native export |
| `src/domain/sipmath.ts`, `src/lib/sipmath*.ts` | HDR/lookup math and shared SIPmath output with audit evidence |
| `src/components`, `src/app` | Forms, SVG, routes and plain presentation |

Reference architecture: current Sticky `web/` and Homerun's Next client; SDK core 2.25.0 and connect 0.5.6. App-specific adapters use the shared SDK owners instead of copying the sibling transaction engines. [Design and mechanics](docs/DESIGN.md) records decisions and limitations.

## Checks

```sh
npm run check          # lint, typecheck, unit/adversarial tests, production build
npm run test:browser   # production server on 3020; Playwright Chromium required
npm run test:integration       # real Anvil forks of Base Sepolia and Base
npm run test:browser:lifecycle # production build + Chromium + Anvil required
```

Browser tests cover the example, sequential decimal typing, raw inputs, dragging/keyboard controls, both range layouts and their independent drafts, exact custom intervals in JSON/SIPmath, wallet chooser, recent links, the test schedule, responsive layout and query endpoints. Modeled adapter tests decode real ABIs and exercise incorrect effects, stale evidence and recovery.

Creation, entry and recovery tests pass on local forks of all eight networks. Full lifecycle adapter tests passed on local Base Sepolia and Base forks, including refunds, transfers, delegation, scorecards, claims, no-contest and recovery without resending. [Fork setup and options](test/integration/README.md). The production browser journey also passes against a Base Sepolia fork: 15 local transactions cover creation, entry, refund, NFT transfer, scorecard governance, claim and no-contest refund, including wallet network switching and mobile layout checks. No public-chain transaction or real Signa passkey ceremony has been performed during development. See the [verification boundary](docs/DESIGN.md#verification-boundary) for the distinction between deployment checks and executed lifecycle evidence.

If a wallet send becomes uncertain, preserve its saved record. Recovery checks the original hash and exact chain/account/calldata/value and verifies Defifa effects before clearing it. It never retries the send. Wrapped smart-account/Safe transactions are not a supported execution lane yet.

Range presets are starting geometry, not market forecasts. Equal probability uses quantiles of the visible reference Simple logistic Metalog and includes both overflow tails; four-decimal rounding introduces small differences in mass. Logarithmic uses signed `expm1(log(101) × (2i/count − 1))`, matching the original 21-tier layout. Count rebuilding evenly redistributes cutoffs between existing outer limits and explicitly clears fixed edges/names. Kmac 15m/1h/1d recipes retain the supplied seven names and exact intervals.

Observation templates use [Coinbase Exchange candle opens](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles) at the exact two UTC minute timestamps. Their written rules specify full source precision, missing-data handling and the ratified scorecard’s payout authority. They do not fetch prices or provide an automated oracle.

Entries lazily reconstruct original mint transactions through Center. `GET /api/markets/{chainId}/{projectId}/entries` is public, read-only and permits cross-origin GETs; it exposes no wallet or pin authority. Its `metalog.entries.v1` JSON includes canonical hook/ranges, snapshot hash, authenticated original curve/manual records, receipt/token IDs and display density computed by the domain owners. Continue with both the original `blockNumber` and `cursor`; each page checks at most four500-block windows and eight mint receipts. Coverage and incomplete history are explicit, and provider failures return503. Wrapped calls or unknown memos retain actual mint effects but do not acquire an invented curve or stake. Downloads describe original entries, not current ownership or sale prices.
