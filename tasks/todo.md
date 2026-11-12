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

- jango: with 1155, lower the minimum to 0.00001 ETH. The 0.0001 floor and 160-position cap were 721 gas limits (about 47k gas per minted NFT). Measured on a Base Sepolia fork, an 1155 entry costs about 205k base gas plus about 182k per range touched, the same for 13 positions or 1,000,000 (2.80M vs 2.56M on 13 ranges). MIN_NEW_UNIT_PRICE_WEI is now 1e13; MAX_POSITIONS is 1,000,000,000 per jango (a stake-typo bound, 10,000 ETH at the floor; one range still caps at its 999,999,999 supply). MAX_RECORDED_POSITIONS is gone, since no 721 entries are verified anymore.
- Found along the way: the SDK's gasWithHeadroom doubles the estimate, so any entry across more than about 42 ranges (61-range entry is about 11.3M) asked for more than the 2^24 per-transaction cap and could not be sent. The doubled limit is now clamped at TRANSACTION_GAS_CAP when the estimate fits. Ponytail note: the clamp belongs in the SDK's gasWithHeadroom.
- Gates: 224 unit tests, the browser suite, and the fork gas test (count-independence; the scaled 61-range estimate fits the cap).

# State machines wave (2026-11-09)

Resources: `/Users/jango/Documents/jb/v6/evm/AGENTS.md`, `/Users/jango/Documents/jb/v6/evm/workflow/ponytail/SKILL.md`, `/Users/jango/Documents/jb/v6/evm/docs/PLAN_REFINEMENT.md`; local `AGENTS.md`, `README.md`. Discovery: scratchpad `sm/metalog.md`. Branch `state-machines-2026-11-09` from origin/main in `.worktrees/sm-metalog`.

## Plan refinement
- **Objective:** Make metalog's implicit action and feed machines explicit and fix their verified bugs (metalog-3 status copy during a send, metalog-4 activity reset by the poll) without changing transaction authority, storage formats or receipt checks.
- **System fit:** Transactions provider stays the one send/recovery owner (SDK adoption later replaces it, metalog-1/2/17). Components keep calling prepare then `execute*`; one hook owns the prepare-to-handoff phase. Activity keeps its API and cursors; only its query identity changes.
- **Reuse and simplicity:** One `usePreparedWrite` hook replaces three copies (refactor commit, then fix commit). Activity reuses React Query's own refetch of loaded pages. No new dependency, no SDK upgrade.
- **Evidence and unknowns:** Code reading verified both bugs; regression tests prove them on the old code first. Lifecycle fork suite needs Anvil and upstream Center RPC; run it if reachable, else report.
- **Verification:** New browser regression tests (activity keeps pages across a market refresh; no preparation copy while the provider is reviewing), `npm run check`, `npm run test:browser`, lifecycle fork when reachable.
- **Resource budget:** One worktree, cloned node_modules, suites one at a time. Replan if the hook cannot keep CreateMarket's form-error behavior identical.

- [x] UNION metalog-3: `usePreparedWrite` for ForecastEditor, MarketLifecycle, CreateMarket
- [x] FIX metalog-3: preparation copy ends at the hand-off (test first)
- [x] FIX metalog-4: activity feed keeps loaded pages across snapshots (test first)
- [x] Gates, PR (no merge)

Review: both regression tests failed on the old code (lifecycle fork: "Preparing market…" shown with the review dialog open; activity.spec: older page gone after a market refresh) and pass after the fixes. metalog-1/2/17 wait for SDK 6.x adoption (writeHold, useReviewedRun); metalog-2 has two verified recovery dead ends that adoption closes.

Codex pass 1 (Medium): a page fetch started in the same commit as the snapshot reread cancelled it (TanStack `cancelRefetch`), so new head activity never appeared while more pages remained. Automatic paging now waits until the loaded pages are read at the current snapshot block. Test: activity.spec "a market refresh finishes before the feed reads further back", failed on the old code, passes now.

# State machines wave 3: SDK write hold and Signa connect (2026-11-09)

Resources: as above, plus scratchpad `sm/BRIEF3.md` and `sm/sdk.md`. Branch `state-machines-3-2026-11-09` stacked on `state-machines-2026-11-09`; SDK core 6.0.0 tarball and `@me.jango/signa` 0.4.0 installed with `--no-save`.

## Plan refinement
- **Objective:** Metalog sends and recovers exactly like the standard clients: `createWriteHold` + `useReviewedRun`, no legacy journal, no metalog-only SDK knobs. Closes metalog-1, metalog-2 (both dead ends) and metalog-17.
- **System fit:** Core owns review, simulation, gas (`gasWithHeadroom`, no local clamp), the hold, exits and receipts. Metalog keeps calldata, `reverify`, receipt effects (`verifyReceipt`) and its intents: one hold per market, one per creation definition. Connect moves to Signa.
- **Reuse and simplicity:** The old journal keys are dropped with no importer. One status card, one review dialog over the SDK model, the SDK's held notice per chain.
- **Verification:** Hold scope and exit tests (failed on the old module), `npm run check`, browser suite, lifecycle fork.

- [x] Scope and dead-end tests first (market A held, B and other creations proceed; no-hash exit; cancelled replacement exit)
- [x] Transactions provider on useReviewedRun; components send under intents; review dialog renders the model
- [x] Effects after settle: verifyReceipt, then refresh reads and Recently opened, on the direct and the held path
- [x] Delete the journal, legacy recovery verifier and their tests; port fork integration to sendReviewed
- [x] Connect from @me.jango/signa
- [x] Gates, draft PR (no merge)

Review: the hold tests failed on the old module and pass. `npm run check` (174 unit), the browser suite (73 passed, 1 skipped), fork integration on Base Sepolia (5) and the lifecycle fork (17 transactions) pass against the tarball. The lifecycle fork caught one real gap, which is fixed: the run showed confirmed before the action's receipt checks finished, and a click in between was dropped silently. The action now stays disabled until they finish. A lost wallet reply stays held with no hash until the wallet's hash is attached; the hold does not find it by nonce alone. SDK gaps: Defifa owners are 721-only; `useHeldWrites` has no `onSettled`.

Published SDK: package.json now pins `@bananapus/nana-sdk-core` 6.1.0 and `@me.jango/signa` 0.5.0 (the branch imports `review/react` and Signa, which 2.29.0 and the old pins lacked) and drops the unused `@bananapus/nana-sdk-connect`. Lockfile integrity matches `npm view`; after `npm ci`, `npm run check` (174 unit) and the browser suite (75 passed, 1 skipped) pass.

# Wave 3 Codex pass 1 fixes (2026-11-09)

Resources: as above; report scratchpad `sm/codex/metalog3-pass1.md`. Finding 1 (import legacy keys) is dismissed by jango's ruling: metalog has no legacy code.

## Plan refinement
- **Objective:** A mined write is its outcome: no post-receipt read failure re-enables a send, a still-confirming write hands the form back, every background hold (confirming too) is shown, and a lost wallet reply can be settled from the hash the wallet shows.
- **System fit:** The Transactions provider stays the one owner of what a run means for its form; the SDK hold stays the one authority on sends, repeats (one hold per intent) and settlement. jbm/revnet: the hold's settlement is the outcome (no app effect gate); revnet lists every held state; revnet's markee recovery attaches a found hash through `handle.attachHash`.
- **Reuse and simplicity:** Refactor first: move the run's outcome for its form into one function in `src/lib/transaction.ts` (no behavior change), then fix on it. Reuse the SDK's `HeldWritesNotice`, `attachHash` and origin/main's hash-input labels. No new dependency.
- **Evidence and unknowns:** Code reading of SDK 6.1.0 `useReviewedRun` (acknowledges a shown done; resolves `receipt` after its in-place follow; `busy` stays true while confirming). Browser tests seed real SDK hold records against a plain local Anvil.
- **Verification:** Unit tests on the outcome function (#2, #5) and browser tests on reload visibility (#4) and hash recovery (#3), each failing first; `npm run check`; `npm run test:browser`.
- **Resource budget:** One worktree, suites one at a time; replan if seeding hold records across Node and the browser does not round-trip.

- [x] REFACTOR: one function for a run's outcome
- [x] FIX #2: a mined write's failed effect check reports, never re-enables its send
- [x] FIX #5: a still-confirming write hands back the form; later settlement applies separately
- [x] FIX #4: background holds show while confirming
- [x] FIX #3: attach the wallet's hash to a no-hash hold
- [ ] Gates, push (no merge)

Review: each new test failed on the code before its fix. Unit (`test/transaction.test.ts`, "a run's outcome for its form"): a failed effect check or receipt read rejected the run (#2); a still-confirming run never returned (#5). Browser (`test/browser/held-writes.spec.ts`, real SDK hold records against a plain local Anvil): a confirming write found after a reload showed nothing (#4); a lost reply offered no hash input (#3). Standard practice: jbm and revnet treat the hold's settlement as the outcome with no app effect gate; revnet lists every held state; revnet's markee recovery attaches a found hash with `handle.attachHash`. The receipt effect check stays as a report in the status card; a held write settled after a reload applies the same effects without it (no reviewed request to check against). `npm run check` (177 unit), the browser suite (79 passed, 1 skipped) and the lifecycle fork (rerun alone after one local Anvil ECONNRESET under load) pass.

Follow-up ruling (jango via coordinator): no app-level effect check after a write mines, as in jbm and revnet. `verifyReceipt`, the launch and lifecycle receipt checks and the call decoder leave production code for `test/integration/effects.ts` (`checkReceiptEffects`, `verifyLifecycleReceipt`, `decodeDefifaTransactionCall`); unit and fork tests use them. Entry evidence keeps `verifyRecordedEntry`, which the entries route still uses. `runOutcome` takes no prepared write; a failed receipt read still reports in the status card. The entries browser test now scrolls to the feed before counting older activity: its mobile run failed on the pushed head too, since older pages load only as the list end nears the screen.
Gates: `npm run check` (177 unit), the browser suite (79 passed, 1 skipped) and fork integration (9 passed).

Codex pass 2 (accepted the legacy and effect-check rulings): (1) two forms could hand writes to the one runner and the later review replaced the earlier dialog; the provider now claims the handoff synchronously (`exclusive`) and refuses a second with the SDK's busy line. (2) A write that mined while away settled inside the held list before the follow effect listed it; successes the held views carry now apply too, deduplicated by chain and hash. (3) A handed-back write's later receipt now completes the form that sent it, unless that form started another operation since. Tests: unit "refuses a second handoff…", "completes the submitting form with a delayed receipt…"; browser "a creation that mined while away opens its market and joins Recently opened" (a stand-in deployer on local Anvil emits LaunchGame). Gates: `npm run check` (179 unit), browser suite (81 passed, 1 skipped).

Codex pass 3: (1) a refused retry replaced the run whose `ended()` carried the form's completion, and bumped the form's operation, so a delayed transfer never closed its form. Completion now follows the write's own hold reservation (`heldSuccess`, acknowledged once its form completes), and only a newer write the form sent supersedes it. Test: unit "completes the form that sent a handed-back write once its hold settles, through a refused retry" (real SDK hold and send gate; failed on the previous `runOutcome`). The React `useReviewedRun` hook itself cannot mount in this repo's Node test environment; the fix no longer depends on its run. (2) A settled write's receipt read could fail once and the creation result was dropped; `settledReceipt` now reads again until it reads, reporting each failure. Test: browser "a creation that mined while away still opens its market when the receipt reads after it settled fail for a while". Gates: `npm run check` (178 unit), browser suite (83 passed, 1 skipped).

Codex pass 4: both bugs came from completing the form by polling the hold's latest settlement. Refactor first: the form's run logic moved from `usePreparedWrite` into `formRuns` (no behavior change), so its interleavings run in unit tests against the real SDK hold and `sendReviewed`. (a) `heldSuccess` takes the settlement tagged with its own reservation when the hold settles it, from the hold's event (`subscribe`, emitted before anything acknowledges it) or its own `followHeldWrite` read, the way the SDK's own `followSent` scopes by reservation; it no longer re-reads `settlementOf`. Test: "completes the form from its own settlement after another reader acknowledged it and a new reservation replaced it". (b) Each form has a generation that the original's settlement bumps at that moment (`onSuccess` → `form.complete`); a send begun before it is dropped after `prepare()` and at the runner's last gate (`assertWriteState` → `refuseStale`, a quiet cancel). Tests: "drops a retry still preparing when the original confirms", "drops a retry already past preparation when the original confirms before its wallet opens" (the hold refuses a retry while the original is held, so this window is before its hold check). Each failed first (no completion; a second `sendTransaction`). Gates: `npm run check` (181 unit), browser suite (83 passed, 1 skipped).

Codex pass 5: (1) the success bumped the form's generation, but the draft stayed sendable until the app's receipt read finished, so a retry started in that window sent a second transfer. `formRuns` now closes the form when the success is captured (`complete`, before any receipt read): no run starts until `later` finishes, and `succeeded` resets the draft at once (the lifecycle form's row action and selection). `runOutcome` reports a failed effect apply and still completes the form, so the form can't stay closed forever. Test: "refuses a retry started after the original settled while the app still reads its receipt" (it failed first with a second `sendTransaction`). (2) Cross-tab settlement loss when the namespace is reused is assigned to SDK #296 (settlement per reservation); there is no metalog workaround. Gates: `npm run check` (182 unit), browser suite (83 passed, 1 skipped).

SDK #296 (per-reservation settlement, head b66b9e6, tested from its local tarball; the dependency bump comes with its publish): `heldSuccess` and its subscribe capture are gone. `heldWrite` follows the write's own reservation (`followHeldWrite({ reservation })`) and reads its saved settlement (`settlementOf(reservation)`), which holds even after a later reservation of the market replaced it, in this tab or another. The form asks that same saved settlement at each check (run start, after `prepare()`, at the last gate before the wallet), so a success that another reader or tab acknowledged before this tab's follow looked still closes the form. Test: "completes its form after another tab settled, acknowledged and replaced it while this tab slept" (two isolated SDK storage instances sharing durable storage, with queued storage events; failed on the previous capture). Gates against the tarball: `npm run check` (183 unit), browser suite (83 passed, 1 skipped).


# Form writes on core's useReviewedRun (pass 7)

Resources: `/Users/jango/Documents/jb/v6/evm/AGENTS.md`, `/Users/jango/Documents/jb/v6/evm/tasks/lessons.md`, `/Users/jango/Documents/jb/v6/evm/workflow/ponytail/SKILL.md`, `/Users/jango/Documents/jb/v6/evm/docs/PLAN_REFINEMENT.md`; local `AGENTS.md`, `docs/DESIGN.md`. Worktree `.worktrees/sm-metalog`, branch `state-machines-3-2026-11-09`.

- **Outcome:** a form completes when, and only when, its own write succeeds, however that write settles (in the run, still confirming, lost reply recovered by hash), across account switches; no local state can block later forms.
- **System fit:** revnet's practice: each form owns a `useReviewedRun`; the run follows its own held step and shows `done` when it settles. Core's `createReviewQueue` serializes reviews (replaces `exclusive`). Provider keeps the review dialog, held-write notices with hash recovery, and receipt effects (one memoized `settle` per hash).
- **Deleted:** `formRuns`, `runOutcome`, `heldWrite`/`HandedBack`, `SubmittingForm`, `refuseStale`, `exclusive`, the provider's single runner.
- **Kept local (SDK gap):** a run refused by a hold the form did not make must not start, because core's run follows whatever its intent holds after any failure and would complete the wrong form. The hook checks the hold before the run, and drops its binding on a `WriteHeldError` race. Also a per-hook `completing` gate while its receipt effects apply.
- **Verification:** failing-first pass 7 regression (account switch, newer write completes, older recovered, next submit runs); pass 5/6 regressions against the hook; `npm run check`, `test:browser`, fork lifecycle suite.
- **Recovery:** branch only; no merge.

- [x] Pass 7 regression failing on the current layer
- [x] Hook + provider migration, local layer deleted
- [x] Pass 5/6/7 regressions on the hook
- [x] check, browser, fork suites; commit, push

Review: the pass 7 regression failed on `formRuns` (the next submission never prepared). Forms now run through their own `useReviewedRun` (`src/lib/form-write.ts`), and reviews go through core's `createReviewQueue`. The local layer is deleted. The remaining local logic is a hold check before the run, because core's run adopts whatever its intent holds after a refused run, plus a per-form completing gate. Regressions for passes 5, 6 and 7 run against the hook, and each guard was mutation-checked. `npm run check` (179 tests), `test:browser` (83 passed, 1 skipped) and the fork lifecycle suite all pass.

## SDK 6.3.0 adoption (pass 8)

- [x] Pass 8 regression (two forms queued on one market, the transfer's lost reply recovered and acknowledged by another reader, the retry) failed on 6.2.0 with the local guards: two sends.
- [x] Bumped `@bananapus/nana-sdk-core` to 6.3.0 at an exact version. Deleted the pre-run hold check, the `WriteHeldError` claim drop, the owner/closing gate and the `active` ref. Core's follow rules and own-success gate replace them.
- [x] Regressions for passes 5 through 8 run through the SDK path with `lapsingLocksForTests` installed as `navigator.locks`.

Review: two local lines remain, each needed by an SDK-path test that fails without it. `completing` keeps the form busy while its shown-done success applies its receipt; core already counts that write as shown, so a new run would send again. The `completed` generation drops a retry whose preparation, which happens outside core's run, began before its write completed. `npm run check` (180 tests), `test:browser` (83 passed, 1 skipped) and the fork lifecycle suite pass on Node 22.23.4.


# 2026-11-12: Adopt Node 26.13.1

## Plan refinement
- **Objective:** Move metalog's configured build and application runtime to the requested Node26.13.1 security release without changing application behavior or dependency versions.
- **System fit:** Docker owns the hosted Node image and package engines describe the local runtime. Existing wallet, SDK and protocol authority flows remain unchanged; root coordinates delivery and hosting verification.
- **Reuse and simplicity:** Update existing Docker stages and engine metadata, matching the package-lock root metadata and active setup instructions. Reuse existing checks, with no new abstraction or dependency churn.
- **Evidence and unknowns:** Fresh main was inspected in an isolated worktree; there is no tracked GitHub Actions workflow. Official Node26.13.1 security release and local verified binary are available; remote Docker tag must be verified before delivery. Existing engine compatibility ranges are not proof of the hosted runtime.
- **Verification:** Validate exact pins and lockfile dependency parity, run git diff --check and the app's existing npm check/build under Node26.13.1; Metalog also uses the existing browser suite. Report image/platform verification separately from local application checks.
- **Resource budget:** Prepare independent lightweight checks now, serialize expensive local checks with root's coordinated slot, and avoid new CI scaffolding for this narrow maintenance change. Replan if runtime compatibility fails; preserve existing test deadlines.

- [x] Inventory current main, instructions and runtime owners.
- [x] Update runtime pins and active setup documentation.
- [ ] Validate dependencies unchanged and run existing app checks.
- [ ] Open reviewable PR and report exact head and verification.

## Review
Pending implementation and checks.

Runtime pin inventory resolved: official Node26.13.1 Alpine multiarch index sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 verified from registry2026-11-12T12:13:46UTC. Both Docker stages pin this index; local .nvmrc selects26.13.1 and the existing minimum-engine style now starts at26.13.1. No independently pinned npm version exists, so validation uses bundled npm11.20.0.

Exact-lock npm ci completed successfully with Node26.13.1 and bundled npm11.20.0. Post-install comparison confirms no dependency lock entries changed. Independent runtime-diff review found no actionable issues. Full application checks are awaiting the coordinated local resource slot; no GitHub Actions workflow exists in this repository.
