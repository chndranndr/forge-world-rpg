# UI Prototype Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the implementable feature and fidelity gaps between the `ui_kits` prototype and the current product, and make the remaining asset/design gaps explicit and testable.

**Architecture:** Extract scene-composition and cover-selection logic into pure, tested helpers; add small presentational primitives instead of growing `SettingsPanel`; wire them into the existing components without changing gameplay or persistence contracts. Visual assets are handled behind explicit gates so missing export files cannot silently produce broken CSS. A reusable headless-browser check enforces the nine-viewport contract from `ui_kits/DESIGN-MANIFEST.json`.

**Tech Stack:** React 19, TypeScript 7, Vite 8, plain CSS, `node:test`, Vite `ssrLoadModule`, Microsoft Edge headless via CDP, SQLite-backed local backend (untouched).

---

## Scope and gates

### In scope

1. Scene turn semantics: no stale dialogue, no “Bab” mislabel, no raw speaker IDs.
2. Settings parity: paper “Data / Tersimpan lokal” row, segmented text-size control, Indonesian labels.
3. Rail disabled state and a themed, accessible delete confirmation dialog.
4. Three 3:2 cover assets with deterministic, genre-aware selection.
5. Self-hosted font wiring and original texture replacement **only if the missing export assets are supplied** (Gate G1).
6. A reusable `npm run ui:check` viewport checker and the full nine-viewport verification.
7. Documentation and manifest evidence.

### Out of scope — separate design + implementation plan

These gaps require design decisions or data-model changes; implementing them here would invent a design the handoff does not contain. They are listed under “Deferred” with the next concrete step, and must not be squeezed into this plan:

- Editor, AI settings/profiles, data-ops, session panels/history, and the full state matrix (loading/empty/error/success) design coverage.
- Chapter-title data model (narrator schema + migration).
- Featured-card turn count (session list payload has no turn stats).
- URL routing/deep links.
- Long-narration layout policy and multi-resource notes density.

### Gates

- **G1 — Typography/texture assets.** Expected files, taken from the design export:
  - `src/assets/fonts/newsreader-normal-400-600.woff2`
  - `src/assets/fonts/newsreader-italic-400-500.woff2`
  - `src/assets/fonts/public-sans-normal-400-600.woff2`
  - `src/assets/fonts/ibm-plex-mono-normal-400.woff2`
  - Optional: the original `leather.svg`, replacing the reconstructed `src/assets/leather.svg`.
    If these files are absent, skip Task 8, keep the exported fallback stacks in `src/styles.css`, and record the gap in Task 10. **Do not fabricate font files.**
- **G2 — Cover originals.** If the export contains the original `coast.svg`, `lantern.svg`, `archive.svg`, drop them into `src/assets/covers/` instead of the fallback compositions in Task 7. They must remain 3:2.

### Baseline and branch

The cinematic-shell UI is currently uncommitted. Commit it before starting gap work so each task below is an isolated commit.

**Workspace warning (observed 2026-10-21):** an unrelated in-progress backend refactor is also present in the working tree: `server/agent.ts` is being split into `server/agent/*`, with changes to `server/db.ts`, `server/main.ts`, `server/turn.ts`, `shared/types.ts`, `tests/agent.test.mjs`, `tests/upgrade-storage.test.mjs`, and new `scripts/framework-verify.mjs`. The index currently contains a staged rename `server/agent.ts -> server/agent/legacy-agent.ts` whose target file is absent (porcelain status `RD`). **Do not commit, stage, stash, reset, or “fix” that work in this plan.** Use the `git commit --only` form below so only UI/doc paths enter the baseline commit.

---

## File map

### Create

| Path                                                        | Responsibility                                                                      |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/session-view-model.ts`                                 | Pure scene derivation: current-turn narration/dialogue, eyebrow text, author labels |
| `src/components/SettingsPrimitives.tsx`                     | Presentational `DataStatusRow` and `TextSizeControl`                                |
| `src/components/ConfirmDialog.tsx`                          | Accessible paper-themed `<dialog>` confirmation                                     |
| `src/assets/covers/coast.svg`, `lantern.svg`, `archive.svg` | 3:2 cover art (fallback until G2 originals arrive)                                  |
| `scripts/ui-check.mjs`                                      | Nine-viewport overflow + screenshot check                                           |
| `tests/session-view-model.test.mjs`                         | Scene derivation tests                                                              |
| `tests/settings-primitives.test.mjs`                        | Settings primitive markup tests                                                     |
| `tests/confirm-dialog.test.mjs`                             | Confirmation dialog markup test                                                     |
| `tests/covers.test.mjs`                                     | Cover ratio + selection tests                                                       |
| `tests/ui-fonts.test.mjs`                                   | Font asset check, **only if G1 is satisfied**                                       |
| `docs/superpowers/specs/ui-coverage-brief.md`               | Follow-up design brief (separate plan, not this one)                                |

### Modify

| Path                                 | Change                                                            |
| ------------------------------------ | ----------------------------------------------------------------- |
| `src/components/SessionView.tsx`     | Use scene model; Indonesian author labels; remove raw `speakerId` |
| `src/components/SettingsPanel.tsx`   | Use `DataStatusRow` / `TextSizeControl`; drop Node/schema details |
| `src/components/GameLibrary.tsx`     | Themed delete dialog instead of `window.confirm`                  |
| `src/components/GameEditor.tsx`      | Indonesian action labels                                          |
| `src/components/AiProfilesPanel.tsx` | Indonesian “ID model” label                                       |
| `src/library.ts`                     | `coverIdFor()`                                                    |
| `src/illustrations.ts`               | Map cover ids to bundled SVGs                                     |
| `src/styles.css`                     | Disabled nav, setting-row/segmented/status, optional `@font-face` |
| `package.json`                       | `ui:check` script                                                 |
| `README.md`                          | Tampilan notes for covers/labels/assets                           |
| `.harness/manifest.json`             | Verification evidence                                             |
| `tests/startup.test.mjs`             | Only if the rail markup assertion needs updating                  |

### Do not touch

`server/`, `shared/` (except type-only imports), `src/api.ts`, database schema, AI prompt contracts, auth/network behavior.

---

## Traceability: original gap → task

| Original gap                                                      | Task      |
| ----------------------------------------------------------------- | --------- |
| Stale dialogue from an older turn                                 | 1, 2      |
| “Bab N” derived from turn count                                   | 1, 2      |
| Raw `speakerId` in history                                        | 1, 2, 5   |
| Settings has no “Data / Tersimpan lokal” row; Node/schema exposed | 3, 4      |
| Text-size toggle pattern missing                                  | 3, 4      |
| Disabled “Sesi” nav has no designed state                         | 6         |
| Native `window.confirm` for deletion                              | 6         |
| English action labels                                             | 5         |
| Two covers, wrong ratio, genre duplication                        | 7         |
| Fonts/texture missing                                             | 8 (gated) |
| 430 / 600 / 1366 viewports unverified                             | 9         |
| Chapter title, featured turn count, design coverage               | Deferred  |

---

## Task 0: Commit the baseline and branch

**Files:** none (git only)

- [ ] **Step 1: Inventory the working tree**

Run: `git status --porcelain -uall`
Expected: the UI/doc paths from the file map, the `ui_kits/` archive, this plan, **and** the unrelated backend refactor described above. Record those unrelated paths; they must not be staged.

- [ ] **Step 2: Format only the UI and plan paths**

```powershell
npx.cmd prettier --write docs/superpowers/plans/2026-10-21-ui-prototype-gap-closure.md .prettierignore README.md index.html src/App.tsx src/styles.css src/library.ts src/components/NavigationRail.tsx src/components/FieldNotesPanel.tsx src/components/GameLibrary.tsx src/components/SessionView.tsx src/components/SettingsPanel.tsx src/components/GameEditor.tsx tests/startup.test.mjs tests/library.test.mjs
```

Expected: those paths are formatted. Do **not** run repo-wide `prettier --write`; it would rewrite the in-progress backend files.

- [ ] **Step 3: Typecheck the UI in isolation**

Run: `npx.cmd tsc --noEmit`
Expected: exit 0. (This currently passes despite the backend refactor; the server typecheck is not part of the UI baseline commit.)

- [ ] **Step 4: Stage only the UI and doc paths**

`--only` cannot commit files Git does not know about yet, so stage the UI/doc paths first. This adds new files without touching the unrelated index entries:

```powershell
git add -- .harness/manifest.json .prettierignore README.md index.html src/App.tsx src/styles.css src/library.ts src/assets/leather.svg src/components/NavigationRail.tsx src/components/FieldNotesPanel.tsx src/components/GameLibrary.tsx src/components/SessionView.tsx src/components/SettingsPanel.tsx src/components/GameEditor.tsx tests/startup.test.mjs tests/library.test.mjs ui_kits docs/superpowers/plans/2026-10-21-ui-prototype-gap-closure.md
```

Run: `git status --short`
Expected: the listed paths staged; `server/`, `shared/`, `scripts/framework-verify.mjs`, and the agent tests keep their previous (unstaged/staged) state.

- [ ] **Step 5: Commit only the staged UI and doc paths**

The index also contains unrelated staged work, so a plain `git commit` would capture it. Use `--only`:

```powershell
git commit --only -m "feat(ui): implement cinematic chapter shell from design handoff" -- .harness/manifest.json .prettierignore README.md index.html src/App.tsx src/styles.css src/library.ts src/assets/leather.svg src/components/NavigationRail.tsx src/components/FieldNotesPanel.tsx src/components/GameLibrary.tsx src/components/SessionView.tsx src/components/SettingsPanel.tsx src/components/GameEditor.tsx tests/startup.test.mjs tests/library.test.mjs ui_kits docs/superpowers/plans/2026-10-21-ui-prototype-gap-closure.md
```

Run: `git show --stat HEAD`
Expected: only the listed paths appear. No `server/`, `shared/`, `scripts/framework-verify.mjs`, or agent-test paths.

- [ ] **Step 6: Create the working branch**

```powershell
git switch -c feat/ui-gap-closure
```

Expected: `Switched to a new branch 'feat/ui-gap-closure'`. The unrelated in-progress work remains in the working tree/index, untouched.

- [ ] **Step 7: Record the baseline caveat**

`npm run doctor` cannot be green while the unrelated backend work is unformatted/mid-flight. The final verification in Task 10 requires a green doctor: if the backend refactor is still in progress at that point, stop and coordinate with its owner instead of modifying it.

---

## Task 1: Scene composition model (TDD)

**Files:**

- Create: `src/session-view-model.ts`
- Test: `tests/session-view-model.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/session-view-model.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

let vite;
let model;

test.before(async () => {
  vite = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  model = await vite.ssrLoadModule("/src/session-view-model.ts");
});

test.after(async () => {
  await vite?.close();
});

function message({ id, turnId, sequence, role, content = "teks", speakerId }) {
  return {
    id,
    sessionId: "session-1",
    turnId,
    sequence,
    role,
    ...(speakerId === undefined ? {} : { speakerId }),
    content,
    createdAt: "2026-10-21T00:00:00.000Z",
  };
}

test("dialogue stays scoped to the latest story turn", () => {
  const scene = model.latestSceneMessages([
    message({
      id: "m1",
      turnId: "turn-1",
      sequence: 1,
      role: "NPC",
      speakerId: "npc-mara",
      content: "dialog lama",
    }),
    message({
      id: "m2",
      turnId: "turn-2",
      sequence: 2,
      role: "NARRATOR",
      content: "narasi baru",
    }),
    message({
      id: "m3",
      turnId: "turn-2",
      sequence: 3,
      role: "NPC",
      speakerId: "npc-mara",
      content: "dialog baru",
    }),
  ]);
  assert.equal(scene.narration?.content, "narasi baru");
  assert.equal(scene.dialogue?.content, "dialog baru");
});

test("an older turn's dialogue never leaks into the current scene", () => {
  const scene = model.latestSceneMessages([
    message({
      id: "m1",
      turnId: "turn-1",
      sequence: 1,
      role: "NPC",
      speakerId: "npc-mara",
      content: "dialog lama",
    }),
    message({
      id: "m2",
      turnId: "turn-2",
      sequence: 2,
      role: "NARRATOR",
      content: "narasi baru",
    }),
  ]);
  assert.equal(scene.dialogue, null);
});

test("empty and system-only histories have no scene", () => {
  assert.deepEqual(model.latestSceneMessages([]), {
    narration: null,
    dialogue: null,
  });
  assert.deepEqual(
    model.latestSceneMessages([
      message({
        id: "m1",
        turnId: "turn-1",
        sequence: 1,
        role: "SYSTEM_EVENT",
        content: "item dipakai",
      }),
    ]),
    { narration: null, dialogue: null },
  );
});

test("scene eyebrow labels a scene, not a chapter", () => {
  assert.equal(model.sceneEyebrow(4, "Tepi Teluk"), "Adegan 04 · Tepi Teluk");
  assert.equal(model.sceneEyebrow(0, "Tepi Teluk"), "Adegan 01 · Tepi Teluk");
});

test("message author uses NPC names and never raw ids", () => {
  assert.equal(
    model.messageAuthor(
      { role: "NPC", speakerId: "npc-mara" },
      {
        "npc-mara": "Mara",
      },
    ),
    "Mara",
  );
  assert.equal(
    model.messageAuthor({ role: "NPC", speakerId: "npc-unknown" }, {}),
    "NPC",
  );
  assert.equal(model.messageAuthor({ role: "NARRATOR" }, {}), "Narator");
  assert.equal(model.messageAuthor({ role: "PLAYER" }, {}), "Pemain");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/session-view-model.test.mjs`
Expected: FAIL — Vite cannot resolve `/src/session-view-model.ts` (file does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/session-view-model.ts`:

```ts
import type { Message } from "./types";

export interface SceneMessages {
  narration: Message | null;
  dialogue: Message | null;
}

const ROLE_LABELS: Record<Message["role"], string> = {
  PLAYER: "Pemain",
  NARRATOR: "Narator",
  NPC: "NPC",
  SYSTEM_EVENT: "Sistem",
};

function latestStoryTurnId(messages: Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "NARRATOR" || message.role === "NPC") {
      return message.turnId;
    }
  }
  return null;
}

export function latestSceneMessages(messages: Message[]): SceneMessages {
  const turnId = latestStoryTurnId(messages);
  if (turnId === null) return { narration: null, dialogue: null };

  let narration: Message | null = null;
  let dialogue: Message | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.turnId !== turnId) continue;
    if (message.role === "NARRATOR" && narration === null) narration = message;
    if (message.role === "NPC" && dialogue === null) dialogue = message;
    if (narration !== null && dialogue !== null) break;
  }
  return { narration, dialogue };
}

export function sceneEyebrow(turnCount: number, location: string): string {
  const turn = Math.max(1, turnCount);
  return `Adegan ${String(turn).padStart(2, "0")} · ${location}`;
}

export function messageAuthor(
  message: Pick<Message, "role" | "speakerId">,
  npcNames: Record<string, string>,
): string {
  const role = ROLE_LABELS[message.role];
  if (!message.speakerId) return role;
  return npcNames[message.speakerId] ?? role;
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `node --test tests/session-view-model.test.mjs`
Expected: PASS — 5 tests, 0 failures.

Run: `npx.cmd tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Format and commit**

```powershell
npx.cmd prettier --write src/session-view-model.ts tests/session-view-model.test.mjs
git add src/session-view-model.ts tests/session-view-model.test.mjs
git commit -m "feat(ui): model scene messages per turn"
```

---

## Task 2: Wire the scene model into SessionView

**Files:**

- Modify: `src/components/SessionView.tsx` (ROLE_LABELS at ~150, derived block at ~571, scene eyebrow at ~646, history headers at ~776 and ~1089)

- [ ] **Step 1: Import the helpers and delete the local role map**

At the top of `src/components/SessionView.tsx`, add:

```tsx
import {
  latestSceneMessages,
  messageAuthor,
  sceneEyebrow,
} from "../session-view-model";
```

Delete the local block:

```tsx
const ROLE_LABELS: Record<Message["role"], string> = {
  PLAYER: "Pemain",
  NARRATOR: "Narator",
  NPC: "NPC",
  SYSTEM_EVENT: "Sistem",
};
```

- [ ] **Step 2: Replace direct message scans with the scene model**

Replace:

```tsx
const turnCount = new Set(messages.map((message) => message.turnId)).size;
const latestNarrator = [...messages]
  .reverse()
  .find((message) => message.role === "NARRATOR");
const latestNpc = [...messages]
  .reverse()
  .find((message) => message.role === "NPC");
```

with:

```tsx
const turnCount = new Set(messages.map((message) => message.turnId)).size;
const { narration: latestNarrator, dialogue: latestNpc } =
  latestSceneMessages(messages);
const npcNames = Object.fromEntries(def.npcs.map((npc) => [npc.id, npc.name]));
```

- [ ] **Step 3: Replace the chapter eyebrow**

Replace:

```tsx
<span className="eyebrow">
  Bab {String(Math.max(turnCount, 1)).padStart(2, "0")} · {locationLabel}
</span>
```

with:

```tsx
<span className="eyebrow">{sceneEyebrow(turnCount, locationLabel)}</span>
```

- [ ] **Step 4: Replace raw speaker IDs in both history headers**

Replace both occurrences of:

```tsx
#{message.sequence} {ROLE_LABELS[message.role]}
{message.speakerId ? ` (${message.speakerId})` : ""}
```

with:

```tsx
#{message.sequence} {messageAuthor(message, npcNames)}
```

In the “Dunia” panel history, replace:

```tsx
#{message.sequence} {ROLE_LABELS[message.role]}
```

with:

```tsx
#{message.sequence} {messageAuthor(message, npcNames)}
```

- [ ] **Step 5: Verify no raw IDs or chapter labels remain**

Run:

```powershell
Select-String -Path src/components/SessionView.tsx -Pattern 'speakerId|ROLE_LABELS|Bab \{'
```

Expected: no output.

- [ ] **Step 6: Run checks and commit**

Run: `npm.cmd run check`
Expected: typecheck and format pass.

Run: `npm.cmd test`
Expected: all tests pass (164 baseline + 5 new).

```powershell
git add src/components/SessionView.tsx
git commit -m "fix(ui): scope scene dialogue and remove raw speaker ids"
```

---

## Task 3: Settings primitives (TDD)

**Files:**

- Create: `src/components/SettingsPrimitives.tsx`
- Test: `tests/settings-primitives.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/settings-primitives.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let vite;
let primitives;

test.before(async () => {
  vite = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  primitives = await vite.ssrLoadModule(
    "/src/components/SettingsPrimitives.tsx",
  );
});

test.after(async () => {
  await vite?.close();
});

test("data status row shows the local-storage trust label", () => {
  const ready = renderToStaticMarkup(
    createElement(primitives.DataStatusRow, {
      status: "ready",
      error: null,
    }),
  );
  assert.match(ready, /<span>Data<\/span>/);
  assert.match(ready, /Tersimpan lokal/);

  const failed = renderToStaticMarkup(
    createElement(primitives.DataStatusRow, {
      status: "unavailable",
      error: "putus",
    }),
  );
  assert.match(failed, /Tidak tersedia/);
  assert.match(failed, /Data lokal tidak dapat dibaca: putus/);
});

test("text size control is a labelled segmented radiogroup", () => {
  const markup = renderToStaticMarkup(
    createElement(primitives.TextSizeControl, {
      value: "normal",
      onChange: () => {},
    }),
  );
  assert.match(markup, /role="radiogroup"/);
  assert.match(markup, /aria-labelledby="text-size-label"/);
  assert.match(markup, /Ukuran teks cerita/);
  assert.match(markup, /Standar/);
  assert.match(markup, /Besar/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/settings-primitives.test.mjs`
Expected: FAIL — cannot resolve `/src/components/SettingsPrimitives.tsx`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/components/SettingsPrimitives.tsx`:

```tsx
export type DataStatus = "checking" | "ready" | "unavailable";
export type SettingsTextSize = "normal" | "large";

const TEXT_SIZE_OPTIONS: { value: SettingsTextSize; label: string }[] = [
  { value: "normal", label: "Standar" },
  { value: "large", label: "Besar" },
];

interface DataStatusRowProps {
  status: DataStatus;
  error: string | null;
}

export function DataStatusRow({ status, error }: DataStatusRowProps) {
  const label =
    status === "ready"
      ? "Tersimpan lokal"
      : status === "checking"
        ? "Memeriksa…"
        : "Tidak tersedia";
  return (
    <section aria-label="Status data" aria-live="polite">
      <div className="setting-row">
        <span>Data</span>
        <span
          className={
            status === "unavailable" ? "status status-error" : "status"
          }
        >
          {label}
        </span>
      </div>
      {status === "unavailable" && error ? (
        <p className="error" role="alert">
          Data lokal tidak dapat dibaca: {error}
        </p>
      ) : null}
    </section>
  );
}

interface TextSizeControlProps {
  value: SettingsTextSize;
  onChange: (value: SettingsTextSize) => void;
}

export function TextSizeControl({ value, onChange }: TextSizeControlProps) {
  return (
    <div className="setting-row">
      <span id="text-size-label">Ukuran teks cerita</span>
      <div
        className="segmented"
        role="radiogroup"
        aria-labelledby="text-size-label"
      >
        {TEXT_SIZE_OPTIONS.map((option) => (
          <label
            key={option.value}
            className={option.value === value ? "selected" : undefined}
          >
            <input
              type="radio"
              name="text-size"
              value={option.value}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test**

Run: `node --test tests/settings-primitives.test.mjs`
Expected: PASS — 2 tests, 0 failures.

- [ ] **Step 5: Format and commit**

```powershell
npx.cmd prettier --write src/components/SettingsPrimitives.tsx tests/settings-primitives.test.mjs
git add src/components/SettingsPrimitives.tsx tests/settings-primitives.test.mjs
git commit -m "feat(ui): add paper settings primitives"
```

---

## Task 4: Wire settings primitives into SettingsPanel

**Files:**

- Modify: `src/components/SettingsPanel.tsx` (state at ~92, health effect at ~251, status render at ~669, text-size control at ~1098)
- Modify: `src/styles.css` (paper setting rows/segmented/status)

- [ ] **Step 1: Import the primitives**

Add near the other component imports:

```tsx
import {
  DataStatusRow,
  TextSizeControl,
  type DataStatus,
} from "./SettingsPrimitives";
```

- [ ] **Step 2: Replace the backend status state**

Replace:

```tsx
const [backendStatus, setBackendStatus] = useState<string | null>(null);
const [backendError, setBackendError] = useState<string | null>(null);
```

with:

```tsx
const [backendStatus, setBackendStatus] = useState<DataStatus>("checking");
const [backendError, setBackendError] = useState<string | null>(null);
```

- [ ] **Step 3: Stop exposing Node/schema internals**

Replace the health effect body:

```tsx
void getHealth()
  .then((health) => {
    setBackendStatus(
      `Siap · Node ${health.nodeVersion} · schema ${health.schemaVersion}`,
    );
    setBackendError(null);
  })
  .catch((error: unknown) => {
    setBackendStatus(null);
    setBackendError(errorText(error, "Backend tidak tersedia."));
  });
```

with:

```tsx
void getHealth()
  .then(() => {
    setBackendStatus("ready");
    setBackendError(null);
  })
  .catch((error: unknown) => {
    setBackendStatus("unavailable");
    setBackendError(errorText(error, "Data lokal tidak dapat dibaca."));
  });
```

- [ ] **Step 4: Replace the settings status section**

Replace:

```tsx
<section aria-label="Status backend" aria-live="polite">
  <h2>Backend lokal</h2>
  {backendStatus && <p role="status">{backendStatus}</p>}
  {backendError && (
    <p className="error" role="alert">
      Backend tidak tersedia: {backendError}
    </p>
  )}
</section>
```

with:

```tsx
<DataStatusRow status={backendStatus} error={backendError} />
```

- [ ] **Step 5: Replace the text-size radio block**

Replace the `.radio-row` block inside the “Tampilan” section with:

```tsx
<TextSizeControl value={textSizeDraft} onChange={setTextSizeDraft} />
```

Keep the existing `Simpan ukuran teks` button and its `disabled={!textSizeDirty}` logic unchanged.

- [ ] **Step 6: Add the paper styles**

Append to `src/styles.css`, immediately after the `.paper .radio-row` rule:

```css
.paper .setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  border-top: 1px solid var(--paper-line);
  padding: 18px 0;
  margin-top: 18px;
}

.paper .status {
  font: 12px var(--mono);
  color: var(--paper-green);
}

.paper .status-error {
  color: var(--paper-danger);
}

.paper .segmented {
  display: inline-flex;
  border: 1px solid var(--paper-line-strong);
  border-radius: var(--radius);
  overflow: hidden;
  background: #fbf8f1;
}

.paper .segmented label {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  margin: 0;
  padding: 0 14px;
  font-size: 13px;
  cursor: pointer;
}

.paper .segmented label + label {
  border-left: 1px solid var(--paper-line-strong);
}

.paper .segmented label.selected {
  background: var(--brass);
  color: var(--brass-ink);
}

.paper .segmented input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  margin: 0;
}
```

- [ ] **Step 7: Remove the now-unused paper radio-row styles**

Only `SettingsPanel` used `.radio-row`; after Step 5 nothing does. Delete the `.paper .radio-row { ... }` and `.paper .radio-row label { ... }` blocks from `src/styles.css`.

Run: `Select-String -Path src/styles.css -Pattern 'radio-row'`
Expected: no output.

- [ ] **Step 8: Run checks and commit**

Run: `npm.cmd run check`
Expected: pass.

Run: `npm.cmd test`
Expected: all tests pass.

```powershell
git add src/components/SettingsPanel.tsx src/styles.css
git commit -m "feat(ui): align settings status and text size with the paper design"
```

---

## Task 5: Language and raw-ID cleanup

**Files:**

- Modify: `src/components/SessionView.tsx`, `src/components/GameEditor.tsx`, `src/components/SettingsPanel.tsx`, `src/components/AiProfilesPanel.tsx`

- [ ] **Step 1: Apply the label replacements**

| File                                 | Old                                                                             | New                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/components/SessionView.tsx`     | `Export save`                                                                   | `Ekspor save`                                                                     |
| `src/components/SessionView.tsx`     | `Import save`                                                                   | `Impor save`                                                                      |
| `src/components/GameEditor.tsx`      | `Export JSON template`                                                          | `Ekspor template JSON`                                                            |
| `src/components/GameEditor.tsx`      | `Import JSON template`                                                          | `Impor template JSON`                                                             |
| `src/components/GameEditor.tsx`      | `Settings` (toolbar button)                                                     | `Pengaturan`                                                                      |
| `src/components/SettingsPanel.tsx`   | `` `Restore save berhasil sebagai salinan baru (${ids.gameId.slice(0, 8)}).` `` | `` `Pemulihan save berhasil sebagai salinan baru (${ids.gameId.slice(0, 8)}).` `` |
| `src/components/SettingsPanel.tsx`   | `` `Restore save gagal: ${...}` ``                                              | `` `Pemulihan save gagal: ${...}` ``                                              |
| `src/components/SettingsPanel.tsx`   | `aria-label="Restore save"`                                                     | `aria-label="Pulihkan save"`                                                      |
| `src/components/SettingsPanel.tsx`   | `<h2>Restore save</h2>`                                                         | `<h2>Pulihkan save</h2>`                                                          |
| `src/components/SettingsPanel.tsx`   | `aria-label="Backup backend"`                                                   | `aria-label="Backup data"`                                                        |
| `src/components/SettingsPanel.tsx`   | `<h2>Backup backend</h2>`                                                       | `<h2>Backup data</h2>`                                                            |
| `src/components/SettingsPanel.tsx`   | `Model ID`                                                                      | `ID model`                                                                        |
| `src/components/AiProfilesPanel.tsx` | `Model ID`                                                                      | `ID model`                                                                        |

- [ ] **Step 2: Verify the contract strings are gone**

Run:

```powershell
Select-String -Path src/components/*.tsx -Pattern 'Export save|Import save|Export JSON template|Import JSON template|Restore save|\bSettings\b|Model ID'
```

Expected: no output.

Run:

```powershell
Select-String -Path src/components/*.tsx -Pattern 'speakerId'
```

Expected: no output.

- [ ] **Step 3: Run tests and commit**

Run: `npm.cmd test`
Expected: all tests pass.

```powershell
npx.cmd prettier --write src/components/SessionView.tsx src/components/GameEditor.tsx src/components/SettingsPanel.tsx src/components/AiProfilesPanel.tsx
git add src/components/SessionView.tsx src/components/GameEditor.tsx src/components/SettingsPanel.tsx src/components/AiProfilesPanel.tsx
git commit -m "fix(ui): keep product labels in Indonesian"
```

---

## Task 6: Disabled nav state and accessible delete dialog

**Files:**

- Modify: `src/styles.css` (nav disabled)
- Create: `src/components/ConfirmDialog.tsx`
- Test: `tests/confirm-dialog.test.mjs`
- Modify: `src/components/GameLibrary.tsx`

- [ ] **Step 1: Write the failing dialog test**

Create `tests/confirm-dialog.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let vite;
let ConfirmDialog;

test.before(async () => {
  vite = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  ({ default: ConfirmDialog } = await vite.ssrLoadModule(
    "/src/components/ConfirmDialog.tsx",
  ));
});

test.after(async () => {
  await vite?.close();
});

test("delete confirmation renders a labelled paper dialog", () => {
  const markup = renderToStaticMarkup(
    createElement(ConfirmDialog, {
      open: true,
      title: "Hapus cerita?",
      message: 'Hapus "Pesisir Utara" secara permanen?',
      confirmLabel: "Hapus permanen",
      onConfirm: () => {},
      onCancel: () => {},
    }),
  );
  assert.match(markup, /<dialog/);
  assert.match(markup, /aria-labelledby="confirm-dialog-title"/);
  assert.match(markup, /<h2 id="confirm-dialog-title">Hapus cerita\?<\/h2>/);
  assert.match(markup, /Hapus permanen/);
  assert.match(markup, />Batal</);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/confirm-dialog.test.mjs`
Expected: FAIL — cannot resolve `/src/components/ConfirmDialog.tsx`.

- [ ] **Step 3: Write the dialog component**

Create `src/components/ConfirmDialog.tsx`:

```tsx
import { useEffect, useRef } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="confirm-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClose={onCancel}
    >
      <h2 id="confirm-dialog-title">{title}</h2>
      <p>{message}</p>
      <div className="row">
        <button type="button" onClick={onCancel}>
          Batal
        </button>
        <button type="button" className="primary" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
```

- [ ] **Step 4: Run the dialog test**

Run: `node --test tests/confirm-dialog.test.mjs`
Expected: PASS — 1 test.

- [ ] **Step 5: Replace `window.confirm` in GameLibrary**

Add the import:

```tsx
import ConfirmDialog from "./ConfirmDialog";
```

Add state next to the other local state:

```tsx
const [pendingDelete, setPendingDelete] = useState<GameRecord | null>(null);
```

Replace `async function handleDelete(record: GameRecord) { ... }` (including the `window.confirm` block) with:

```tsx
function requestDelete(record: GameRecord) {
  setPendingDelete(record);
}

async function confirmDelete() {
  const record = pendingDelete;
  if (!record) return;
  setPendingDelete(null);
  const gameId = record.value.id;
  setBusy(true);
  try {
    await deleteGame(gameId, record.revision);
    setDeleteErrors((current) => ({ ...current, [gameId]: "" }));
    await onRefresh();
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) await onRefresh();
    setDeleteErrors((current) => ({
      ...current,
      [gameId]: error instanceof Error ? error.message : "Game gagal dihapus.",
    }));
  } finally {
    setBusy(false);
  }
}
```

Change the menu button:

```tsx
onClick={() => void handleDelete(record)}
```

to:

```tsx
onClick={() => requestDelete(record)}
```

Add the dialog before the closing `</section>` of the library component:

```tsx
<ConfirmDialog
  open={pendingDelete !== null}
  title="Hapus cerita?"
  message={`Hapus "${pendingDelete?.value.title ?? ""}" beserta seluruh sesi, riwayat pesan, dan data run-nya secara permanen?`}
  confirmLabel="Hapus permanen"
  onConfirm={() => void confirmDelete()}
  onCancel={() => setPendingDelete(null)}
/>
```

- [ ] **Step 6: Style the disabled rail item**

Append to `src/styles.css`, immediately after `.nav.active`:

```css
.nav:disabled,
.nav:disabled:hover {
  color: var(--muted);
  background: transparent;
  border-color: transparent;
  box-shadow: none;
  opacity: 0.55;
  cursor: not-allowed;
}
```

- [ ] **Step 7: Run checks and commit**

Run: `npm.cmd run check`
Expected: pass.

Run: `npm.cmd test`
Expected: all tests pass (164 baseline + 8 new across Tasks 1, 3, and 6).

```powershell
npx.cmd prettier --write src/components/ConfirmDialog.tsx src/components/GameLibrary.tsx src/styles.css tests/confirm-dialog.test.mjs
git add src/components/ConfirmDialog.tsx src/components/GameLibrary.tsx src/styles.css tests/confirm-dialog.test.mjs
git commit -m "feat(ui): add themed delete confirmation and disabled nav state"
```

---

## Task 7: 3:2 covers and deterministic cover selection (TDD)

**Files:**

- Create: `src/assets/covers/coast.svg`, `src/assets/covers/lantern.svg`, `src/assets/covers/archive.svg`
- Test: `tests/covers.test.mjs`
- Modify: `src/library.ts`, `src/illustrations.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/covers.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createServer } from "vite";

const COVERS = ["coast", "lantern", "archive"];
let vite;
let library;

test.before(async () => {
  vite = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  library = await vite.ssrLoadModule("/src/library.ts");
});

test.after(async () => {
  await vite?.close();
});

test("every cover asset is a 3:2 illustration", () => {
  for (const name of COVERS) {
    const svg = readFileSync(`src/assets/covers/${name}.svg`, "utf8");
    const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1];
    assert.ok(viewBox, `${name}.svg must declare a viewBox`);
    const [, , width, height] = viewBox.trim().split(/\s+/).map(Number);
    assert.equal(width / height, 1.5, `${name}.svg must be 3:2`);
  }
});

test("cover selection is deterministic and genre-aware", () => {
  assert.equal(
    library.coverIdFor({ genre: "Fantasy adventure RPG", title: "Ragnarok" }),
    "lantern",
  );
  assert.equal(
    library.coverIdFor({ genre: "Drama", title: "Arsip Hujan" }),
    "archive",
  );
  assert.equal(
    library.coverIdFor({ genre: "Misteri", title: "Pesisir Utara" }),
    "coast",
  );
  const first = library.coverIdFor({ genre: "", title: "Dunia Tanpa Genre" });
  const second = library.coverIdFor({ genre: "", title: "Dunia Tanpa Genre" });
  assert.equal(first, second);
  assert.ok(COVERS.includes(first));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/covers.test.mjs`
Expected: FAIL — `ENOENT` for `src/assets/covers/coast.svg`.

- [ ] **Step 3: Create the fallback cover assets**

Create `src/assets/covers/coast.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 600" width="900" height="600">
  <rect width="900" height="600" fill="#b8dce5"/>
  <g fill="#f8f5e7"><ellipse cx="150" cy="90" rx="110" ry="24"/><ellipse cx="390" cy="130" rx="80" ry="20"/><ellipse cx="600" cy="70" rx="100" ry="22"/></g>
  <path d="M0 300Q150 220 300 305T650 290L900 230V600H0Z" fill="#78988d"/>
  <path d="M0 340Q230 280 470 360L720 600H0Z" fill="#73b6c4"/>
  <path d="M0 390Q160 360 390 420M30 470Q250 400 480 500M0 540Q190 480 380 545" fill="none" stroke="#e7f2e7" stroke-width="8"/>
  <path d="M900 200L520 600H900Z" fill="#d4c6a5"/>
  <path d="M900 320L560 600M900 420L640 600" stroke="#565c4d" stroke-width="10"/>
  <g transform="translate(690 330)"><rect width="140" height="110" rx="14" fill="#365c49"/><rect x="12" y="18" width="116" height="36" rx="6" fill="#d9e7dd"/><path d="M0 68H140" stroke="#c6b77e" stroke-width="14"/><circle cx="26" cy="96" r="9" fill="#eee4bd"/><circle cx="114" cy="96" r="9" fill="#eee4bd"/></g>
</svg>
```

Create `src/assets/covers/lantern.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 600" width="900" height="600">
  <rect width="900" height="600" fill="#303e49"/>
  <circle cx="700" cy="110" r="42" fill="#e8d2a0"/>
  <path d="M0 360L160 120 330 380 470 200 680 420 830 130 900 300V600H0Z" fill="#506064"/>
  <path d="M0 470L240 240 460 500 700 260 900 460V600H0Z" fill="#273e3d"/>
  <g fill="#bba47d"><path d="M330 320H570V600H330Z"/><path d="M380 230H520V330H380Z"/></g>
  <g fill="#253a3b"><path d="M285 335Q450 300 615 335L575 285H325Z"/><path d="M340 245Q450 215 560 245L525 190H375Z"/></g>
  <g fill="#e1ab61"><rect x="352" y="400" width="40" height="70"/><rect x="430" y="400" width="40" height="70"/><rect x="508" y="400" width="40" height="70"/><circle cx="190" cy="500" r="14"/><circle cx="690" cy="510" r="14"/></g>
  <path d="M390 600L438 500H464L510 600" fill="#c6a47a"/>
</svg>
```

Create `src/assets/covers/archive.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 600" width="900" height="600">
  <rect width="900" height="600" fill="#2b333a"/>
  <g stroke="#8fa3ad" stroke-width="4" stroke-linecap="round" opacity=".55">
    <path d="M90 80l-18 70M200 40l-18 70M320 100l-18 70M470 60l-18 70M620 110l-18 70M760 50l-18 70"/>
  </g>
  <path d="M120 300h660v300H120Z" fill="#3d444b"/>
  <path d="M150 220h600v90H150Z" fill="#4a5158"/>
  <g fill="#d4c6a5"><rect x="170" y="330" width="120" height="270"/><rect x="330" y="330" width="120" height="270"/><rect x="490" y="330" width="120" height="270"/><rect x="650" y="330" width="90" height="270"/></g>
  <g fill="#6f5940"><path d="M190 360h80v18H190zM190 400h80v18H190zM190 440h80v18H190zM350 370h80v18H350zM350 410h80v18H350zM510 360h80v18H510zM510 400h80v18H510z"/></g>
  <g fill="#e1ab61"><rect x="690" y="380" width="40" height="40"/><circle cx="770" cy="250" r="16"/></g>
  <path d="M0 560h900v40H0Z" fill="#20262b"/>
</svg>
```

- [ ] **Step 4: Add the cover-selection helper**

In `src/library.ts`, add the type import and function:

```ts
import type { GameDefinition } from "./types";

export type CoverId = "coast" | "lantern" | "archive";

export function coverIdFor(
  game: Pick<GameDefinition, "genre" | "title">,
): CoverId {
  const genre = (game.genre ?? "").toLocaleLowerCase("id");
  if (genre.includes("fantasi") || genre.includes("fantasy")) return "lantern";
  if (genre.includes("drama")) return "archive";
  if (genre.includes("misteri") || genre.includes("mystery")) return "coast";
  let hash = 7;
  for (const character of game.title) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 9973;
  }
  return (["coast", "lantern", "archive"] as const)[hash % 3];
}
```

- [ ] **Step 5: Map cover ids to bundled art**

Replace the whole of `src/illustrations.ts` with:

```ts
import archive from "./assets/covers/archive.svg";
import coast from "./assets/covers/coast.svg";
import lantern from "./assets/covers/lantern.svg";
import { coverIdFor, type CoverId } from "./library";
import type { GameDefinition } from "./types";

const COVERS: Record<CoverId, string> = { coast, lantern, archive };

export function storyIllustration(
  game: Pick<GameDefinition, "genre" | "title">,
): string {
  return COVERS[coverIdFor(game)];
}
```

- [ ] **Step 6: Run the tests and the build**

Run: `node --test tests/covers.test.mjs`
Expected: PASS — 2 tests.

Run: `npm.cmd run build`
Expected: Vite resolves all three SVG imports and both builds succeed.

- [ ] **Step 7: Format and commit**

```powershell
npx.cmd prettier --write src/library.ts src/illustrations.ts tests/covers.test.mjs
git add src/assets/covers src/library.ts src/illustrations.ts tests/covers.test.mjs
git commit -m "feat(ui): add 3:2 world covers with genre-aware selection"
```

---

## Task 8 (GATED): Self-hosted fonts and original texture

**Files:**

- Create (only if G1 files exist): `src/assets/fonts/*.woff2`
- Test: `tests/ui-fonts.test.mjs`
- Modify: `src/styles.css`

- [ ] **Step 1: Check the gate**

Run:

```powershell
Get-ChildItem src/assets/fonts -ErrorAction SilentlyContinue
```

Expected (gate satisfied): the four `.woff2` files listed in Gate G1.
If the folder is missing or incomplete: **stop Task 8**, keep the fallback stacks, and continue at Task 9. Record the unmet gate in Task 10.

- [ ] **Step 2: Write the font asset test**

Create `tests/ui-fonts.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const FONTS = [
  "newsreader-normal-400-600.woff2",
  "newsreader-italic-400-500.woff2",
  "public-sans-normal-400-600.woff2",
  "ibm-plex-mono-normal-400.woff2",
];

test("design fonts are bundled as WOFF2", () => {
  for (const name of FONTS) {
    const bytes = readFileSync(`src/assets/fonts/${name}`);
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "wOF2", name);
  }
});
```

- [ ] **Step 3: Run the font test**

Run: `node --test tests/ui-fonts.test.mjs`
Expected: PASS — 1 test. If it fails, the files are not valid WOFF2; do not continue.

- [ ] **Step 4: Add the `@font-face` declarations**

Insert at the top of `src/styles.css`, before `:root`:

```css
@font-face {
  font-family: Newsreader;
  src: url("./assets/fonts/newsreader-normal-400-600.woff2") format("woff2");
  font-weight: 400 600;
  font-display: swap;
}

@font-face {
  font-family: Newsreader;
  src: url("./assets/fonts/newsreader-italic-400-500.woff2") format("woff2");
  font-weight: 400 500;
  font-style: italic;
  font-display: swap;
}

@font-face {
  font-family: "Public Sans";
  src: url("./assets/fonts/public-sans-normal-400-600.woff2") format("woff2");
  font-weight: 400 600;
  font-display: swap;
}

@font-face {
  font-family: "IBM Plex Mono";
  src: url("./assets/fonts/ibm-plex-mono-normal-400.woff2") format("woff2");
  font-display: swap;
}
```

- [ ] **Step 5: Replace the reconstructed texture if the export provides one**

If the export supplies the original leather texture, copy it over `src/assets/leather.svg` and verify the rail still renders the `.texture::before` layer at `opacity: 0.08`. Otherwise leave the reconstructed file in place and note it.

- [ ] **Step 6: Verify and commit**

Run: `npm.cmd run build`
Expected: fonts are emitted into `dist/client/assets`.

Run: `node --test tests/ui-fonts.test.mjs`
Expected: PASS.

```powershell
npx.cmd prettier --write src/styles.css tests/ui-fonts.test.mjs
git add src/assets/fonts src/assets/leather.svg src/styles.css tests/ui-fonts.test.mjs
git commit -m "feat(ui): bundle the design typography assets"
```

---

## Task 9: Reusable nine-viewport UI check

**Files:**

- Create: `scripts/ui-check.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add the script**

Create `scripts/ui-check.mjs`:

```js
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VIEWPORTS = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 600, height: 960 },
  { width: 820, height: 1180 },
  { width: 1024, height: 768 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];
const BASE_URL = process.argv[2] ?? "http://127.0.0.1:5173/";
const OUTPUT_DIRECTORY = process.env.UI_CHECK_OUTPUT ?? ".pstack/ui-check";
const DEBUG_PORT = 9333;
const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
const edgePath = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
if (!edgePath) {
  console.error("Microsoft Edge tidak ditemukan. Set EDGE_PATH.");
  process.exit(1);
}

mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
const profileDirectory = mkdtempSync(join(tmpdir(), "fworld-ui-check-"));
const edge = spawn(
  edgePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function pageSocketUrl() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      ).json();
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // The browser has not opened the debugging port yet.
    }
    await sleep(250);
  }
  throw new Error("CDP tidak siap setelah 10 detik.");
}

let socket;
try {
  socket = new WebSocket(await pageSocketUrl());
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  const failures = [];
  for (const viewport of VIEWPORTS) {
    await send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.width <= 430,
    });
    await send("Page.navigate", { url: BASE_URL });
    await sleep(4000);
    const overflow = await evaluate(
      "document.documentElement.scrollWidth - window.innerWidth",
    );
    const screenshot = await send("Page.captureScreenshot", {
      format: "png",
    });
    writeFileSync(
      join(OUTPUT_DIRECTORY, `${viewport.width}x${viewport.height}.png`),
      Buffer.from(screenshot.data, "base64"),
    );
    console.log(`${viewport.width}x${viewport.height} overflow=${overflow}`);
    if (overflow > 0) failures.push(`${viewport.width}x${viewport.height}`);
  }
  if (failures.length > 0) {
    console.error(`Horizontal overflow at: ${failures.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("UI viewport check passed.");
  }
} finally {
  socket?.close();
  edge.kill();
}
```

- [ ] **Step 2: Register the npm script**

In `package.json`, add after `"test"`:

```json
"ui:check": "node scripts/ui-check.mjs",
```

- [ ] **Step 3: Run the check**

Terminal 1: `npm.cmd run dev:server`
Terminal 2: `npm.cmd run dev`

Then:

```powershell
npm.cmd run ui:check
```

Expected: nine lines `WxH overflow=0` for 360×800, 390×844, 430×932, 600×960, 820×1180, 1024×768, 1366×768, 1440×900, 1920×1080, then `UI viewport check passed.` Exit code 0.

- [ ] **Step 4: Commit**

```powershell
npx.cmd prettier --write scripts/ui-check.mjs package.json
git add scripts/ui-check.mjs package.json
git commit -m "test(ui): add nine-viewport overflow check"
```

---

## Task 10: Documentation, manifest evidence, final verification

**Files:**

- Modify: `README.md`
- Modify: `.harness/manifest.json`

- [ ] **Step 1: Update the README “Tampilan” section**

After the sentence that describes the rail breakpoints, add:

```markdown
Panggung cerita memberi label **Adegan N · lokasi** (turn bukan bab) dan memakai judul dunia sebagai judul panggung. Dialog hanya diambil dari turn terakhir; percakapan turn lama tetap ada di riwayat. Kartu dunia memakai tiga sampul 3:2 (`coast`, `lantern`, `archive`) yang dipilih dari genre dan judul secara deterministik.
```

If Task 8 ran, replace the fallback-font sentence with:

```markdown
Font Newsreader, Public Sans, dan IBM Plex Mono dibundel dari `src/assets/fonts/` melalui `@font-face` di `src/styles.css`.
```

- [ ] **Step 2: Append verification evidence to the manifest**

Run:

```powershell
node -e "const fs=require('fs');const p='.harness/manifest.json';const m=JSON.parse(fs.readFileSync(p,'utf8'));const shell=m.capabilities.interface_shell;shell.verify=[...new Set([...shell.verify,'npm.cmd run ui:check (360-1920 viewport matrix, zero horizontal overflow)','npm.cmd test (scene turn scoping, settings primitives, delete dialog, cover selection)'])];fs.writeFileSync(p,JSON.stringify(m,null,2)+'\n');"
```

- [ ] **Step 3: Run the full verification**

With the dev servers from Task 9 still running (start them if needed):

```powershell
npm.cmd run doctor
npm.cmd run ui:check
```

Expected: doctor passes (typecheck, format, all tests, builds); `ui:check` prints the nine viewport lines and passes. If doctor fails only on the unrelated backend paths from Task 0, stop and coordinate with that workstream — do not fix or format those files here.

- [ ] **Step 4: Format and commit**

```powershell
npx.cmd prettier --write README.md .harness/manifest.json
git add README.md .harness/manifest.json
git commit -m "docs(ui): record gap-closure verification"
```

---

## Deferred — separate design + implementation plan

These items from the gap report are intentionally **not** in this plan. Each needs a design decision or a data-contract change; implementing them here would invent behavior.

| Deferred gap                                                           | Why deferred                                                                   | Next concrete step                                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Chapter title separate from world title                                | No field in `GameSession`/`WorldState`; requires narrator schema + migration   | Write a spec for `sceneTitle` in session state, migration v4, validation, and prompt contract; then a separate plan        |
| Featured card turn count (“Giliran 12”)                                | `listSessions` payload has no turn/message stats                               | Add a derived `turnCount` to the session list projection, then update the featured meta                                    |
| Editor, AI profiles, data ops, session panels, history design coverage | No prototype screens exist for them                                            | Author `docs/superpowers/specs/ui-coverage-brief.md` (surfaces, states, dialogs, copy) and a follow-up implementation plan |
| Full state matrix (loading/empty/error/success) per module             | Prototype defines only default/hover/focus/active                              | Include state-by-state designs in the coverage brief before coding                                                         |
| Long-narration layout policy                                           | Product shows the full latest narrator message; prototype assumes a short beat | Decide clamping/fade/scroll; then implement                                                                                |
| Multi-resource notes density                                           | Prototype shows one meter; product can show many                               | Decide drawer scrolling/grouping in the coverage brief                                                                     |
| URL routing/deep links                                                 | Prototype itself is state-driven                                               | Decide route map (`/`, `/sesi/:id`, `/pengaturan`, `/editor/:id`) in a separate plan                                       |
| Tablet rail hides inactive items in the export                         | Product deliberately keeps all three reachable                                 | Document the deviation; no code change                                                                                     |
| Original cover artwork fidelity                                        | G2 assets absent                                                               | Replace fallback SVGs at the same paths when the export is available                                                       |

---

## Definition of done

- [ ] `npm.cmd run doctor` passes.
- [ ] `npm.cmd run ui:check` passes all nine viewports with zero horizontal overflow.
- [ ] Scene dialogue never comes from an older turn; eyebrow says “Adegan”, not “Bab”.
- [ ] No raw `speakerId` or English action label remains in the UI.
- [ ] Settings show a paper “Data · Tersimpan lokal” row and a labelled segmented text-size control; saving still requires the existing button.
- [ ] Rail “Sesi” has a visible disabled state; deleting a world uses the themed dialog.
- [ ] Three 3:2 covers are wired; genre/title selection is deterministic and tested.
- [ ] Typography assets are either bundled (Task 8) or recorded as blocked with fallbacks intact.
- [ ] Manifest and README evidence updated; every task committed.

## Risks

- **G1/G2 may stay unfulfilled**, limiting visual fidelity to fallback fonts and re-authored covers. Recorded as a manifest gap, not silently ignored.
- **CDP check depends on local Edge** and a running dev server; it is a developer verification tool, not a CI gate yet.
- **Cover fallback art is an approximation** of the missing export art and must be replaced when originals arrive.
- **Text-size save semantics** conflict with the prototype’s immediate toggle; this plan preserves the existing save model because README/PRD require it.
- **Chapter titles and featured turn counts** remain unavailable until their data contracts change; do not fake them with turn counters.

## Self-review

**Spec coverage:** the original gap report’s actionable items map to Tasks 1–10 (see traceability table); design-coverage items are explicitly deferred with next steps.

**Placeholder scan:** every code step contains complete code; asset gates are explicit conditionals, not placeholders; no “TBD”/“handle edge cases” instructions remain.

**Type consistency:** `SceneMessages`/`sceneEyebrow`/`messageAuthor` are defined in Task 1 and consumed in Task 2; `DataStatus`/`SettingsTextSize` are defined in Task 3 and consumed in Task 4; `CoverId`/`coverIdFor` are defined in Task 7 before `illustrations.ts` consumes them; `ConfirmDialog` props match the GameLibrary call site in Task 6.

---

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-10-21-ui-prototype-gap-closure.md`. Two execution options:

1. **Subagent-driven (recommended)** — dispatch one fresh subagent per task, review each diff and test output before moving on.
2. **Inline execution** — execute tasks in this session in batches with checkpoints, running `npm.cmd run doctor` after each batch.

Which approach?
