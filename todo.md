# Forge World RPG — Upgrade TODO

**Status:** P0–P3 and core P5 implementation are in place. P4 external-corpus work is excluded. Offline acceptance, lorebook editing, canonical IndexedDB transfer, and OpenRouter opening/travel pass on isolated data. `npm.cmd run doctor` passes 130 tests, typechecks, format checks, and builds. Actor-bound lore is scoped to the selected NPC, except for discoveries already found; undiscovered candidates use per-run opaque handles. The latest Gemini opening failed, and one verbose suggested action plus retry hit output truncation; the P5 provider gate remains open.
**Plan:** [upgrade_implementation_plan.md](upgrade_implementation_plan.md)  
**Repo baseline:** `master`, Git tree `e83c46b7042e979d87dfc634c023e3bad754db29` (reviewed 2026-10-12)

This checklist is intended for small, independently testable Codex tasks. **Do not mark complete without behavior-based tests and evidence.** `P0` items block lorebook rollout. Preserve normal games without lorebooks and keep one narrator + authoritative engine + local SQLite.

## P0 — Baseline and regression safety

- [x] **UP-001** Re-read project contracts and traced the active path. Domain changes cross `shared/types.ts`, `shared/engine.ts`, `shared/validation.ts`, and both save/template readers. Runtime writes remain in `server/db.ts` + `server/turn.ts`; legacy `src/turn.ts` is retained. Opening commits a narrator message/revision but must not change world/effects. SQLite remains schema v1 at baseline.
- [x] **UP-002** Baseline `npm.cmd run doctor` passes after formatting the two supplied planning documents. 106 tests pass; client/server builds pass. Initial format failure is recorded in `.audit/upgrade-baseline.json`. Real-provider checks are not part of this baseline.
- [x] **UP-003** Added `tests/fixtures/upgrade-legacy.json`, `tests/fixtures/upgrade-ragnarok.json`, and `scripts/upgrade-baseline.mjs`. `node scripts/upgrade-baseline.mjs` captures 20-action offline input assembly with network disabled. Ragnarok input p50/p95 is 9,802/10,229 characters and includes all 7 NPCs. Actual billed tokens/provider latency remain unverified.
- [x] **UP-004** Added `tests/upgrade-baseline.test.mjs` against the real backend run lifecycle with offline provider responses. Opening preserves world/effects, choices preserves state/revision/history, and a no-lore turn applies effects exactly once across close/reopen and request retry. `node --test tests/upgrade-baseline.test.mjs` passes. Existing server/save tests cover stale revisions, atomic rollback and v1 imports.

## P1 — World identity, presence and prompt budget (blocks P2)

- [x] **UP-101** Add optional stable `locationId` and validated movement proposals. Legacy saves remain readable; unknown or blocked destinations cannot commit.
- [x] **UP-102** Resolve location IDs and aliases with ambiguity handling and no-lore fallback. Regression tests cover repeatable resolution and ambiguous aliases.
- [x] **UP-103** Resolve NPC presence from location links and committed overrides. Location-aware sessions include only local NPCs; legacy no-lore games remain playable.
- [x] **UP-104** Scope NPC history and memory retrieval by audience before applying result limits. Player transcript pages also filter hidden messages before pagination. Tests cover player, NPC, and legacy messages.
- [x] **UP-105** Bound core, player, world, NPC, memory, summary, lore, and history context sections. An oversized mandatory context fails without mutation.
- [x] **UP-106** Record context and token estimates, selected lore IDs, and optional omissions. No prompts or credentials enter logs.
- [x] **UP-107** Cover travel, denied transitions, failed runs, replay, and restart. Invalid movement leaves location and revision unchanged.
- [x] **UP-108** Project only validated `allowed` movement candidates into mapped world state. The server's destination wins over narrator fields. OpenRouter browser travel reached `loc:morroc`; one verbose suggested action hit the repair output limit, while a concise natural action committed.
- [x] **P1 GATE** Offline acceptance proves traversal and prompt bounds. Browser and `/world` readback show the committed Morroc location and local NPCs. Final doctor passes.

## P2 — Lorebook MVP (first usable feature)

- [x] **UP-201** Added typed lore entries, links, provenance/visibility, exact pack refs and strict `fworld-lorebook` v1 parsing. `tests/upgrade-domain.test.mjs` passes all 9 cases, including unsafe IDs/prose, broken links and cyclic parents. Runtime/API validation passes in P2 acceptance.
- [x] **UP-202** Added sequential SQLite v1 → v2 migration, immutable pack tables, scoped FTS5 and forward/reverse link indexes. File-backed migration, close/reopen, staged v1 restore, v2 backup round-trip, and HTTP backup/restore pass in acceptance.
- [x] **UP-203** Added bounded transactional JSON pack import, dry-run and immutable version conflict checks. Storage tests cover idempotency, rollback and public visibility. Actual temporary-DB import of the original 21-entry pack passes.
- [x] **UP-204** Add paginated APIs for packs, entries, and links, plus bounded retrieval preview. Player endpoints exclude private entries.
- [x] **UP-205** Retrieve location context and action-matched lore with bounded ranking. Fixed natural-language queries select their expected lore within the first five prompt entries.
- [x] **UP-206** Pin exact pack versions to games and sessions. Missing versions fail explicitly.
- [x] **UP-207** Add editor import, dry-run, binding, search, and retrieval preview. Isolated browser smoke uploaded and published the original pack, searched entries, saved/reloaded an exact pin, and previewed Morroc-local retrieval.
- [x] **UP-208** Add the original 21-entry Prontera, Morroc, Market, Pyramid, and Sograt pack under CC0-1.0.
- [x] **UP-209** Preserve v1 readers and add lore-bound save v2 with exact dependency digests. Round-trip, missing-pack, and digest-mismatch tests pass.
- [x] **P2 GATE** Scripted HTTP acceptance covers local NPCs and backup/save restore. The browser imported and pinned lore, started the game, opened the scene, traveled to Morroc, and displayed Piri, Nima, and Sava. IndexedDB transfer/read-back passed on an isolated fixture with 1 game, 1 session, and 1 message; the old store remained intact.

## P3 — Discovery and long-term memory

- [x] **UP-301** Add typed discovery and knowledge effects. The engine validates reveals and rejects unauthorized state changes.
- [x] **UP-302** Store idempotent committed-range summaries outside the turn critical path. Summary failures do not block gameplay.
- [x] **UP-303** Assemble scoped facts, summaries, and recent history. A 102-turn replay recalls an early committed event within bounded context.
- [x] **UP-304** Test private fact and NPC dialogue isolation, plus summaries that cannot change canonical world state.
- [x] **P3 GATE** The isolated 102-turn replay measured p50/p95/max latency of 39.01/48.24/67.79 ms. Prompt context p95/max was 11,172/11,195 characters, below 24,000.

## P4 — Large external corpus (optional after P2)

- [x] **UP-401 — SKIPPED by user scope.** External corpus import CLI is not implemented. Small validated lorebook JSON import remains part of UP-203.
- [x] **UP-402 — SKIPPED by user scope.** External corpus staging/streaming/deduplication pipeline is not implemented.
- [x] **UP-403** Keep encyclopedia entities separate from playable NPCs and items. Only explicit allowlisted mappings connect them.
- [x] **UP-404 — SKIPPED by user scope.** 10k/50k/100k external corpus benchmarks are not implemented.

## P5 — UX and optimization

- [x] **UP-501** Make suggested choices optional from zero to three without a second request. Empty suggestions preserve freeform chat.
- [x] **UP-502** Measure fixed-script retrieval, budgets, and proposals. Catalog and runtime prompt recall@5 both reached 20/20. Twenty question turns changed no world state, and invalid proposal runs were zero. Runtime prompt context was p95 11,172 characters, max 11,195; lore context was p95 2,592, max 2,594. Provider billing and natural-language contradictions remain unverified.
- [x] **UP-503** Document schema versions, lore packs, attribution, recovery, backup, upgrades, and missing-pack behavior in README and plan files. The JSON import HTTP limit includes the request envelope.
- [x] **UP-504** Run offline HTTP acceptance, browser UI/migration, restore/restart coverage, live provider smoke, and doctor. OpenRouter `google/gemini-3.8-flash` opening and concise travel passed in isolated data. The latest Gemini opening failed with `RUN_FAILED` and unknown usage; one verbose suggested travel plus retry failed with `AI_RESPONSE_INVALID` from repair output truncation. Doctor passed with 128 tests, typechecks, format checks, and builds.
- [ ] **P5 GATE** Core upgrade and OpenRouter flow pass. Leave open because the latest Gemini opening failed and the verbose suggested action's repair was truncated; Gemini acceptance remains unmet.

## Suggested small PR order

| PR  | Scope                                              | Prerequisite |
| --- | -------------------------------------------------- | ------------ |
| 1   | UP-001..004 baseline and fixtures                  | None         |
| 2   | UP-101..103 location identity + NPC presence       | PR 1         |
| 3   | UP-104..107 memory isolation + context budget      | PR 2         |
| 4   | UP-201..203 lore contracts, migrations, importer   | PR 3         |
| 5   | UP-204..206 retrieval APIs, bindings               | PR 4         |
| 6   | UP-207..209 UI, sample world, portable save policy | PR 5         |
| 7   | UP-301..304 episodic memory/discovery              | PR 6         |
| 8   | P5 polish and acceptance                           | PR 7         |

## Evidence log (fill during implementation)

| Date       | Task/PR                    | Tests & measurements                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Risks / follow-up                                                                                                                                                                                    |
| ---------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-12 | Planning only              | Source inspection; **no local runtime verification performed for this plan**                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Baseline `npm run doctor`, provider smoke and performance benchmarks pending                                                                                                                         |
| 2026-10-12 | P0 baseline                | `npm.cmd run doctor`: 106/106 tests, typecheck, format and both builds pass. `node scripts/upgrade-baseline.mjs` captures vanilla/Ragnarok prompt sizes and local assembly. Evidence `.audit/upgrade-baseline.json`.                                                                                                                                                                                                                                                                                                                                   | Real-provider latency/tokens unverified. Existing Vite websocket warning does not fail checks.                                                                                                       |
| 2026-10-12 | Upgrade acceptance         | `npm.cmd run doctor`: 128/128 tests, client/server typecheck, format, and both builds pass. `node scripts/upgrade-verify.mjs`: 143 HTTP requests, 0 external fetches, catalog/runtime recall@5 20/20, 102-turn replay latency p50/p95/max 39.09/46.51/51.88 ms, provider-prompt context p95/max 11,347/11,988 characters. Focused movement, discovery, effect-validation, and memory-visibility regressions pass. Browser: lore import/pin, game start, OpenRouter opening, concise Morroc travel, local NPCs, and IndexedDB transfer/read-back 1/1/1. | Latest Gemini opening failed with unknown usage. One verbose OpenRouter suggested action and retry hit output truncation. A/B/C, viewport, provider billing, and broad browser recovery remain open. |
| 2026-10-13 | Actor-scoped lore security | The initial final doctor run exposed two actor-privacy regressions. Scoped actor-bound lore to the selected NPC, except for discoveries already found, then verified four focused agent regressions, the pinned-discovery runtime regression, the offline HTTP verifier (143 requests, 0 external fetches), and `npm.cmd run doctor` (130/130 tests, typecheck, format, both builds).                                                                                                                                                                  | Real provider authentication, billing, and natural-language quality remain unverified. Gemini acceptance remains open.                                                                               |

**Definition of done for each task:** feature behavior demonstrated with tests; old game/save paths exercised where relevant; failure path covered; `npm run doctor` run or failure documented; scope and evidence linked in PR.
