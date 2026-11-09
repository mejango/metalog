# Market page design pass (stage focus, Seurat palette)

Resources: `/Users/jango/Documents/jb/v6/evm/AGENTS.md`, `tasks/lessons.md`, `workflow/ponytail/SKILL.md`, `docs/PLAN_REFINEMENT.md`; local `AGENTS.md`, `docs/DESIGN.md`. Isolated worktree `../metalog-design` on `design/market-stage-focus` from e552516; dirty `main` checkout untouched.

- **Outcome:** Full-width market page that shows one thing at a time: the panel that matters for the current game stage, with the rest one tab away. Orange tint and palette from Seurat's *Parade de cirque*; data viz over prose.
- **Owners:** Presentation only (`src/components`, `globals.css`). No domain, chain, calldata or transaction change. Stage comes from `MarketSnapshot.stage`; crowd shares reuse `marketData` and `positionDensities`.
- **Rules kept:** No auto-switch of the open panel when a refresh changes the stage (drafts stay in view). Panels stay mounted (`hidden`) so drafts and selections survive tab changes. Square corners, input sizes and accessible names stay.
- **Verification:** `npm run check`, full browser suite desktop + mobile, screenshots per stage.
- **Recovery:** Branch only; no merge without jango.

- [x] Theme tokens, pointillist paper, full-width layout
- [x] Stage lamps (stage + schedule + countdown)
- [x] Stage-focused tabs in MarketView; lifecycle split into panels
- [x] Crowd chart (stake share, ratified payout overlay), crowd line on your chart
- [x] Forecast editor as canvas + ticket
- [x] Tests updated, check + browser suite green, screenshots reviewed

Review: `npm run check` passes; browser suite 56/56 (desktop + mobile) after updating tests for tabs (entries, timing), the collapsed positions table and the new ink color. Timing test now also asserts a stage change does not switch the open panel. One real regression caught and fixed: the positions summary shifted the ticket 0.5px on mobile while editing. Stage screenshots reviewed for entry, observation, results and complete at 1440px and iPhone 13.


# Shared Defifa SDK owners

Resources: `/Users/jango/Documents/jb/v6/evm/AGENTS.md`, `/Users/jango/Documents/jb/v6/evm/tasks/lessons.md`, `/Users/jango/Documents/jb/v6/evm/workflow/ponytail/SKILL.md`, `/Users/jango/Documents/jb/v6/evm/workflow/ponytail/README.md`, `/Users/jango/Documents/jb/v6/evm/docs/PLAN_REFINEMENT.md`; local `AGENTS.md`, `README.md`, `docs/DESIGN.md` apply. Isolated `refactor/shared-defifa-sdk` starts at2084a48; dirty parent stays untouched.

## Plan refinement
- **Objective:** Remove duplicate Defifa metadata and cumulative holdings rules from Metalog without changing its observable behavior, configured Oracle/delegate, memo, recovery or authority.
- **System fit:** Released SDK owns native payload/envelope encoders and authenticated bounded holdings. Metalog retains market verification, allocation, explicit delegation policy, receipt effects, lifecycle and JSON serialization.
- **Reuse and simplicity:** Entry wrapper supplies existing implementation, exact repeated tier IDs and explicit `defaultAttestationDelegate ?? beneficiary` to `buildDefifaPayMetadata`; cash-out wrapper delegates existing implementation/IDs to `build721CashOutMetadata`; holdings wrapper adapts `getDefifaHoldings(limit200)` output to existing decimal strings/cursor. No new UI, protocol or capability.
- **Evidence and unknowns:** SDK PR202 is merged and official core2.29.0 is installed with its verified registry tarball integrity. Existing Metalog byte/delegate/manual/curve/recovery and burned-hole/pagination fixtures establish behavior; dependency verification must use the official exact locked release rather than an unpublished preview.
- **Verification:** Add full-byte pre-migration equivalence assertions and prove the baseline before swapping owners. After official dependency release, run relevant exact-byte/receipt/holdings tests, required `npm run check` and browser suite. New SDK authentication must keep missing-token/RPC distinctions and the original pinned snapshot.
- **Resource budget:** One isolated checkout, two source adapters, narrow existing tests and exact package lock. No public-chain sends, pins or publication here; root owns review/release. Replan on a real SDK/mock protocol boundary mismatch rather than weakening authentication.

- [x] Prove full-byte and holdings baseline equivalence fixtures.
- [x] Replace local encoding/scanning bodies with SDK owners and preserve adapters.
- [x] Lock official SDK release and complete required tests/check/browser evidence.

Baseline evidence: before migration65Defifa/lifecycle/Entries tests passed with full-byte assertions for beneficiary and configured Oracle pay metadata and sorted-ID cash-out metadata. Source adapters prepared against merged SDK API; existing holdings fixture extended with exact native project owner, clone bytecode/reporters/store and pinned identity reads so after release it tests the real shared reader rather than mocking holdings. Official exact locked dependency checks remain pending.

## Review

Official core2.29.0 registry integrity matches the SDK release receipt (`sha512-1EnCA+O8V8UEKOl5Gh9hAQR63OYUAkLn4gG2VrQfAy2ueoRFxNTJmQvzJQkJd9TQMMrS9LvzCv8ZV8TOjAY2pA==`). Initial cached ETARGET was resolved using a fresh task cache after registry propagation; no preview package was used. Minimal lock changes only SDK version/tarball/integrity and passes `npm ci`. All65 relevant equivalence tests pass after migration, matching the65-test pre-migration proof. Required `npm run check` passes lint, typecheck,211unit tests and production build; all56 production desktop/mobile browser cases pass on isolated port3130. Evidence: `/tmp/metalog-sdk-owners-before.log`, `/tmp/metalog-sdk-owners-after.log`, `/tmp/metalog-sdk-owners-check.log`, `/tmp/metalog-sdk-owners-browser.log`. Dirty parent is untouched, and no public-chain sends/pins occurred. Root owns hosted CI review, merge and publication.

# Order book UI during play (2026-10-13)

Resources: `/Users/jango/Documents/jb/v6/evm/AGENTS.md`, `/Users/jango/Documents/jb/v6/evm/tasks/lessons.md`, `/Users/jango/Documents/jb/v6/evm/workflow/ponytail/SKILL.md`, `/Users/jango/Documents/jb/v6/evm/workflow/ponytail/README.md`, `/Users/jango/Documents/jb/v6/evm/docs/PLAN_REFINEMENT.md`; local `AGENTS.md`, `README.md`, `docs/DESIGN.md` apply.

## Plan refinement
- **Objective:** While a game is in play, the Market tab keeps the opening spread and adds a per-range order book (bids, asks, buy, sell, place bid, place ask) and book-implied odds. jango ruled UI only for now; the book closes at observation end. Venue (Seaport on-chain vs off-chain vs new contract) is unresolved and out of scope.
- **System fit:** Outcome is a design to judge, not executable trading. Capability: a typed `RangeBook` read owned by `src/lib/book.ts`, which returns no venue in production and a labeled sample only under `next dev`. Evidence: implied odds derive from the book plus on-chain supply and pot. Prepared action/authority: none; every order control stays disabled with "No trading venue is connected yet." Lifecycle, entry, payout and transaction owners are unaffected.
- **Reuse and simplicity:** Reuse PositionChart's second-number label for opening → book odds, the existing pip/hint/table styles and the stage owner (`STEP`/stage). One new pure owner `src/domain/book.ts` for implied odds (price x range supply / pot) so UI never computes it. No new dependency.
- **Evidence and unknowns:** DESIGN.md forbids fabricated live curves; so production shows no odds or levels, only the empty book. Implied odds assume the range takes the whole pot; weighted scorecards make it an upper-bound reading, stated in one short hint. Unknown: venue, fees, WETH, settlement.
- **Verification:** Unit test for implied odds (mid, missing side, zero pot/supply, clamp). Browser test: trading stage shows the book with disabled controls and no sample data in a production build; existing suites stay green. Screenshot the dev sample.
- **Resource budget:** One domain module + test, one book component, one lib reader, MarketView wiring and CSS. No contract, backend or chain writes. Replan if the book needs data the snapshot does not carry.

- [x] Domain implied-odds owner + unit test.
- [x] Book reader (none in production, labeled dev sample) and OrderBook component wired into Market tab during play.
- [x] Chart shows opening → book odds when the book has prices.
- [x] Browser test for production empty/disabled book; full suites; screenshots; push.

## Review

Implemented as UI only. `src/domain/book.ts` owns implied odds (3 unit tests). `src/lib/book.ts` returns no book in production and a labeled sample under `next dev`. `OrderBook` shows per-range odds, best bid/ask in USD (ETH until the price loads), depth, and place-bid/place-ask forms, all disabled with "No trading venue is connected yet." The chart reads "opening share → book odds" while in play. ETH/USD moved to `src/lib/eth-usd.ts` (one owner for the pot and book). Production build: 63 browser cases (new one asserts no sample data and disabled Buy/Sell/Review bid in play, no book during entry) and 217 unit tests pass. Venue, settlement and fees are open; nothing transacts.

# Crowd curve and smooth chance (2026-10-13)

Resources: `/Users/jango/Documents/jb/v6/evm/AGENTS.md`, `/Users/jango/Documents/jb/v6/evm/tasks/lessons.md`, `/Users/jango/Documents/jb/v6/evm/workflow/ponytail/SKILL.md`, `/Users/jango/Documents/jb/v6/evm/workflow/ponytail/README.md`, `/Users/jango/Documents/jb/v6/evm/docs/PLAN_REFINEMENT.md`; local `AGENTS.md`, `README.md`, `docs/DESIGN.md` apply.

## Plan refinement
- **Objective:** kmac's #2 and #3, approved by jango: draw the crowd's average curve (stake-weighted mixture of verified entry curves) and answer "chance at or above X" at any X from it, with one coverage line. No starting-curve change, no per-entry picker, no contract change.
- **System fit:** Evidence already exists: `metalog.entry.v1` memos carry coefficients, `readEntryHistory` verifies them against minted positions. New read-only `/crowd` route pages that owner to completion (bounded) and returns verified curve components plus minted coverage. Display only; no action or authority change.
- **Reuse and simplicity:** Reuse `readEntryHistory` (verification), `cdf`/`densityBuckets` (math). One domain owner for mixtures in `distribution.ts`. Bucket answers stay as the fallback and while the book prices ranges (both exact at edges).
- **Evidence and unknowns:** Only Metalog curve entries carry curves; manual and direct pays do not, so the note states coverage of minted positions. Mint-time weights ignore later refunds and transfers; the bars stay the exact current counts. Cost bound: 25 pages x 8 entries.
- **Verification:** Unit tests for mixture CDF/buckets (single curve equals itself, weights, two-curve average). Route test via existing entries fixtures if cheap; browser suite green; screenshot on dev:live.
- **Resource budget:** One route, one domain addition, chart wiring. Replan if Center rate limits make the route unreliable.

- [x] Mixture math + tests.
- [x] `/crowd` route.
- [x] Chart: crowd line, continuous threshold, coverage note.
- [x] Suites, screenshots, push.

## Review

Replanned once: browser paging of `/entries` scanned 500 blocks per request (about 20 x 9s for a 1-day Base window), so the crowd moved to a server route (`/crowd`, `readCrowd`) that scans the window in parallel 500-block windows (3 at a time, Center limit), verifies each entry like the history feed and caches closed games permanently, open games for a minute. Verified against a Base fork (keyed RPC; localhost Center hits the public limit): game 27 returns 1 verified curve entry covering 100 of 100 positions in about 10s. Chart draws the crowd curve, answers at any value (snaps to edges while the book prices ranges), shades the asked side and names the edge on the axis. Also renamed the order book's Pays to its condition. 222 unit and 63 browser cases pass on a production build. dev:live proxies `/api/markets` to production, so the crowd curve shows there only after this deploys.

Follow-up (jango): memo curves can be shaped without paying for them, so the crowd curve is now a least-squares metalog fit through the crowd's cumulative position counts at each range edge (`curveFromPositions`). Answers between edges use `smoothShareAtOrAbove`, exact at every edge. The `/crowd` route, `readCrowd` and mixture math are deleted. The resulting curve is the same fit after your order's positions are added.

## Opportunity at a glance (kmac's three questions)

- Keep the swap-widget answer only: where (curve), how much (Buy), what you get. `orderReturns` in `domain/book.ts` beside `payoutPerPosition`: per range, your positions times the pot after your order shared by that range's positions, assuming the range takes the pot; expectation weighted by your curve. Shown as one line under Buy (best case, your curve expects) and an "If it ends here" column, green above your stake, rust below. Skipped: live price model, edge ranking, steps chrome. Unit test for the math, browser assertion on preview.
- Order book follow-up: each ask shows what it wins if its range pays (`wins Nx`), a Your curve column, and rows tinted cheap (green) or dear (rust) when your curve's chance times the multiple beats or misses break-even. ForecastEditor's `below` takes a function to hand the book your curve's chances.

## Live outcome marker (kmac)

- While a preset market plays out, the chart marks where the outcome stands now: Coinbase start-candle open (the rule's observation start) against the latest ticker, `useLiveOutcome` in `lib/live-outcome.ts`, product parsed from the preset source (`presetProduct`). Label: "Now -3.48% | 1 position here". Custom sources show nothing. Estimate only; the ratified result settles. Unit test for parsing and the change; browser test with mocked Coinbase.

## Results tab from kmac's notes

- Propose is the job when nothing is proposed: the form leads the tab, open, above "Load more results"; preset markets offer "Use the observed result" from the rule's own end candle.
- The chart's marker reads the end candle once observation ends ("Ended"), so it never shows a price after the time that matters. Mode comes from the chain's stage, not the wall clock.
- Each result shows "Attestations X of Y needed": Y is the governor's snapshotted quorum, recomputed by `scorecardQuorum` (base `quorum(gameId)`, frozen while scoring, plus headroom x largest share squared). Verified against Base game 28's stored snapshot (19,999,999,999 for a 100% result vs the 10.5e9 base). A disabled Ratify says why: attestations not open, weight missing, or the timelock's earliest end.
- Result IDs shortened in the summary; the full ID stays in the details.
- Who can attest: `readResultVoters` (positions by ID, owners, per-range delegates, BWA weight at submission - 1, attested) behind `/voters`, listed per result on open. Verified on Base game 28: four voters, attested sum equals the governor's count; together they hold 19,999,999,987 against a 19,999,999,999 quorum, so the page says the result cannot reach quorum (contract headroom truncation allowance, fixed in a defifa PR).
- Order book: "If runner-up" beside "If it wins" before any proposal, a 20% share (`RUNNER_UP_WEIGHT`).

# Defifa 2.0 ERC-1155 games (2026-11-09)

Resources: `/Users/jango/Documents/jb/v6/evm/AGENTS.md`, `/Users/jango/Documents/jb/v6/evm/tasks/lessons.md`, `/Users/jango/Documents/jb/v6/evm/workflow/ponytail/SKILL.md`, `/Users/jango/Documents/jb/v6/evm/workflow/ponytail/README.md`, `/Users/jango/Documents/jb/v6/evm/docs/PLAN_REFINEMENT.md`; local `AGENTS.md`, `README.md` apply.

## Plan refinement
- **Objective:** jango: metalog uses the newly deployed Defifa 2.0.1 ERC-1155 game (Defifa1155Deployer/Governor/Hook, DefifaVotingReferee, DefifaTiersHookStore), and Bendystraw (reindexed with Defifa 2.0 tables) where the chain cannot enumerate.
- **System fit:** Chain stays the authority for every market read, action and receipt; Bendystraw only discovers (market list, activity rows, holders for the voter list), and every discovered item is re-read on chain before it is shown as verified. 1.0.2 (721) games are deprecated upstream and stop loading here; no dual support.
- **Contract changes the client follows:**
  - launch: `attestationStartTime/GracePeriod` removed, `referee` = DefifaVotingReferee and `refereeData = abi.encode(resolvesAt, 1 day)` added.
  - positions are per-range balances (token ID = tier ID): pay metadata `(delegate, uint16[] tierIds, uint256[] counts)`, holdings via `balanceOfBatch`, transfers `safeTransferFrom(from,to,id,amount,data)`, cash out metadata `(ids, amounts)`, receipts read `TransferSingle/TransferBatch`.
  - results: submit/attest/revoke on the referee; a new Forward step (referee SUCCEEDED → governor queue) and Ratify on the governor after its timelock. Quorum per result is `referee.quorumOf(gameId, scorecardId)`; `scorecardQuorum` and its test are deleted.
- **Reuse and simplicity:** one deployment JSON regenerated from the 2.0.1 artifacts (fingerprints checked on all eight chains); ABIs from the same artifacts. Inventory becomes one batched read, so position paging and token-ID selection go; the UI picks counts per range. Activity returns from Bendystraw; the unused paged entry-history scan is deleted (single-receipt verification stays).
- **Evidence and unknowns:** no 1155 game exists yet (Bendystraw totalCount 0); verify with a launch + pay + cash-out flow on a Base fork (lifecycle fork suite) and live reads of the deployed contracts. Bendystraw is queried keyless from the server.
- **Verification:** unit + browser suites, lifecycle fork suite against Base, fingerprint check on all chains, screenshot on dev.
- **Resource budget:** adapter rewrite in `lib/defifa*.ts`, `activity.ts`, `entries.ts`, positions UI in `MarketLifecycle.tsx`; no new dependency, no SDK change (the SDK has no 1155 helpers; pay/cash-out metadata are built with its generic resolver). Replan if the fork shows the referee flow needs more than one new action.

- [x] Deployment JSON + ABIs regenerated and fingerprint-checked on 8 chains.
- [x] Launch, pay, inventory, transfer, delegate, cash out on 1155.
- [x] Referee results flow: submit, attest, revoke, forward, ratify; quorumOf; voters via Bendystraw holders.
- [x] Activity from Bendystraw, unhidden; entry-history scan removed.
- [x] Market list from Bendystraw.
- [x] Suites, fork lifecycle, push.

## Review

- Pins regenerated from the 2.0.1 records: every chain's runtime (deployer, governor, referee, hook, hook library) hashes the same with compiler immutable offsets zeroed, and equals the release record. Store is DefifaTiersHookStore.
- Launch passes `referee` + `refereeData (resolvesAt, 1 day)`; pay and cash-out metadata are `(delegate, ids, counts)` and `(ids, amounts)` keyed to the 1155 code origin; receipts read TransferSingle/TransferBatch. Positions are per-range balances (one `balanceOfBatch`), so token paging, `getDefifaHoldings` and token-ID selection are gone; the panel picks burn counts per range and transfers send a count.
- Results: referee submit/attest/revoke, a "Queue for ratification" step (`forwardScorecardFor`), ratify on the governor at `scorecardSubmittedAtOf + timelock`. Quorum is `referee.quorumOf`; `scorecardQuorum` and its test are deleted. The #153 unreachability no longer applies: the 2.0 referee caps quorum at 75% of max weight.
- Bendystraw (keyless, server only): Activity is back (mints + cash-out events), voter holders, and market discovery beside `METALOG_MARKETS`. The paged entry-history scan is deleted; one receipt is still verified on open.
- 1.0.2 (721) games no longer load here.
- Evidence: 222 unit, 75 browser (1 skipped), fork integration on Base Sepolia (create, refund, transfer, delegate, propose, attest, revoke, queue, ratify, claim, no-contest refund, custom ranges), and the browser lifecycle on the same fork, 16 transactions. The fork browser test had not run since the tab redesign; its locators (tabpanel role, tab switching, nested summaries) were fixed along the way. Production shows these after deploy; no 1155 game exists yet.

## Lower price floor on 1155 (2026-11-09)

- jango: with 1155, lower the minimum to 0.00001 ETH. The 0.0001 floor and 160-position cap were 721 gas limits (about 47k gas per minted NFT). Measured on a Base Sepolia fork, an 1155 entry costs about 205k base gas plus about 182k per range touched, the same for 13 positions or 1,000,000 (2.80M vs 2.56M on 13 ranges). MIN_NEW_UNIT_PRICE_WEI is now 1e13; MAX_POSITIONS is 1,000,000 (a stake-typo bound, 10 ETH at the floor). MAX_RECORDED_POSITIONS is gone, since no 721 entries are verified anymore.
- Found along the way: the SDK's gasWithHeadroom doubles the estimate, so any entry across more than about 42 ranges (61-range entry is about 11.3M) asked for more than the 2^24 per-transaction cap and could not be sent. The doubled limit is now clamped at TRANSACTION_GAS_CAP when the estimate fits. Ponytail note: the clamp belongs in the SDK's gasWithHeadroom.
- Gates: 224 unit tests, the browser suite, and the fork gas test (count-independence; the scaled 61-range estimate fits the cap).
