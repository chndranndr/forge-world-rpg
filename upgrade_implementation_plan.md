# Forge World RPG — Upgrade Implementation Plan

**Status:** Core P0–P3 and P5 implementation is in place. P4 external-corpus work is excluded. Offline acceptance, IndexedDB transfer, canonical browser opening/travel with OpenRouter, and `npm.cmd run doctor` passed. One verbose suggested action and its retry hit output truncation, and the latest Gemini opening failed; the P5 provider gate remains open.
**Created:** 2026-10-12 (Asia/Jakarta)  
**Repository:** [chndranndr/forge-world-rpg](https://github.com/chndranndr/forge-world-rpg), `master` (reviewed Git tree `e83c46b7042e979d87dfc634c023e3bad754db29`)  
**Execution checklist:** [todo.md](todo.md)  
**Existing project contracts:** [README.md](https://github.com/chndranndr/forge-world-rpg/blob/master/README.md), [prd.md](https://github.com/chndranndr/forge-world-rpg/blob/master/prd.md), [backend_agent_Implementation_plan.md](https://github.com/chndranndr/forge-world-rpg/blob/master/backend_agent_Implementation_plan.md), [AGENTS.md](https://github.com/chndranndr/forge-world-rpg/blob/master/AGENTS.md)

> This document records target behavior, implementation, and evidence. User scope excludes P4 external-corpus work. See [todo.md](todo.md) for acceptance gates that remain open.

## 1. Objective and definition of success

Upgrade the single-player story RPG so creators can import validated JSON lorebooks without sending the full pack to the model on each turn. Players can travel between locations, meet local characters, ask about history, and retain decisions across hundreds of turns.

The upgraded system must:

1. **Keep AI as narrator, not game-state authority.** The backend owns movement, inventory, checks, relationships, knowledge/discovery, and commits.
2. **Retrieve context selectively** from immutable lore, current world/session state, episodic memory, and recent messages.
3. **Scale corpus size separately from prompt size**: adding lore entries must not linearly increase per-turn prompt size.
4. **Preserve existing games and saves** and continue to work with **no lorebook installed**.
5. **Stay local and lightweight:** Node.js 24.13+, TypeScript, React/Vite, `node:sqlite`, FTS5, one narrator; no default cloud database, new orchestrator framework, dedicated NPC agents, graph database, or vector DB.
6. **Make ingestion an offline/admin operation.** Scraping/parsing large content must not occur during a player turn.

### Non-goals

- Do not implement RO combat mechanics, loot balancing, full skill trees, pathfinding, real-time simulation, required quest graphs, or a visual world map in this upgrade.
- Exclude P4 external-corpus tooling: crawlers, wiki adapters, staging/streaming pipelines, and 10k/50k/100k benchmarks. The P2 manual JSON lorebook importer remains in scope.
- Do not copy entire copyrighted articles/images into app releases without reviewing source-specific permissions.
- Do not redesign the whole UI, add accounts/multiplayer/cloud sync, or replace the existing persistence model.

## 2. Verified baseline (code inspection, not runtime benchmark)

| Current implementation                                                                                                                                                                                                         | Implication                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `server/turn.ts` orchestrates runs with idempotent `requestId`, expected revision, atomic commit; `server/agent.ts` runs a single narrator with tools.                                                                         | Preserve the authority boundary and turn ledger.                                                                               |
| `server/agent.ts` sets `MAX_CONTEXT_CHARS = 24_000`, `MAX_RECENT_MESSAGES = 24`; `contextSnapshot()` includes scenario, player, all attribute/resource definitions, item summaries, active NPCs, and all public/private facts. | Large definitions and growing facts can exhaust context before useful recent dialogue is added.                                |
| `shared/engine.ts` starts `world.location` as `""` and initializes `activeCharacters` to player **plus every configured NPC**.                                                                                                 | NPC presence is not location-aware.                                                                                            |
| `shared/types.ts` defines `WorldState.location: string`; narrative proposals update `location/time/scene`, not `activeCharacters`.                                                                                             | Travel is currently a free-text change, not validated movement or presence resolution.                                         |
| `server/db.ts.searchMemory()` uses FTS5 for session messages and token matching for facts; NPC filtering applies to private facts, **not to retrieved messages**.                                                              | Existing search is story-history retrieval, not lore retrieval; speaker knowledge boundaries need explicit handling.           |
| `ADD_FACT` creates public story facts by default; `GameDefinition` has no lorebook references.                                                                                                                                 | Secrets/discoveries need typed effects and retrieval visibility; adding arbitrary JSON fields to templates will not work.      |
| `shared/template.ts` parses/exports `fworld-template` v1 using allowlisted pickers; `server/db.ts` is schema v1; request/document limits exist.                                                                                | Requires deliberate migration and versioned import; don't turn the game template into a giant wiki dump.                       |
| `src/turn.ts` is legacy browser-era flow; active narrator path is `server/agent.ts` + `server/turn.ts`.                                                                                                                        | Change backend authoritative path; retain legacy code for migration/tests unless an explicitly separate cleanup is authorized. |

**Existing safeguards to retain:** `run_check` engine validation, item effects validation, single-session write lock, no LLM/database direct access, server-side API keys, SQLite transactions, session revision, `fworld-save`/`fworld-template` v1 readers, legacy IndexedDB recovery, loopback host/origin checks. Do not downgrade these to expedite lore features.

## 3. Target request/turn flow

```text
PLAYER: "Aku berangkat ke Morroc"
  |
  v
Turn API: requestId + expectedRevision + action
  |
  v
World Resolver (server, deterministic where possible)
  - resolve the player's requested destination by stable IDs and aliases
  - validate a movement candidate against the current map and travel rules
  - keep that candidate provisional until the narrator response and turn commit succeed
  |
  v
Context Assembler (read-only)
  - core game rules + compact character/state summary
  - candidate/current location and parent lore
  - current place, nearby NPCs, relevant items/activities
  - topic-triggered FTS lore, if relevant
  - allowed story facts + episode summaries + recent messages
  - enforce independent budget per context section
  |
  v
Single LLM Narrator (existing AI SDK and tool calling)
  - tells story and offers optional choices
  - returns a structured proposal (world transition, effects, narrative)
  - may use bounded `search_memory`, `get_npc_details`, `get_item_details`
  |
  v
Server Validation / Game Engine
  - validate destination and presence; enforce lore constraints
  - validate changes, knowledge, stats, inventory and check results
  - ensure no state advances on invalid model output
  |
  v
Atomic SQLite Commit (existing revision / idempotency)
  - new world state, discovered flags, messages, effects, run result
  |
  v
UI displays committed result
```

**Critical transition rule:** The server resolves travel from the player's action and current world before calling the narrator. Only an `allowed` candidate can change a mapped location; the server projects its destination after effects validate and commits it atomically. Narrator `location`/`locationId` fields cannot authorize, redirect, or block mapped travel. Non-allowed candidates preserve the current mapped location, even if narration mentions a destination. No-map sessions retain legacy free-text location behavior.

## 4. Data model and boundaries

### 4.1 Separate three categories

| Category                | Mutable?                                   | Source of truth                      | Example                                                         |
| ----------------------- | ------------------------------------------ | ------------------------------------ | --------------------------------------------------------------- |
| **Lore**                | Versioned/published; read-only during play | `lore_entries` / `lore_packs`        | Morroc's geography/history, known places, public NPC background |
| **World/session state** | Yes; engine-owned                          | `sessions.state_json`                | Currently in Morroc; gate blocked; player knows an entrance     |
| **Story memory**        | Append/derived from committed turns        | `messages`, facts, `story_summaries` | Player helped a merchant; an NPC distrusts player               |

Lore may define _possibilities_ (merchant's normal location, available activities); actual presence/access can depend on current state. Never override a committed world change with a stale lore summary.

### 4.2 Lore entities (domain shape; implementation may store as columns + JSON)

```ts
type LoreKind =
  | "world"
  | "region"
  | "location"
  | "place"
  | "npc"
  | "faction"
  | "history"
  | "monster"
  | "item"
  | "activity"
  | "other";

type LoreEntry = {
  id: string; // stable normalized namespace, e.g. loc:morroc
  kind: LoreKind;
  name: string;
  aliases: string[]; // e.g. Morocc/Morroc
  parentId?: string; // e.g. poi:morroc_market -> loc:morroc
  summary: string; // short, safe for always-on location context
  body: string; // retrieval-only long-form detail
  tags: string[];
  visibility: "public" | "narrator" | "discovery";
  metadata: Record<string, unknown>; // type-specific validated metadata
  provenance: {
    sourceId: string;
    sourceUrl?: string;
    license?: string;
    revision?: string;
    canon?: "anime-2004" | "game" | "manhwa" | "original" | "mixed";
  };
};

type LoreLink = {
  fromId: string;
  toId: string;
  relation:
    "PARENT_OF" | "CONNECTED_TO" | "LOCATED_IN" | "PRESENT_AT" | "RELATED_TO";
};
```

- IDs and links must be validated; reject unresolved references (unless explicitly marked external), cycles in parent tree, self-connections where disallowed, or duplicate IDs in one pack version.
- `summary` = small predictable context; `body` = long content accessed selectively. Avoid arbitrary fixed-size cutting through JSON/text without a bounded excerpt/paragraph strategy.
- A lore entry may describe an NPC without creating a playable actor. Only an explicit allowlisted mapping can connect lore to a configured `NpcDefinition`.
- A lore `item` is encyclopedia content, not an engine `ItemDefinition`; use an explicit allowlisted mapping for playable items and effects.

### 4.3 Versioning and persistence

Proposed minimal relational storage (names adjustable after reviewing existing DB migrations):

- `lore_packs`: `id`, `version`, `name`, `source_metadata_json`, `created_at`, `status`; **published versions immutable**.
- `lore_entries`: `(pack_id, pack_version, entry_id)` unique, `kind`, `name`, `parent_id`, `summary`, `body`, `metadata_json`; index by pack/version/parent/kind.
- `lore_links`: from/to entry identities, relation; indexed in both directions.
- `lore_entries_fts`: FTS5 on name/aliases/summary/body; joined back to filtered pack/version; use prepared queries + bounded results; maintain index transactionally.
- `story_summaries`: `session_id`, `from_sequence`, `to_sequence`, `summary`, `created_at`, `source_digest`; unique range and source digest to make compaction idempotent.

Use the existing `PRAGMA user_version` incremental migration path; **schema version 2+**, never re-run unconditional `CREATE TABLE` for an existing v1 DB. Publish a lore pack only after full validation and indexing succeed; rollback on failure. The P2 JSON importer is bounded to 8 MiB, 5,000 entries, and 20,000 links; its HTTP body limit includes the JSON envelope. Larger-corpus batching and streaming are excluded by P4.

Suggested optional game/session fields:

```ts
// Optional for backward compatibility; absence preserves old behavior.
GameDefinition.lorebookRefs?: Array<{ packId: string; version: number }>;
SessionState.world.locationId?: string;   // canonical, e.g. loc:morroc
SessionState.world.flags?: Record<string, boolean>;
SessionState.world.discoveredLoreIds?: string[];
// Keep existing world.location string as human-readable legacy/display field.
```

Do not infer the correct location from a legacy free-text name when ambiguous. Map exact known aliases; otherwise keep legacy free-text behavior and surface a non-breaking unresolved state. An existing session should bind to the lore pack versions it started with; a pack update must not silently rewrite active save continuity. Adding `lorebookRefs` requires explicit picker/validator/API/export updates, not only a TypeScript change.

### 4.4 NPC presence and knowledge

- Derive default _candidate_ scene participants from current place + `PRESENT_AT` / `LOCATED_IN` links, plus explicitly committed session overrides (e.g. a traveling NPC). Cap scene participants by relevance; don't activate every NPC at start.
- Keep legacy no-lore games usable; initial active characters can retain legacy semantics until a compatible location/presence rule exists. Do not globally remove their NPCs.
- Distinguish **narrator-only lore**, **public world facts**, **known to player**, and **known to specific NPC**. Store/source visibility explicitly; an NPC's accessible knowledge is not the same as all messages recorded in the session.
- `searchMemory(query, npcId)` must not return unknown private messages/facts simply because their text matches. Introduce message knowledge metadata or restrict NPC-scoped retrieval to public/explicitly-known records; fail closed on unknown visibility.
- The same LLM narrates every NPC and may see narrator-only facts; this is a soft-model boundary. Enforce visibility when **selecting and delivering context**, validate known facts, and test leakage; no prompt alone can guarantee secrecy.
- `ADD_FACT` needs a backward-compatible way to capture visibility and knowledge recipients (or separate typed `REVEAL_FACT` / `DISCOVER_LORE` effects). Current public default remains valid for old saves, but private revelations cannot piggyback on it.

## 5. Deterministic context retrieval strategy

Always query by **stable identity first**, then use FTS5 for ad hoc topics. Do not ask the model to discover the current city from scratch every turn.

### Retrieval pipeline

1. Resolve current and candidate location ID (exact ID, case-insensitive alias, otherwise fallback/clarification as gameplay requires).
2. Fetch a compact `summary` for location + relevant parent region; on entry, fetch a bounded introduction of the city.
3. Fetch immediate places/connections, available activities, NPC presence, and item metadata based on location and scene constraints.
4. Run FTS5 only when the action mentions an extra topic/entity (e.g. _sejarah Morroc_, _Pyramid_, _potion_) or when model calls a bounded details tool.
5. Fetch session story memories scoped to that topic/NPC and filtered by knowledge visibility; include valid episode summaries when older history matters.
6. Deduplicate by entry ID; rank deterministic scope matches first, then FTS relevance, then declared priority; cap per category.
7. Assemble context under a tokenizer-aware budget; preserve mandatory constraints and the last few conversational turns. Gracefully omit optional detail instead of failing the entire turn.

**Important:** `search_memory` and `search_lore` have different purpose and access rules. Expose `search_lore` / `get_lore_entry` only if on-demand lookup materially improves story quality; prefetch the active location and participants to avoid extra tool round trips on every turn. Limit tool results, count, response size, and query length as in existing tool design.

### Proposed context budget (starting hypothesis, measure and tune)

| Component                                       |         Initial target tokens |
| ----------------------------------------------- | ----------------------------: |
| System contract + compact core rules            |                       500–900 |
| Player stats, resources, inventory, world state |                       400–900 |
| Current location, NPCs, relevant lore           |                     700–1,500 |
| Relevant story facts + summaries                |                       400–900 |
| Recent dialogue + action                        |                   1,000–1,800 |
| **Total target**                                | **~3,000–6,000 input tokens** |

Use a provider/model-specific tokenizer or usage estimates where available; character count may remain a **hard safety fallback**, not the sole budgeting strategy. Record `contextChars`, approximate tokens, selected entry IDs/count, truncation/omission reason, input tokens, tool calls, repair rate and latency (no secrets or full prompts in logs). A clear error is still correct when **mandatory** content alone exceeds the model/provider capability.

### Example: Morroc

```json
{
  "playerAction": "Aku tiba di Morroc dan menanyakan sejarah kotanya",
  "world": { "locationId": "loc:morroc", "location": "Morroc" },
  "loreIds": ["loc:morroc", "history:morroc", "place:morroc_gate"],
  "activeNpcIds": ["npc:gate_guard"],
  "memoryScope": { "sessionId": "CURRENT", "topics": ["morroc", "gate_guard"] }
}
```

_Illustrative IDs, not an official Ragnarok Wiki ontology._ Later, in the Morroc market, the context should switch to market activities and merchants without repeating a history article unless requested.

## 6. Turn proposal, validation and UI behavior

- Extend the output contract **only as needed**. Prefer optional `world.locationId` or an explicit typed travel proposal rather than overloading display `world.location`. If a travel action is blocked, preserve old location and narrate the obstacle.
- Resolve a movement proposal against location graph/aliases and game rules; a no-lore campaign can continue freeform as before. Store movement in the existing turn transaction; an `opening` or `choices` run remains read-only as specified today.
- Keep engine as sole authority for granting items, stats, relationship changes, story flags and lore discoveries. A narrator saying "you obtained a card" must not grant it without a validated effect.
- Offer **0–3** suggested actions for a normal conversation (optional UI enhancement). Avoid a separate `choices` LLM call when valid choices already came in the turn response. Update parser/UI/tests together; do not quietly weaken validation.
- Game Editor: add an optional **Lorebook** panel or import flow. Show linked pack/version, entry counts, search/test-retrieval, and provenance. For large packs, use paginated API results; never send the entire corpus to React state.
- Player view: expose current location and **discoverable** places/people/activities only. Hide narrator-only entries/private facts from player-facing API results by default.

## 7. Rolling episodic memory

Retain all committed messages in SQLite, but don't feed the complete transcript to the model.

- Generate summaries **out of band after a successful commit** every configurable range (initially consider ~10–20 turns) or important scene transitions. **No additional required model call in the interactive turn critical path.** If async compaction is infeasible in the local lifecycle, do it opportunistically before a later turn with a strict bounded budget; failure must not block gameplay.
- Summaries contain factual event references and relevant turning points; each references a **committed** message sequence range. Keep durable game-state fields authoritative.
- Make summary writes idempotent (source range/digest); preserve original events; don't merge private knowledge into public NPC summaries.
- Retrieve one recent summary + topic-relevant older summaries where useful; recent raw messages remain available within budget.
- Explicitly reject imagined facts in summary from becoming `effects`, facts or lore without validating against committed events.

## 8. External corpus ingestion (excluded from this upgrade)

P4 external-corpus tooling is intentionally not implemented. This excludes crawlers, wiki/API adapters, normalization/staging/streaming/deduplication pipelines, and 10k/50k/100k benchmarks. The P2 manual `fworld-lorebook` JSON importer remains supported with an 8 MiB pack limit, 5,000 entries, and 20,000 links; the HTTP request-body limit includes the JSON wrapper. No external wiki content is bundled.

## 9. Serialization, migration and backward compatibility

1. Introduce sequential SQLite migrations (`PRAGMA user_version`) with backup/recovery tests; don't replace existing v1 schema or alter saved data destructively.
2. Keep importing existing `fworld-template` v1 and `fworld-save` v1 unchanged. New lore metadata should be optional for old games.
3. The P2 `fworld-lorebook` v1 JSON import is limited to 8 MiB, 5,000 entries, and 20,000 links; its HTTP request-body limit includes the JSON envelope. Larger corpus and streaming import are excluded by P4.
4. If game/session export starts referencing lore packs, define **`fworld-save` v2** or an explicit portable-package mechanism before writing those fields. A save must either include required lore dependency content or ship a manifest and produce a clear missing-pack error on restore. Do not silently drop references.
5. Pin/resolve lore pack version for existing sessions; upgrades use explicit opt-in migration, not silent rebind. If no pack is installed, legacy gameplay must still work.
6. Keep current `src/db.ts` migration path and existing backup/restore behavior; verify lore tables and new summaries are included in SQLite backup and portable export where applicable.

## 10. Implementation phases / acceptance gates

### Phase 0 — Baseline and executable tests

**Changes:** snapshot current behavior, add focused tests/fixtures, gather measurements from sample Ragnarok JSON and a vanilla game.  
**Exit gate:** reproducible `npm run doctor`; record existing baseline latency/context size, errors and known incomplete provider tests. No code behavior regression.

### Phase 1 — World/presence/context foundation (**highest priority**)

**Changes:** stable optional `locationId`; alias resolver; optional location transitions; scene-specific NPC presence; trimmed `contextSnapshot`; correct `searchMemory` NPC visibility; sectioned budgeting and telemetry.  
**Exit gate:** Prontera scene does **not** include every configured NPC; Morroc travel is validated; unknown/unconfigured lore falls back safely; context size stays bounded as unrelated NPC/item definitions grow; request revision and idempotency preserved.

### Phase 2 — Lorebook MVP

**Changes:** SQLite pack/entry/link/FTS tables, API with pagination, import/export validation, optional game binding, deterministic contextual retrieval, optional on-demand tools, basic editor and retrieval preview.  
**Exit gate:** a small manually curated Prontera → Morroc → Pyramid pack works end to end; only relevant lore and participants appear in narrator input; no lorebook campaigns still work; imports roll back on error.

### Phase 3 — Long-term memory

**Changes:** summary table, committed-range summarizer, visibility-aware story retrieval, discovery flags and tests.  
**Exit gate:** 100+ turn replay retains a prior meaningful interaction without repeatedly sending all chat; private NPC facts do not surface to unrelated NPC responses; failing summary jobs cannot corrupt or block turns.

### Phase 4 — Skipped by user scope

CLI corpus eksternal, crawler/wiki adapter, staging/streaming, dan benchmark 10k/50k/100k tidak dibuat. Import JSON pack tervalidasi tetap tersedia pada Phase 2.

### Phase 5 — Polish and measurement

**Changes:** optional 0–3 choices, retrieval ranking, lazy-loading UI, fixed-script retrieval measurement, docs, and restore tests.  
**Exit gate:** Fixed 20-action recall@5 reaches 20/20 within prompt budgets. `npm run doctor` and migration/restart/backup/restore must pass. OpenRouter opening and concise Morroc travel pass. Gemini's latest opening failed, and one verbose suggested-action repair was truncated; keep the provider gate open.

## 11. Required tests and reproducible evaluation

Automated tests should cover **observable behaviors**, not merely private helper shapes:

- **Travel:** exact IDs, aliases, ambiguous names, blocked/allowed edges, denied movement, no-lore fallback, scene entry/exit, request retry after failure.
- **NPC presence:** player in Prontera vs Morroc, NPC leaves/returns, NPC private fact known only to a specific actor, active participant count bounded.
- **Retrieval:** precise location lookup, parent/place context, topic FTS, irrelevant lore excluded, nested alias resolution, typo/empty query, SQL/FTS escaping, ranking determinism, truncation.
- **Memory:** older turn retrieval, summary range idempotency, correction after world change, hidden facts, no session mixing, NPC-scoped message filtering.
- **Contracts:** invalid IDs/effects, injection-like lore content, malformed import, duplicate/unresolved links, large entry, unknown license, rejected revision, interrupted/repeated run, no state mutation during read-only choices/opening.
- **Migration:** v1 DB upgrade, restart and restore, old `fworld-template`/`fworld-save`, new pack version binding, missing pack dependency and explicit error.
- **Scaling:** skipped by user scope. No 10k/50k/100k corpus benchmark is part of this work.
- **LLM integration:** mocked provider contract tests; Gemini/OpenRouter real smoke only when keys available, clearly marking unverified providers. Never assert provider smoke passed based on local mocks.

Suggested evaluation fixture: 5 locations (Prontera, Morroc, Morroc Market, Pyramid, Sograt), 5–10 NPCs with mixed knowledge, 20 items, 3 secret facts, and 20 deterministic player actions. Compare before/after context bytes, billed tokens (when available), lore recall@k, narrator contradictions, invalid effect rate, p95 turn latency and replay consistency. Report measurements rather than inventing gains.

## 12. Implementation discipline / handoff

1. Before each phase, read `AGENTS.md`, `README.md`, active PRD/backend plan and relevant code; update `todo.md` status. If code diverges from this document, prioritize verified current behavior and amend plan with rationale.
2. Add tests first for the phase's most important behavioral invariants; modify the smallest cohesive modules. Do not add placeholders or unused abstractions.
3. Use incremental commits/PRs by phase. Run `npm run doctor` after changes; review diff and ensure no credentials or third-party copyrighted page dumps are committed.
4. Record acceptance evidence (test output, measurements, unresolved risks) in `todo.md` or PR description. Don't mark tasks complete based solely on code compilation.
5. Optimize complexity only after baseline. A plain SQLite lookup is preferable to embeddings if it passes accuracy and latency tests.

**Preferred execution order:** P0 → P1 → P2 → P3; P4 external-corpus work is excluded by user scope, while P5 closes quality gaps. Keep the existing playable RPG working at every step.
