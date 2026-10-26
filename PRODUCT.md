# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A single person using a local browser to create and play personal RPG and interactive-fiction games. The same person authors the world and rules, then plays and resumes saved sessions. Multi-user collaboration is not a product goal.

## Product Purpose

Fworld lets a player define a configurable RPG world and experience an emergent, AI-narrated story in it. Success means creating a game, taking free-form actions or selecting suggestions, and seeing validated state persist so the story can be continued later.

## Positioning

Fworld combines player-defined RPG primitives and open-ended storytelling rather than a genre-locked ruleset or predetermined quest and chapter structure. The AI narrates and proposes outcomes; the application engine validates and persists game state.

## Operating Context

The browser application and Node.js backend run locally on one device; the backend uses SQLite as the authoritative store. The normal development origin is `http://127.0.0.1:5173`. A player configures a game, starts a session, interacts through free-form text or optional action choices, and later resumes saved progress. Narration through an online LLM provider requires internet access and a configured provider credential.

## Capabilities and Constraints

- Authors can configure a scenario, player character, NPCs, custom attributes, resources, relationships, items, starting inventory, a world map, and pinned lorebooks.
- Sessions support free-form player actions and up to three optional AI-suggested actions. The engine—not model output—is authoritative for validated state changes and persistence.
- Story progression is emergent; users are not required to define chapters, quests, branches, or endings in advance.
- The stack is React, TypeScript, and Vite in the browser, with a local Node.js 24.13+ backend and SQLite. The backend binds to loopback only.
- SQLite is the persistence source of truth. IndexedDB is read-only and used for legacy migration or recovery, not as a write fallback.
- The product has no accounts, cloud sync, or remote database. Provider credentials stay on the backend in environment variables or ignored `.env` files and are excluded from game exports and backups.

## Brand Commitments

- Product name: Fworld.
- Keep the design consistent across all pages; do not split the application into page-by-page light and dark treatments.

## Evidence on Hand

- Working application code and automated tests establish implemented behavior.
- `README.md` documents current workflows and operating constraints; `prd.md` is a draft requirements source.
- Example lorebooks and game templates are available under `examples/`, including `lorebook-prontera.json` and the evolving-story sample set.
- The project materials contain no established customer testimonials, benchmark claims, or user-research findings; do not invent them.

## Product Principles

- Let players define the rules and world primitives instead of hard-coding them to a genre.
- Keep AI narration separate from authoritative game state: validate and persist outcomes in the application.
- Preserve local ownership and privacy; do not assume accounts, cloud services, or remote persistence.
