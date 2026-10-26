# AGENTS.md

## 1. Context & Source of Truth
- Read [README.md](README.md)  for actual setup, commands, and verification. Inspect only relevant files before changing code.
- Read relevant sections of [prd.md](prd.md) for product requirements. The PRD describes targets, not necessarily implemented features.
- [Manifest Kuskus](.harness/manifest.json)records project profiles and verification evidence.
- Existing behavior, code, and tests establish the current baseline; reconcile conflicts with explicit requirements.
- Do not assume functionality exists. Verify uncertain assumptions against the repository.

## 2. Project Constraints
- Preserve React + TypeScript + Vite, plain CSS, and local Node.js + SQLite architecture.
- Do not introduce authentication, cloud sync, general network access, or remote databases without explicit approval.
- Initialization creates scaffolding only. Implement requested features, not speculative future modules.
- Use `http://127.0.0.1:5173` consistently as the application origin.
- Server-side SQLite is the authoritative persistence layer. IndexedDB is read-only for migration/recovery, never a fallback writer.
- Keep unsaved editor drafts in browser memory.
- Run the backend on Node.js 24.13+ bound to loopback only. Never expose LAN/public access without approval.
- Keep provider credentials in server environment variables or ignored `.env` files. Never expose secrets in source, frontend bundles, logs, exports, or backups.

## 3. Execution Strategy
- Solve the underlying problem, not merely the literal prompt. Challenge incorrect premises when evidence warrants it.
- Clarify only decisions that materially affect correctness or safety; otherwise proceed with reasonable, stated assumptions.
- Identify the smallest relevant code path before implementation. Avoid broad repository exploration without a concrete need.
- Prefer minimal, cohesive, reversible changes. Avoid unrelated refactoring and speculative abstractions.
- Reuse existing utilities, patterns, and dependencies before creating new ones.
- Keep code simple, explicit, readable, and consistent with repository conventions.
- Prefer existing tooling over adding dependencies. Justify new dependencies by demonstrated need.
- Use parallel work only for truly independent tasks; avoid orchestration overhead for small changes.
- If an approach fails, inspect the evidence, revise the hypothesis, and retry. Do not repeat the same failed action blindly.

## 4. Testing Strategy
- Test observable behavior and requirements, not implementation details.
- Only test behavior that will be done by real user.
- Prioritize tests by risk: critical business logic, persistence, migrations, concurrency, security, and regressions.
- For bug fixes, reproduce the failure with a focused regression test when practical, then fix the cause.
- For new behavior, define acceptance criteria before implementation; use TDD when it improves clarity.
- Prefer deterministic tests with realistic inputs and meaningful assertions. Cover important edge cases and failure paths.
- Choose the cheapest effective test layer: unit tests for pure logic, integration tests for boundaries, E2E for critical user journeys.
- Avoid redundant tests, excessive mocking, brittle snapshots, and assertions coupled to internal structure.
- Never modify tests merely to accommodate broken implementation. Update tests only when requirements or intended behavior genuinely change.
- Never weaken assertions, suppress failures, or delete meaningful tests to obtain a passing result.
- Test coverage is diagnostic, not a target. Optimize for defect detection and confidence, not test count.

## 5. Fast Verification Loop
- During development, run the smallest relevant test, typecheck, or lint scope that can catch the current failure.
- Fix failures before expanding verification. Avoid repeated full-suite runs without a reason.
- After code changes, run `npm run doctor` and review the final diff. In PowerShell, use `npm.cmd` if the `npm` shim is blocked.
- Run broader integration/E2E verification only when changed behavior or risk justifies it.
- Treat existing failures, new failures, and environment limitations separately. Never claim verification that was not performed.
- Never bypass required final checks solely to save time.

## 6. Completion Criteria
- Requested behavior works and relevant edge cases are handled.
- No unintended behavior, security regression, or architecture violation was introduced.
- Tests validate the expected behavior rather than reproducing implementation assumptions.
- Diff contains no unrelated changes, temporary artifacts, debug code, or exposed credentials.
- Report concisely: what changed, verification performed, results, and remaining risks or blockers.

## Core Principles
- **Correctness over apparent completion.**
- **Test behavior, not implementation.**
- **Verify proportionally to risk.**
- **Reuse before creating.**
- **Make the smallest change that solves the problem.**
- **Optimize feedback loops, not just code generation speed.**
- **Never hide failures or claim unverified success.**

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
