# Fworld — UI/UX Redesign Plan

**Status:** Direction approved — C. Cinematic Chapter with a skeuomorphic material layer; ready for prototype
**Scope:** All user-facing screens of Fworld (library, world, session, editor, settings, shared shell)
**Language:** Interface copy in Indonesian; this planning document in English
**Source of truth:** `I:\Gim\Fworld` (read-only reference), especially `src/App.tsx`, `src/components/*`, `src/styles.css`, `mockups/*`, and `prd.md`
**Handoff:** Design Files Markdown → high-fidelity HTML prototype → React/CSS implementation

---

## 1. Intent

Fworld is a personal, locally hosted AI roleplay RPG. Its value is not in dashboards or configuration — it is in **reading and writing a story that remembers**. The interface currently works, but the chrome competes with the story: paper cards, repeated headings, developer-facing labels, mixed navigation models, and a 79 KB editor made of accordions.

This redesign keeps the literary paper-and-ink identity and rebuilds the product around three moves:

1. **Make the story the stage.** A single, continuous night-reading surface with disciplined typography replaces the fragmented message cards.
2. **Make state glanceable.** Player vitals, present characters, inventory, and world facts move into a persistent field-notes rail on desktop and a bottom sheet on mobile, instead of separate page swaps.
3. **Make creation feel like a workshop.** The editor gains a section rail, readiness feedback, live preview, and one clear save/start action instead of a twelve-accordion form.

The result should feel like a leather-bound projection booth: a dark, tactile shell of leather and brass, a letterboxed story that behaves like a film, and a daylight paper desk for building the world.

---

## 2. What exists today

### 2.1 Product model

| Area | Current implementation | User job |
| --- | --- | --- |
| Library | `GameLibrary.tsx` — featured session, world rows, search | Return to a story, create or manage worlds |
| Session | `SessionView.tsx` — story, player, inventory, people, world panels | Read narration, take actions, inspect state |
| Editor | `GameEditor.tsx` — 12 accordion sections, sticky save actions | Define world, player, NPCs, rules, items, lore |
| Settings | `SettingsPanel.tsx` — AI, profiles, appearance, restore, backup, migration | Configure AI, text size, and data recovery |
| Shell | `App.tsx` — header, conditional bottom nav | Move between library and settings |

### 2.2 Audit findings

**P0 — blocks the core experience**

- **Two primary CTAs in one library viewport.** “Lanjutkan cerita” (`GameLibrary.tsx:232`) and “Buat game baru” (`:378`) are both solid primary buttons. The same screen also has row-level arrow buttons. Action hierarchy is unclear.
- **The story is visually fragmented.** Narration sits in a dark `#303236` panel with `#ffdf36` italic text (`src/styles.css:431`), while player messages use a separate beige block (`:556`). Long transcripts read as stacked widgets rather than a continuous scene.
- **Session state is buried.** Attributes, inventory, people, and world facts are sibling pages selected through a header that replaces the title (`SessionView.tsx:583`). While reading, the user cannot see the current scene or their own vitals without leaving the story.
- **Developer copy leaks into the UI.** “Turn committed” (`SessionView.tsx:611`), raw session IDs (`GameLibrary.tsx:357`), and “Scene” labels are implementation language, not story language.
- **Editor navigation is missing.** Twelve `<details>` sections (`GameEditor.tsx:837` onward) with no section index, progress, or preview. Users must scroll and expand to understand their world.

**P1 — quality and consistency**

- **Emoji used as functional icons** throughout: `♧`, `⚙`, `≣`, `⋯`, `→`, `＋`. They render differently across platforms and read as prototype chrome.
- **Navigation model changes by screen.** Bottom nav exists only on Library and Settings (`App.tsx:151`); the editor has a six-button toolbar including Settings; the session has its own back link. Desktop keeps a mobile bottom bar.
- **Settings is one 42 KB scroll.** AI credentials, profile management, text size, restore, backup, and IndexedDB migration share equal visual weight. Destructive data tools sit beside routine preferences.
- **The desktop layout is a stretched phone.** `main` maxes at 1080 px, the reading column at 680 px, and the global nav stays pinned to the bottom of the viewport.
- **Entity and card styling repeats one pattern.** `.card`, `.entity`, and the left-border treatment create visual noise without clarifying hierarchy.
- **Meters are unstyled native `<meter>` elements** (`styles.css:1082`) with no numeric scale or value context.

**P2 — polish**

- Eyebrows are 11 px with 0.15em tracking (`styles.css:166`), below comfortable reading size.
- The library repeats cover, title, date, status, genre, and session list at the same visual weight.
- Empty states are plain sentences with no next step or visual anchor.
- The only two cover illustrations are genre-keyed SVGs (`src/illustrations.ts`), which makes every non-fantasy world look identical.
- `window.confirm` handles permanent deletion instead of a designed confirmation.

### 2.3 What to keep

- The literary tone, the serif-and-sans pairing, and the amber-on-dark narration idea are worth keeping; the palette moves from paper chrome to a nocturnal cinema shell.
- Serif display type for narrative surfaces and sans for controls is the right pairing.
- The mobile-first, 44 px control sizing and visible focus outlines are solid foundations.
- The amber-on-dark narration requirement from the product README is distinctive. Keep the idea, refine the execution.
- The data model and flows are sound; this is an interface and interaction redesign, not a product rewrite.

---

## 3. Design direction

### 3.1 Concept: “Cinematic Chapter — a tactile nocturne”

The product is a film; the app is its projection booth. The shell is dark leather with brass hardware, the story is a warm, letterboxed scene, and the editor opens onto a daylight paper desk. Skeuomorphism is used for touch: bevels, inset wells, and material edges tell the user what can be pressed, pulled, or written on. It is never decorative nostalgia.

### 3.2 Principles

1. **Quiet chrome, loud story.** Navigation and controls recede. The reading surface is the most crafted object in the product.
2. **One primary action per viewport.** Create, continue, save, and send are state-aware, never simultaneous competitors.
3. **State within reach.** Story context and player state are visible or one gesture away, not a page navigation.
4. **Write like a person.** All labels, errors, and status copy use story language in Indonesian; no internal IDs or turn mechanics.
5. **Depth must explain touch.** Bevels, inset wells, brass edges, and paper grain signal affordance. No gloss, glass, stitching, rivets, or texture behind body text.
6. **Light for thinking, dark for reading.** The editor is daylight paper; every other screen is nocturnal.

### 3.3 Visual system

**Nocturnal shell tokens (OKLCH seeds)**

| Token | Value | Role |
| --- | --- | --- |
| `--bg` | `oklch(0.17 0.012 160)` | Shell ground |
| `--surface` | `oklch(0.215 0.014 160)` | Leather rail and panels |
| `--surface-2` | `oklch(0.25 0.014 160)` | Raised hardware, hover |
| `--fg` | `oklch(0.93 0.01 90)` | Ivory text |
| `--muted` | `oklch(0.72 0.015 90)` | Secondary text |
| `--border` | `oklch(0.32 0.012 160)` | Hairlines, panel edges |
| `--accent` | `oklch(0.78 0.11 75)` | Brass/amber: primary action, focus |
| `--accent-ink` | `oklch(0.20 0.02 75)` | Text and icons on brass |
| `--night` | `oklch(0.135 0.010 160)` | Story stage |
| `--night-raised` | `oklch(0.195 0.012 160)` | Composer well, inset controls |
| `--story` | `oklch(0.885 0.06 85)` | Narration amber |
| `--story-muted` | `oklch(0.72 0.03 85)` | Narration meta |
| `--dialogue` | `oklch(0.955 0.012 90)` | Quoted dialogue, ivory |
| `--danger` | `oklch(0.62 0.17 25)` | Destructive actions and errors |

**Daylight editor tokens**

| Token | Value | Role |
| --- | --- | --- |
| `--paper` | `oklch(0.955 0.010 85)` | Editor ground |
| `--paper-raised` | `oklch(0.985 0.005 85)` | Fields, raised paper |
| `--paper-ink` | `oklch(0.24 0.015 70)` | Editor text |
| `--paper-muted` | `oklch(0.50 0.012 70)` | Editor secondary text |
| `--paper-line` | `oklch(0.86 0.010 85)` | Editor hairlines |
| `--paper-action` | `oklch(0.28 0.03 155)` | Editor primary button ground |

**Depth and texture tokens**

| Token | Value | Role |
| --- | --- | --- |
| `--bevel` | `inset 0 1px 0 rgb(255 255 255 / 0.06), inset 0 -1px 0 rgb(0 0 0 / 0.45)` | Raised hardware edge |
| `--well` | `inset 0 2px 6px rgb(0 0 0 / 0.45)` | Inputs and composer |
| `--shadow-raised` | `0 1px 0 rgb(0 0 0 / 0.45), 0 12px 28px rgb(0 0 0 / 0.28)` | Sheets, menus, raised controls |
| `--grain-opacity` | `0.025` | Film grain on the stage |
| `--leather-opacity` | `0.03` | Leather fiber on rail and panels |

Rules:

- Brass/amber is the only accent. It appears at most twice per screen as a functional signal: the primary action and the focus/selected state. Brass edges are neutral hardware and must not compete with the primary.
- Nocturnal primary buttons use `--accent` with `--accent-ink`. Daylight primary buttons use `--paper-action` with paper text; brass remains for focus and small hardware.
- Danger is semantic, never decorative.
- Gradients are allowed only as 1 px material edges (brass, bevel highlight) and the stage’s vertical tonal shift, capped at 4% lightness. No full-panel gloss.
- Verify all pairs with textures enabled: body text ≥ 4.5:1, large text and icons ≥ 3:1. Focus rings must remain visible on leather, night, and paper surfaces.

**Materials and depth**

- Two material families only: **leather + brass** for the nocturnal shell; **paper + ink + brass** for the daylight editor. No wood, felt, glass, plastic, or photorealistic textures.
- Grain sits on the stage and page edges at ≤ 3% opacity; leather fiber only on the rail and panel grounds; paper fiber only in the editor. Never behind prose, labels, or inputs.
- Bevel depth is 1–2 px. Pressed controls move down 1 px, lose the top highlight, and deepen the well. No glossy highlights or long specular streaks.
- One signature hardware detail per screen: the rail’s brass spine, a framed cover, or a chapter tab. Never all three at once.
- Sheets and dialogs float on `--shadow-raised`; static cards stay flat and rely on hairlines.
- Textures must be disabled under `prefers-contrast: more`, `forced-colors`, and print.

**Typography**

- Display: **Newsreader** (self-hosted, OFL) — 400/500, tight leading, literary but contemporary.
- Body/UI: **Public Sans** (self-hosted, OFL) — 400/500/600.
- Numerals/meta: **IBM Plex Mono** (self-hosted, OFL) — 400/500, for timecodes, turn counts, folios, and chapter numbers.
- Fallbacks: `"Iowan Old Style", "Palatino Linotype", Georgia, serif` and `system-ui, sans-serif`.
- Scale: 12 / 13 / 14 / 16 / 18 / 20 / 24 / 32 / 40 / 56 / 72 px. Chapter titles may use 56–72 px, one per scene; UI headings never exceed 40 px.
- Story prose is 20 px desktop, 18 px mobile, line-height 1.75–1.8, measure 62–68 characters.
- No Inter, Roboto, Arial, or Fraunces as display faces.

**Space, shape, and density**

- 4 px base; 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96 px steps.
- Radii: 4 px controls, 8 px panels, 14 px sheets; 999 px only for status dots and monogram avatars.
- Borders are 1 px `--border`; on dark surfaces use the top bevel highlight and bottom shadow instead of thick outlines. Avoid thick left bars as decoration.
- Static cards have no shadow. Raised controls use `--shadow-raised`; inputs and the composer use `--well`.
- Icons: inline SVG, 1.5 px stroke, 20 px default, 16 px inline, 24 px navigation. No emoji as icons.

**Motion**

- Control feedback: 160–220 ms. Scene transitions: 400–600 ms, opacity only, with no movement of the prose column.
- A new chapter may fade in a title card and advance the brass progress hairline; it must not delay the first readable line.
- No parallax, spring physics, page flips, or autoplaying ambient motion.
- `prefers-reduced-motion`: scene transitions become instant; only focus and busy states remain animated.

---

## 4. Information architecture

### 4.1 Global shell

**Desktop ≥ 1200 px**

- Persistent left rail (248 px): leather ground with a 1 px brass spine, wordmark, primary destinations (Perpustakaan, Pengaturan), a “Dunia terakhir” quick list, and a footer status dot for the local backend. The rail stays dark even when the editor switches to daylight paper.
- Content area max 1180 px. Library is a cinematic cover wall; world is a title card with session rows; session is a letterboxed stage plus a notes rail; editor is a paper desk with a section index and optional preview.
- No bottom navigation on desktop.

**Tablet 900–1199 px**

- Compact top bar with wordmark, Library, Settings, and contextual actions.
- Session: single reading column; field notes open as a right drawer.
- Editor: section rail collapses to a dropdown.

**Mobile < 900 px**

- Top app bar (56 px): back or wordmark, screen title, one overflow action. The bar uses the leather ground; the editor keeps a paper content area beneath it.
- Bottom tab bar only for top-level destinations: Perpustakaan, Pengaturan. Session replaces it with a story dock; editor replaces it with a save bar.
- Safe-area insets respected. No horizontal scrolling at 360 px.

### 4.2 Screen map

```text
Perpustakaan
├── Lanjutkan cerita
├── Dunia kamu (search, world list)
│   └── World menu: Buka · Edit · Export · Hapus
├── Buat dunia baru (template chooser)
└── Pengaturan

Dunia (world detail)
├── Lanjutkan sesi terakhir
├── Sesi-sesi (rename, pin, hapus)
├── Mulai sesi baru
├── Lorebook terpasang
├── Template & export
└── Edit dunia

Sesi
├── Cerita (default)
│   ├── Adegan / lokasi / waktu / giliran
│   ├── Reading stage
│   ├── Pilihan aksi
│   └── Composer
├── Catatan (field notes)
│   ├── Kamu (attributes, resources)
│   ├── Tas (inventory)
│   ├── Tokoh (present people, relationships)
│   └── Dunia (location, known facts, discoveries)
└── Menu sesi: Pengaturan sesi, Export save, Kembali ke perpustakaan

Editor
├── Ringkasan
├── Skenario
├── Pemain
├── Atribut
├── Sumber daya
├── Relasi
├── Item
├── Inventaris awal
├── NPC
├── Lorebook
└── Pratinjau + kesiapan

Pengaturan
├── AI
├── Profil AI
├── Tampilan
├── Data & pemulihan
└── Tentang backend
```

### 4.3 Navigation rules

- Browser back/forward semantics are preserved through the existing in-app view state; the prototype should mirror them.
- The library “Lanjutkan” path opens the latest session directly. The world row opens **Dunia**, the home for sessions, lorebook, templates, and edit actions.
- Session panels are **not** separate destinations. They open a sheet/drawer and return focus to the trigger.
- Editor sections are deep-linkable within the page via the section rail; changing sections does not discard unsaved drafts.
- The only global primary action is contextual to the screen: Continue, Send, Save, or Create. It never appears twice in one viewport.

---

## 5. Screen specifications

### 5.1 Library — `Perpustakaan`

**Goal:** return to the right story in one action, or start a new world without competing CTAs.

**Layout (desktop)**

- Page header: eyebrow `Perpustakaan`, display title `Dunia untuk kembali.`, supporting line. “Buat dunia baru” is a secondary outlined button in the header, not a primary.
- `Sedang diputar` continue feature: a 21:9 cinematic still with a framed edge, then title, last scene, location/time, and one primary “Lanjutkan cerita”. Copy sits below the image, never over it.
- `Dunia kamu`: search, count, then a poster wall of 3:2 cover cards. Three columns at ≥ 1200 px, two at 900–1199 px, one below 900 px. A brass hairline separates the feature from the wall.
- The wall is the primary browsing surface. The feature card carries the screen’s only solid action.

**World card**

- Cover, title, then a single meta line: status dot · genre · last played.
- Hover/focus raises the card by 1 px and reveals “Buka” / “Lanjutkan” plus a 44 px overflow menu; the actions never shift the layout.
- Sessions are summarized as “3 sesi terakhir” with an expandable list. No raw UUIDs.
- Status: `Siap`, `Draft`, `Aktif` with distinct dot colors and text labels (never color alone).

**States**

- Loading: skeleton feature still + six skeleton posters, not a centered spinner.
- Empty: a composed cover collage, title “Belum ada dunia”, one primary “Buat dunia pertama”, secondary “Lihat contoh template”.
- Search empty: inline message with “Hapus pencarian”.
- Backend error: inline banner with plain-language cause and a secondary “Coba lagi”; the rest of the page remains usable.
- Delete: designed dialog with title, consequence sentence, and destructive “Hapus cerita” button; focus returns to the row menu.

**Do not**

- Show two solid buttons in the same viewport.
- Expose session IDs.
- Put text over a busy illustration without a solid/frosted corner treatment.

### 5.2 Dunia — `Dunia`

**Goal:** give one world a home: resume the current run, start another, inspect lore, and manage templates without opening the editor.

**Layout (desktop)**

- Title-card header: cover in a thin brass frame (≈ 38% width, 3:2), then eyebrow `Dunia`, title, genre · status · last played, description, primary `Lanjutkan sesi terakhir` (or `Mulai sesi pertama`), secondary `Sesi baru`.
- Overflow menu: `Edit dunia`, `Duplikat dunia`, `Export template`, `Hapus dunia`. Only one solid button in the header.
- Body: main column `Sesi`; side column `Lorebook` summary and `Template & data`. Hairline-separated sections on the leather ground, not a stack of cards.

**Sessions**

- Rows sorted pinned first, then latest. Each: title, last narrated line excerpt, last played, turn count.
- Row menu: `Ganti nama`, `Pin`, `Export save`, `Hapus sesi`. Deleting a session never deletes the world.
- Empty state: primary `Mulai sesi pertama`; if the world is not playable, replace it with `Perbaiki dunia` and list the blocking issues.

**New session sheet**

- Read-only summary: world title, player name, pinned lore version, existing session count.
- Optional name, prefilled `Sesi {n} — {location or genre}`; AI profile selector defaulting to the configured default, with a link to `Kelola profil`.
- One primary `Mulai sesi`, secondary `Batal`. State plainly: `Sesi baru memakai template tersimpan. Sesi lama tidak berubah.`

**Lorebook**

- Pack name, version, entry count, license, last updated. Actions: `Lihat isi`, `Kelola lorebook`, or `Pasang lorebook` when none is pinned.

**Templates & data**

- `Simpan sebagai template`, `Export template`, `Duplikat dunia`.
- Duplicate copies the definition and lore pins, **not** sessions or history; say so in the confirmation.

**Mobile**

- Compact cover header; sections stack with sessions first; sticky bottom bar with `Lanjutkan` primary and `Sesi baru` secondary.

**States**

- No sessions, draft world not playable, missing lore pack, AI not configured, and last run failed each get a specific message and one next action.

### 5.3 Session — `Sesi`

**Goal:** a calm, continuous reading and writing experience with state available without losing the scene.

**Header**

- Mobile: back arrow, world title, chapter/location line, overflow menu.
- Desktop: back link, title, chapter/location, focus mode, text-size control, overflow.
- Scene strip below the header: `Pesisir utara · Senja · Hujan ringan` and `Giliran 12` in mono. Replace “Turn committed” and raw “Scene”.

**Focus mode**

- One control hides the rail, header, dock, and notes rail, leaving the letterboxed stage and composer. Prose measure does not change.
- A quiet `Keluar fokus` control and Escape both exit; focus returns to the trigger. No fullscreen API requirement.

**Story stage**

- Letterboxed: a centered column of max 720 px with 48–96 px vertical breathing room, on `--night` with a 2.5% film grain and a soft vignette. Chrome lives outside the stage.
- A 1 px brass progress hairline sits at the top edge of the stage and advances per chapter, not per token.
- Chapter change: a Newsreader title card at 56–72 px fades in over 400–600 ms, once per scene. The first readable line is never delayed.
- Narration: 20 px Newsreader italic in `--story`; quoted dialogue normal `--dialogue`.
- Player action: labeled `KAMU` in mono, warm ivory text, slightly inset, no left color bar and no bubble. It reads as a line in the scene, not a chat message.
- System event: 12 px mono, `--story-muted`, with a hairline above; never green-on-paper.
- Speaker/NPC messages: label in mono, name in small caps; body uses the same prose rules for consistency.
- Message separation: 28–36 px vertical rhythm and a 1 px hairline at 12% opacity. No alternating backgrounds.
- Markdown: headings, lists, quotes, code, and links styled for the night surface. Images render as alt text only, per product rule.
- “Muat riwayat sebelumnya” is a quiet text button at the top with a hairline, not a full-width control.

**Composer**

- Attached to the stage as an inset well: `--night-raised` ground, `--well` shadow, 1–4 line auto-growing textarea.
- Primary send button `Kirim`: brass ground, dark ink, 1 px bevel. Disabled while empty or busy; pressed moves down 1 px.
- Secondary: `Pilihan aksi` toggle if suggestions exist; `Ulangi` when a run fails.
- Helper: `Enter untuk kirim · Shift+Enter untuk baris baru`.
- Busy state: “Narator sedang menulis…” with three static dots under reduced motion; a subtle pulse otherwise. Disable send, keep the draft.
- Error: inline banner directly above the composer with the actual message and one retry action.

**Action choices**

- Rendered as a numbered list (mono 01/02/03) above the composer, each a full-width row with a short label.
- One click sends that action; the row shows a busy state.
- Avoid showing more than four choices. If more, collapse behind “Lihat semua saran”.

**Field notes**

- Desktop ≥ 1280 px: 300 px right rail, sticky, with four collapsible groups: Kamu, Hadir, Tas, Dunia.
  - Kamu: attributes and resources as value + 6 px meter + min/max label.
  - Hadir: monogram, name, role, relationship values.
  - Tas: grouped items with quantity, tags, and expandable description.
  - Dunia: location, time, known locations, facts, discoveries.
- Mobile/tablet: a persistent `Catatan` button in the story dock opens a full-height sheet (85dvh) with segmented tabs. Close returns focus to the button. Swipe-to-dismiss is optional; Escape and a close button are required.
- The rail never replaces the story title or pushes the reading column below 620 px on desktop.

**Session dock (mobile)**

- Fixed above the safe area: `Cerita` (current), `Catatan`, `Pilihan`, overflow. 56 px tall, 44 px targets.
- Hidden when the keyboard is open; composer remains visible. Use `visualViewport` handling to avoid overlap.

**Empty and error states**

- No messages: stage shows a short scene-setting prompt and one primary “Buka adegan pertama”.
- Missing definition or API failure: stage is replaced by a plain explanation and a secondary “Kembali ke perpustakaan”; no fake narration.

### 5.4 Editor — `Workshop`

**Goal:** make a complex world definition feel navigable, reviewable, and safe to edit.

**Shell**

- The editor is the only daylight surface: `--paper` ground with a subtle fiber texture, framed by the dark leather rail. Entering crossfades 200 ms; no white flash.
- Desktop: 232 px section rail on the left as a notebook index; form column max 760 px; optional 340 px preview rail.
- Top bar: back, “Buat dunia” / “Edit dunia”, save state (`Tersimpan` / `Belum disimpan`), overflow (Import, Export, Muat contoh), secondary `Pratinjau`, and the single contextual primary action.
- Primary action logic:
  - Draft with unsaved changes → `Simpan` (primary, `--paper-action`).
  - Saved and playable → `Mulai sesi` (primary), with `Simpan` secondary if dirty.
  - Never both solid in the same viewport.
- Sticky footer on mobile: save status + `Simpan` / `Mulai sesi`; 72 px, safe-area aware.
- Dialogs opened from the editor use paper surfaces; dialogs opened from the nocturnal shell stay dark. Never mix materials inside one modal.

**Section rail**

- Sections in product order: Ringkasan, Skenario, Pemain, Atribut, Sumber daya, Relasi, Item, Inventaris awal, NPC, Lorebook, Pratinjau.
- Each row reads as a paper index tab: label, count where meaningful (`6 NPC`), and a readiness dot (complete / needs attention / optional). The active tab is raised 1 px with a brass edge.
- Bottom of rail: readiness meter and “2 hal perlu dilengkapi” link that jumps to the first issue.
- Mobile: a `Bagian` button opens a sheet with the same list.

**Forms**

- Field rows: label, optional hint, control, inline error. Two-column grid above 720 px for short fields; full width for prose and JSON.
- Inputs 44 px, 4 px radius, `--paper-raised`, 1 px `--paper-line`, 1 px inset top shadow; focus uses a double ring (paper gap + brass ring).
- Entity editors (attributes, resources, relationships, items, NPCs) use:
  - Collapsed summary row: name, key value (e.g. `1–10`), edit and remove icon buttons.
  - Expanded panel with fields in a 2-column grid, separated by hairlines rather than nested cards.
  - Reorder via up/down buttons, not drag-and-drop (keyboard-safe).
  - “Tambah atribut” as a dashed full-width button at the end.
- Remove the nested `.entity` left-border treatment; hierarchy comes from spacing, labels, and paper tone.
- Validation: summary list at the top of the section, each item a link to the field. No global red wall.

**Lorebook**

- Present the workflow as four labeled steps: `1 Impor`, `2 Tinjau`, `3 Terbitkan`, `4 Pin ke draft`.
- Dry-run results and pack versions use a table-like list with monospace IDs and clear status badges.
- Keep all existing safety copy: version immutability, digest checks, and dependency warnings.
- File import stays a labeled secondary control; publishing is the section’s primary action.

**Preview**

- Shows the world card (cover, title, genre, tone), a readiness checklist, counts (NPCs, items, attributes), and the active AI profile name. No simulated AI output.
- On mobile, opens as a sheet from `Pratinjau`.

**Unsaved changes**

- Back triggers a dialog: “Simpan perubahan sebelum keluar?” with `Simpan`, `Buang perubahan`, and `Kembali`.
- Drafts persist in browser memory per the project constraint; warn on reload where the browser allows.

### 5.5 Settings — `Pengaturan`

**Goal:** make configuration legible and keep data recovery away from routine preferences.

**Structure**

- Desktop: 200 px subnav; content max 720 px. Groups sit on leather panels with inset wells for credentials; no paper surfaces here.
- Mobile: horizontally scrollable segmented tabs with 44 px targets.
- Sections: `AI`, `Profil AI`, `Tampilan`, `Data & pemulihan`, `Tentang backend`.

**AI**

- Group 1 — Koneksi: provider, model, key status (`Tersimpan` / `Belum diatur`), `Uji koneksi`.
- Group 2 — Narator: prompt textarea with character count (`2.418 / 8.000`), `Pulihkan prompt bawaan`.
- One primary `Simpan pengaturan AI` at the bottom of the section; no duplicate save buttons.

**Profil AI**

- List of profiles with name, provider/model, and default marker.
- Profile editor in a drawer or inline expansion; key entry uses a separate `Simpan key` action with clear status. Avoid a wall of nested cards.

**Tampilan**

- Segmented control for `Normal` / `Besar` with a live sample paragraph. Save is immediate, as today.
- Theme is fixed by screen: nocturnal shell, daylight editor. Do not add a user theme switcher in this phase; it would break the material system. Honor `prefers-contrast` instead.

**Data & pemulihan**

- Subgroups: `Backup backend`, `Restore save`, `Migrasi IndexedDB`.
- Explain consequence and scope in one sentence each.
- Backup list shows date, size, and a secondary restore action.
- Restore and migration are secondary buttons; destructive confirmation uses the shared dialog.
- Keep credentials and secrets out of every UI surface; only configured status is shown.

**Tentang backend**

- Local origin, server status, schema version, and a copyable diagnostic line. No secrets.

### 5.6 Create world — `Buat dunia`

- No mandatory wizard. A small chooser dialog offers:
  - `Perjalanan pesisir` (existing coast template)
  - `Lentera di hutan` (existing fantasy template)
  - `Dunia kosong`
- Each option is a card with cover thumbnail, one-line description, and a secondary select action. One primary `Buat dunia` confirms.
- Selecting opens the editor with the chosen seed; the editor remains the place where the world is shaped.
- If only one template is production-ready, show it honestly and mark the others `Segera` rather than shipping fake options.

---

## 6. Component and state inventory

### 6.1 Primitives to build

| Component | Variants | Notes |
| --- | --- | --- |
| Button | primary, secondary, ghost, danger, icon | 44 px min; loading label; disabled only for true unavailability |
| Icon button | 44×44, tooltip/label | Inline SVG; visible focus ring |
| Input / Textarea / Select | default, focus, error, disabled, readonly | Label above, hint below, error replaces hint |
| Checkbox / Radio | default, focus, checked, disabled | 18 px control with 44 px hit area |
| Segmented control | 2–4 options | Used for text size and field notes tabs |
| Tabs | underline (top-level), segmented (panels) | `role="tablist"`; arrow-key navigation |
| Badge | ready, draft, active, warning, neutral | Dot + text, never color alone |
| Meter | attribute, resource, readiness | Filled track, numeric value, min/max label |
| Row | world, session, entity, fact | Hover/focus reveal actions; no layout shift |
| Sheet / Drawer | right, bottom, full | Focus trap, Escape, return focus |
| Dialog | confirm, destructive, form | Scrim, title, body, action row |
| Toast | success, error, info | Bottom center above dock; live region |
| Empty state | page, section, search | One action maximum |
| Skeleton | row, card, text | Reduced-motion static |

Every primitive ships in two surface contexts: nocturnal (`--surface`, `--fg`) and daylight paper (`--paper`, `--paper-ink`). A component is not done until contrast, bevel, focus, disabled, and error states pass in both.

### 6.2 Interaction rules

- Hover raises a control by 1 px and adds the top bevel highlight; it never reduces text contrast.
- Pressed moves the control down 1 px, removes the top highlight, and deepens the well. Release returns it with no bounce.
- Focus-visible: 2 px surface-colored gap + 2 px brass ring on both leather and paper. The ring sits above bevels and texture.
- Disabled: 45% opacity and `cursor: not-allowed`; never used for loading (use a labeled busy state).
- All sheets and dialogs trap focus and restore it to the trigger.
- Escape closes menus, sheets, and dialogs without losing drafts.
- Texture layers are `pointer-events: none`, `aria-hidden`, and below content; disable them under `forced-colors` and `prefers-contrast: more`.
- `prefers-reduced-motion`: scene transitions become instant; control transitions ≤ 80 ms and limited to opacity.
- Keyboard: Enter sends in the composer, Shift+Enter inserts a newline; arrow keys move between tabs; no custom key traps.
- Toast duration 4 s for success, 8 s for errors; errors also persist inline.

---

## 7. Responsive behavior

| Breakpoint | Shell | Library | Session | Editor | Settings |
| --- | --- | --- | --- | --- | --- |
| < 640 | Top bar + tab bar | Single column; feature then list | Stage + dock + sheet | Single form + save bar | Segmented subnav |
| 640–899 | Top bar + tab bar | Single column, wider rows | Stage + sheet | Single form, 2-col fields | Segmented subnav |
| 900–1199 | Top bar | Feature + two-column poster grid | Reading column + drawer | Section rail + form | Side subnav |
| 1200+ | Left rail | Feature + three-column poster wall | Reading + persistent notes rail | Rail + form + preview | Side subnav |

Hard rules:

- No horizontal scroll at 360, 390, 768, 1024, 1280, 1440, 1920.
- Reading column never below 620 px on desktop and never wider than 68 characters.
- Letterbox padding collapses first on small screens; the prose measure and type size do not.
- Long titles wrap to a maximum of three lines; never `white-space: nowrap` to force fit.
- Touch targets ≥ 44×44 px; comfortable 8 px spacing between adjacent targets.
- Safe-area insets on top bar, composer, dock, and sticky footer.
- Mobile keyboard must not cover the composer or the active field.
- The daylight editor keeps the dark rail; never flip the entire shell to light.

---

## 8. Content and voice

### 8.1 Language rules

- Interface copy is Indonesian. Allow established technical terms: AI, prompt, model, API key, backup, JSON, IndexedDB.
- Replace developer terms:
  - `Turn committed` → `Giliran`
  - `Scene` → `Adegan`
  - `Story` → `Cerita`
  - `People` → `Tokoh`
  - `World` → `Dunia`
  - `Inventory` → `Tas`
  - `Library` → `Perpustakaan`
  - `Settings` → `Pengaturan`
  - `Create Game` → `Buat dunia`
- Use second person, calm and direct: “Perubahan belum disimpan.” “Backend lokal tidak merespons.”
- No exclamation marks, no fake urgency, no emoji.

### 8.2 Copy examples

| Context | Copy |
| --- | --- |
| Library hero | `Dunia untuk kembali.` / `Lanjutkan cerita, atau mulai dunia baru.` |
| Continue meta | `Pesisir utara · Sesi terakhir 2 jam lalu` (only if timestamp is real) |
| Empty library | `Belum ada dunia.` / `Mulai dari template contoh, lalu ubah sesukamu.` |
| Composer hint | `Tulis aksi atau dialog. Enter untuk kirim.` |
| Busy | `Narator sedang menulis…` |
| Save state | `Tersimpan` / `Belum disimpan` |
| Editor readiness | `Siap dimainkan` / `2 hal perlu dilengkapi` |
| Delete dialog | `Hapus “{title}”? Semua sesi dan riwayatnya ikut terhapus.` |
| Backend error | `Backend lokal tidak merespons. Jalankan server, lalu coba lagi.` |

### 8.3 Honesty rules

- Never invent playtime, word counts, ratings, or progress percentages.
- Dates come from real timestamps; if absent, omit the line.
- Template availability must match what the repository actually ships.
- Covers are original assets; no stock hotlinks, no generated faces for user NPCs.

---

## 9. Media and assets

- **Covers:** 6 original cinematic stills at 1600×900 (coast, lantern forest, rain city, desert road, mountain pass, archive). Painterly, muted, no text, no people in close-up. Bundle as WebP with SVG fallback.
- **Monograms:** generated from the first letter of a name on a stable, low-saturation tint derived from the name. No emoji and no photo avatars.
- **Icons:** one inline SVG sprite with 16 icons: library, book, quill, user, users, backpack, map, settings, search, chevron, close, more, arrow-left, arrow-right, check, alert.
- **Textures:** three tiny tiles — leather fiber (rail/panels), paper fiber (editor), film grain (stage). SVG or CSS data URIs, ≤ 8 KB each, rendered at 2–3% opacity, `pointer-events: none`, and disabled in high-contrast and print.
- **Brass:** CSS 1 px gradient edges and bevel highlights only. No brass image assets, no glossy specular streaks.
- **Prototype imagery:** if generated images are unavailable, use labeled `.ph-img` placeholders, not broken links or stock URLs.
- Do not add wood, felt, glass, plastic, stitching, rivets, or photorealistic textures; the material palette is leather, brass, paper, and ink only.

---

## 10. Accessibility requirements

- WCAG 2.2 AA for text, controls, and focus.
- Contrast pairs documented and checked with textures, bevels, and hover states enabled, on leather, night, and paper surfaces.
- Focus rings remain visible on every material; they must not rely on the bevel or grain to be legible.
- `forced-colors` and `prefers-contrast: more` remove grain, bevel highlights, gradients, and ambient shadows; 1 px borders carry the structure instead.
- Every icon-only control has an accessible name; decorative SVGs are `aria-hidden`.
- Landmarks: header, nav, main, complementary for the notes rail.
- Correct heading order on every screen; one `h1` per screen (the product title may be visually smaller).
- Live regions for run status, save status, and toasts (`polite`); errors use `role="alert"`.
- Sheets and dialogs: focus trap, labelled title, Escape, return focus.
- Tabs: `role="tablist"`, `aria-selected`, arrow-key support.
- Reduced motion removes scene fades and leaves content immediately readable; 200% zoom must not clip content or hide actions.
- Text size preference persists and scales the story and UI without breaking the layout.
- No color-only status; pair with text and shape.
- Test with keyboard only and with a screen reader for the session send flow and editor save flow.

---

## 11. Implementation plan

### Phase A — HTML prototype (Design Files)

1. `index.html` — overview/launcher linking the screens, with the design rationale and state checklist.
2. `library.html` — continue feature, world list, search, empty/error states.
3. `world.html` — world header, session list, start-new-session sheet, lorebook summary, template actions.
4. `session.html` — story stage, composer, choices, notes sheet, desktop rail.
5. `editor.html` — workshop shell, section rail, representative sections, readiness, preview.
6. `settings.html` — AI, profiles, appearance, data, backend.
7. Shared `assets/tokens.css`, `assets/app.css`, `assets/icons.svg`, cover images.

The prototype must be interactive: search filters, world menu, sheet open/close, world-to-session navigation, new-session sheet, tab switching, text-size toggle, focus mode, editor section switching, dirty-state save bar, and dialog focus handling. It must demonstrate both material modes — the nocturnal leather shell and the daylight paper editor — with pressed, bevel, and focus states plus one scene transition. Use real Indonesian copy and realistic sample content; label any sample data as `Contoh`.

### Phase B — React implementation (project repository)

Keep the stack and architecture. Suggested file-level work:

- `src/styles.css` → split into `src/styles/tokens.css`, `base.css`, `materials.css`, `components.css`, `screens/*.css`; import from `styles.css`. Preserve plain CSS.
- `tokens.css` defines both `[data-surface="nocturnal"]` and `[data-surface="daylight"]`; only the editor route switches to daylight. No user theme setting.
- `materials.css` owns grain, leather, bevels, wells, and brass edges as reusable utilities; textures are data URIs and are disabled under `prefers-contrast` and `forced-colors`.
- `src/App.tsx` → app shell with rail/top bar; session/editor own their chrome.
- `src/components/GameLibrary.tsx` → feature card, world rows, search, empty/skeleton states, delete dialog.
- Add `src/components/WorldView.tsx` → world header, session list, start-new-session sheet, lorebook summary, duplicate/template actions.
- `src/components/SessionView.tsx` → split into `session/SessionHeader`, `StoryStage`, `StoryMessage`, `Composer`, `SessionDock`, `FieldNotes`, `panels/*`.
- Add session metadata (`name`, `pinned`, `lastReadMessageId`) with a small migration; keep exports and backups compatible.
- `src/components/GameEditor.tsx` → split into `editor/EditorShell`, `SectionRail`, `fields/*`, `entities/*`, `LorebookSection`, `EditorPreview`.
- `src/components/SettingsPanel.tsx` → `settings/SettingsShell`, `AiSettings`, `AiProfilesPanel`, `Appearance`, `DataRecovery`, `BackendInfo`.
- Add `src/components/ui/*` primitives (Button, Field, Badge, Meter, Sheet, Dialog, Toast, Tabs, EmptyState, Skeleton).
- Add `src/assets/covers/*` and `src/icons.tsx`.
- No new runtime dependency required; icons are inline SVG. Fonts are self-hosted `.woff2` assets.

Migration order: tokens and shell → library → world → session → editor → settings → dialogs/toasts → QA. Keep each step shippable and avoid a big-bang rewrite of `GameEditor.tsx`.

---

## 12. Acceptance checks

### Visual

- [ ] One primary button per viewport; secondary actions are visually distinct.
- [ ] Brass/amber appears at most twice per screen as a functional signal.
- [ ] Display, body, and mono faces are distinct and correctly applied.
- [ ] Story prose measures 62–68 characters and sits in a letterboxed `--night` stage with grain ≤ 3%.
- [ ] Bevels are 1–2 px, pressed states exist, and no texture sits behind prose or labels.
- [ ] The daylight editor is unmistakably paper, remains fully legible, and keeps the dark rail.
- [ ] No glossy plastic, glassmorphism, stitching, rivets, fake wood, or decorative gradients.
- [ ] No emoji icons; all icons are the same stroke family and size.
- [ ] No overlapping, clipped, or overflowing text at any target viewport.
- [ ] No orphaned one- or two-word final lines in headings or cards.
- [ ] Covers are original and correctly cropped; no text overlays outside image bounds.
- [ ] Scene transitions change opacity only, last 400–600 ms, and never shift the prose column.

### Interaction

- [ ] Library search filters; world menu opens, closes, and returns focus.
- [ ] World page continues the latest session, starts a new one, and exposes lorebook/template actions.
- [ ] Continue, create, edit, delete, export, and settings flows are reachable.
- [ ] Session notes open as a sheet on mobile and a rail on desktop; tabs switch.
- [ ] Composer sends, disables while busy, preserves drafts, and shows retry on error.
- [ ] Action choices are selectable and show a busy state.
- [ ] Editor section rail switches sections; dirty state is visible; back warns before discarding.
- [ ] Save/start primary action changes correctly with validity and dirty state.
- [ ] Settings tabs switch; text size changes persist; destructive actions confirm.
- [ ] All hover, focus, active, selected, disabled, loading, empty, and error states exist.

### Accessibility

- [ ] Keyboard-only completion of library → session → send and editor → save.
- [ ] Focus rings visible on leather, night, and paper surfaces.
- [ ] Forced-colors and high-contrast modes remove texture and bevels without losing structure.
- [ ] Sheet/dialog focus trap, Escape, and focus return verified.
- [ ] Contrast ratios meet 4.5:1 body and 3:1 large text/icons in every state.
- [ ] 200% zoom and 360 px width produce no horizontal scroll.
- [ ] Reduced-motion mode removes non-essential animation.
- [ ] Screen-reader labels exist for icon buttons, meters, and live statuses.

### Content

- [ ] All UI copy is Indonesian and free of developer terms.
- [ ] No invented metrics, playtime, or progress.
- [ ] Empty states offer one clear next step.
- [ ] Error messages state cause and recovery.

---

## 13. Missing features and convenience roadmap

The current build covers the core loop, but several jobs are either hidden, manual, or only possible through the editor. The biggest opportunity is not another settings panel — it is **letting a world hold many runs and letting a run be easy to resume, search, and keep**.

### 13.1 Gaps that cost the user time today

| Gap | Current behavior | Cost to the user | Priority |
| --- | --- | --- | --- |
| Start a fresh run | `startSession` exists in `GameEditor.tsx:653`, but the library only continues the latest session (`GameLibrary.tsx:229`). | To replay a world, the user must open the editor and press “Mulai sesi”, which is not where they think about playing. | P0 |
| Switch between sessions | Extra sessions appear as `Sesi {id.slice(0,8)}` with a timestamp (`GameLibrary.tsx:353`). | The user cannot tell runs apart, rename them, or delete one without deleting the whole world. | P0 |
| World home | Nothing sits between the library row and a session. | Description, lorebook, sessions, and template actions are scattered across the row menu and editor. | P0 |
| Resume context | A session reopens at the transcript with no recap, last action, or reading position. | After days away, the user must scroll and reconstruct where they were. | P0 |
| Run visibility | Run state is kept in `sessionStorage`, but the header does not show “writing”, “failed”, or “recovered”. | The user may resend an action or assume the app is stuck. | P0 |
| AI profile at start | Only the default profile can be used from the editor; choosing another profile lives in Settings. | Starting a run with a different narrator model requires a detour and a global default change. | P1 |
| Lorebook reuse | Packs are imported per world from a JSON file (`GameEditor.tsx:1017`). | Every new world repeats the same import; there is no gallery, preview, or reuse path. | P1 |
| World templates | Export/import JSON exists, but there is no “save as template”, gallery, or duplicate. | Reusing a carefully built world is manual and error-prone. | P1 |
| Story export | Save JSON exists; there is no human-readable transcript. | The user cannot keep or share the story as a document. | P1 |
| Transcript search | None. | Finding a named NPC, fact, or earlier scene means scrolling the whole history. | P1 |
| Bookmarks and chapters | None. Session history is one long list. | Long campaigns lose their shape. | P1 |
| Notes and recaps | None. | The user keeps context outside the app. | P1 |
| Check explanation | The check badge shows the result but not the attribute, target, or margin. | The mechanics feel opaque. | P2 |
| Usage visibility | `getUsage` exists in `api.ts:441`, but no interface reads it. | Token/cost awareness is impossible inside the app. | P2 |
| Reading aids | Text size only; no focus mode, TTS, or high-contrast option. | Long reading sessions are less comfortable than they could be. | P2 |
| Keyboard and commands | Mouse/touch only. | Desktop power use is slower than it needs to be. | P2 |
| Timeline fork | No backend support. | The user cannot explore “what if I had chosen otherwise” without starting over. | Later |

### 13.2 The missing middle layer: a World page

Add a **Dunia** screen between the library and a session. It is the single home for one world and removes the need to cram sessions, lore, and template actions into a row menu.

**Header**

- Cover, title, genre · tone, status (`Siap` / `Draft`), description, last played.
- Primary action: `Lanjutkan sesi terakhir` (or `Mulai sesi pertama` when there are no runs).
- Secondary: `Sesi baru`.
- Overflow: `Edit dunia`, `Duplikat dunia`, `Export template`, `Hapus dunia`.
- Never show both `Lanjutkan` and `Sesi baru` as solid buttons.

**Sessions**

- List sorted by pinned first, then latest.
- Each row: auto title (`Sesi 2 · Pesisir`), last scene or last narrated line excerpt, last played, turn count.
- Row menu: `Ganti nama`, `Pin`, `Export save`, `Hapus sesi`.
- “3 sesi” summary is honest; no fabricated progress percentage.
- Empty: one primary `Mulai sesi pertama`, with a link to `Edit dunia` if it is not playable.

**Lorebook**

- Pinned pack name, version, entry count, license, and last updated.
- `Lihat isi` opens the entry browser; `Kelola lorebook` opens the editor section.
- If no pack is pinned: `Pasang lorebook` secondary action and a one-line explanation of what changes.

**Templates & data**

- `Export template` (definition + pinned lore references).
- `Simpan sebagai template` adds the world to the local template gallery.
- `Duplikat dunia` copies definition and lore pins, **not** sessions or history. Label this explicitly.

**Design notes**

- One editorial header, then hairline-separated sections. Do not nest every section in a card.
- Mobile: sticky bottom bar with `Lanjutkan` primary and `Sesi baru` secondary; content scrolls above it.
- Requires `world.html` in Phase A and a `WorldView` route in Phase B.

### 13.3 Starting a new session from the same world

This is the highest-value missing flow. The backend already supports multiple sessions; the interface does not expose the intent.

**Trigger points**

- World page: `Sesi baru`.
- Library world row overflow: `Mulai sesi baru`.
- Session overflow: `Mulai sesi baru dari dunia ini`.

**Flow**

1. Open a confirmation sheet: “Mulai sesi baru dari awal cerita?”
2. Show a read-only summary: world title, player name, pinned lore version, number of existing sessions.
3. Optional session name, prefilled `Sesi {n} · {location or genre}` and editable.
4. AI profile selector, defaulting to the configured default profile. Link to `Kelola profil` without leaving the flow.
5. If the world is not playable, replace the primary action with `Perbaiki dunia` and list the blocking issues.
6. Primary `Mulai sesi`; secondary `Batal`. One solid button.
7. Land in the session with a quiet `Bab 1` marker and the opening action ready.

**Semantics to state clearly**

- A new session starts from the **current saved template**, not from the edited draft or an older session.
- Existing sessions keep their own snapshot and are not changed.
- If the template changed since the last run, show: “Perubahan template hanya berlaku untuk sesi baru.”
- Editor should surface the same sentence near Save once a world has sessions, so structural restrictions are not a surprise.

**Implementation note**

- `startSession` already exists; this is primarily UI work plus a session name field.
- Session names/pins require a small SQLite migration (or local metadata if the schema change is deferred). Prefer the persisted field so exports and backups keep names.

### 13.4 Session manager and better resume

- **Names:** auto-generated, editable. Use world title + place + ordinal, not UUIDs.
- **Pin:** keep the campaign the user is actively playing at the top of the world page and library row.
- **Resume strip:** above the stage, show `Terakhir: “Aku menutup pintu…”` plus location, time, present characters, and last action. Derive it from stored messages; do not invent a summary.
- **Reading position:** persist per session in `localStorage`; when the user returns, restore the last message. Show a `Kembali ke bawah` button if new messages arrived.
- **Search:** `Cari di cerita` searches message text, speaker, and turn; results show a snippet and jump to the message. On mobile, it opens as a sheet.
- **Bookmarks:** `Tandai` any message or turn; bookmarks appear in a small list in the session menu. Store as local metadata first, migrate later if needed.
- **Chapters:** `Tandai bab` inserts a visible chapter divider and suggests `Bab {n}`. Manual, not AI-generated.
- **Export transcript:** Markdown with title, session name, dates, scene headers, narration, and player actions. Keep the existing JSON save export separate and label the difference.
- **Delete:** per-session delete with a consequence sentence; never delete the whole world by accident.

### 13.5 Lorebook as a reusable template

The lorebook is currently a file-import workflow. Make it a library the user can browse and reuse.

**Gallery**

- Entry point: Editor → Lorebook → `Galeri`, and World page → `Pasang lorebook`.
- Sections: `Terpasang`, `Bawaan`, `Diimpor`.
- Card: pack name, version, entry count, license, short description, and status (`Terpasang` / `Belum`).
- Actions: `Pratinjau`, `Pasang ke dunia ini`, `Lihat entri`.
- Start with the packs that already exist in `examples/`. Do not advertise empty starter packs.

**Entry browser**

- Search by name, alias, type, tag, and visibility.
- Show summary and body preview; linked entries are navigable.
- Make it obvious when an entry is discovery-only or metadata-bound to an NPC; do not imply it will auto-create a character or item.

**World + lore template**

- Export a world template that records the exact `{packId, version}` pins, not the pack body.
- Import flow: validate the definition, list required packs, install missing versions, then create the world. If a version is missing, block with a clear dependency list — never silently substitute the latest.
- `Simpan sebagai template` stores the definition and pins in a local gallery; `Duplikat dunia` makes a playable copy without sessions.
- A combined `.fworld-bundle` archive is a later convenience; keep the first version as two explicit files so version/digest rules stay legible.

**Safety**

- Keep atomic publication, version immutability, and digest checks exactly as they are.
- No crawler, wiki ingestion, or automatic conversion of lore articles into NPCs/items.
- Credentials never appear in a pack, template, or export.

### 13.6 Reading and writing conveniences

- **Focus mode:** hide the rail, dock, and header chrome; keep a visible `Keluar fokus` control and Escape. Expand the letterbox, not the measure, and never increase the font beyond the user preference.
- **Previously on:** a compact, derived recap (last scene, location, present people, last action) at the top of a resumed session. Collapsible and dismissible.
- **Copy narration:** per-message copy for the current narration, plus `Salin satu adegan` for the last scene.
- **Draft per session:** the composer keeps an unsent draft when switching tabs or reopening the session.
- **TTS (later):** browser `SpeechSynthesis`, local, per-message play/pause. No audio upload or network dependency.
- **Reading preferences (later):** line height in addition to text size. High contrast is honored through `prefers-contrast`, not a theme picker.

### 13.7 AI operation conveniences

- **Status chip:** `Siap`, `Menulis…`, `Gagal`, `Pulih` in the session header, tied to run state.
- **Profile picker at start:** choose the narrator profile without changing the global default.
- **Retry in place:** keep the player draft and show `Coba lagi` above the composer. Do not require a reload.
- **Usage panel:** show tokens/cost only after the API shape is confirmed; label it as recorded usage, never an estimate presented as exact.
- **Connection test:** expose the existing test from AI settings and show `Terhubung` / `Gagal` with a plain-language next step.
- **Prompt preview:** read-only effective narrator prompt with character count; editing stays in Settings.
- **Cancel run:** add only when the backend supports cancellation; otherwise show an honest “tunggu hingga selesai” state.

### 13.8 Editor conveniences

- **Duplicate entity** for attributes, resources, items, and NPCs; duplicate copies the definition, not runtime state.
- **Reorder** with up/down buttons and keyboard support.
- **Collapse all / expand section**, plus a field search that filters within the active section.
- **Template gallery** in Ringkasan: start from a saved template or a bundled example.
- **Readiness panel** with links to each blocking issue; no vague “invalid” state.
- **Save shortcut** (`Ctrl/Cmd+S`) and a truthful dirty indicator.
- **Structural-change notice** once sessions exist: “Perubahan ini hanya berlaku untuk sesi baru.”
- **Bulk paste** for simple lists where a format already exists; do not invent a new DSL.

### 13.9 Data safety and local-first convenience

- **Backup reminder:** show last backup date and a `Backup sekarang` action when it is stale; never nag more than once per session.
- **Restore preview:** list world/session counts, database version, and date before replacing anything.
- **Distinct exports:** `Export cerita` (Markdown), `Export save` (JSON), `Export template` (JSON), each explained in one sentence.
- **Storage health:** database size, schema version, and last successful backup in `Tentang backend`.
- **No cloud, accounts, or sync.** The product is intentionally local; convenience comes from better local workflows, not remote services.

### 13.10 Three convenience moments

| Moment | Today | After the redesign |
| --- | --- | --- |
| Returning after a week | Open library, guess which session is current, scroll to the bottom, reconstruct context. | `Lanjutkan` → recap strip + restored position + visible run state → one action to continue. |
| Starting a parallel run | Open editor, find “Mulai sesi”, hope the draft is saved. | World page → `Sesi baru` → choose profile + name → start; the old run is untouched. |
| Reusing a world | Export JSON, create a game, import JSON, re-import lorebook, re-pin. | `Duplikat dunia` or template gallery → dependencies checked → playable copy in one flow. |

### 13.11 Prioritized roadmap

| Feature | Priority | Impact | Effort | Dependency |
| --- | --- | --- | --- | --- |
| World page (`Dunia`) | P0 | High | M | Library row routing |
| Start new session from world | P0 | High | S–M | `startSession` (exists) |
| Session names, switch, delete | P0 | High | M | Small schema migration |
| Resume strip + reading position | P0 | High | S | Existing messages |
| Run status + retry | P0 | High | S | Existing run state |
| AI profile picker at start | P1 | Medium | S | `startSession` profile support |
| Session pin | P1 | Medium | S | Schema field or local metadata |
| Transcript search | P1 | High | S | Loaded messages |
| Transcript export (Markdown) | P1 | Medium | S | Loaded messages |
| Bookmarks + chapter markers | P1 | Medium | M | Persisted metadata |
| Lorebook gallery + entry browser | P1 | High | M–L | Existing packs |
| World template gallery + duplicate | P1 | High | M | Existing export/import |
| Combined world + lore bundle | P2 | Medium | M | Dependency resolver |
| Usage panel | P2 | Low–Medium | S | Confirm API shape |
| Focus mode | P2 | Medium | S | Session shell; ship before TTS |
| TTS | P2 | Medium | S | Browser API; after focus mode |
| Command palette | P2 | Low-Medium | M | None |
| Timeline fork from a turn | Optional | High | L | Post-v1; needs backend copy-on-fork |
| Lore cross-links inside the story | Optional | Medium | M | Entry matching rules |

### 13.12 Scope guard

Do not add in this redesign:

- Accounts, cloud sync, remote databases, or public sharing.
- Social features, comments, or multiplayer.
- A crawler, wiki ingestion, or automatic lore scraping.
- Automatic conversion of lore entries into NPCs, items, or effects.
- Mandatory creation wizards or a dashboard of invented metrics.
- AI-generated covers or NPC portraits per turn; bundled original art only.
- Gamification streaks, badges, or notifications that do not serve the story.
- A user theme switcher, photorealistic material skins, glassmorphism, or decorative skeuomorphic props.
- Autoplay motion, ambient audio, or video backgrounds.

---

## 14. Alternative design directions

Direction **C. Cinematic Chapter** was selected, with a **skeuomorphic material layer**. The other directions remain as reference, not as fallbacks: do not blend their chrome into C. Behavior may be borrowed only where 14.4 says so.

### 14.1 How to judge them

- **Brand fit:** does it feel like a personal literary RPG, not a SaaS tool?
- **Reading comfort:** can someone read 2,000 words in one sitting?
- **Editing clarity:** does it support dense world configuration without fatigue?
- **Mobile fit:** does it survive one-handed use and a 360 px screen?
- **Distinctiveness:** would a screenshot be recognizable as Fworld?
- **Cost:** can it be built with plain CSS, bundled fonts, and inline SVG?

### 14.2 Comparison

| Direction | Mood | Best for | Main risk | Build cost |
| --- | --- | --- | --- | --- |
| **A. Field Journal at Dusk** | Literary, calm, tactile | Reading-first personal RPG | Quiet chrome can feel under-powered to config-heavy users | M |
| **B. Editorial Archive** | Authoritative, dense, archival | Lore-heavy worlds and world-builders | Busy on mobile; can feel cold or academic | M |
| **C. Cinematic Chapter + skeuomorphism** (selected) | Immersive, tactile, nocturnal | Atmosphere, long reads, and a memorable identity | Material kitsch and texture contrast; two surface modes to maintain | M–L |
| **D. Pulp Paperback** | Playful, bold, genre-forward | Visual identity across very different genres | Can undercut serious or intimate stories; risk of toy-like UI | M |
| **E. Quiet Studio** | Fast, neutral, tool-like | Editing, configuration, power users | Forgettable; loses the literary soul | S–M |

### 14.3 The alternatives in detail

**A. Field Journal at Dusk** is the pre-revision plan: sections 3–12 without the material layer. It is not detailed again here; read it as C with leather, brass, and the daylight editor removed.

#### B. Editorial Archive

- **Reference feeling:** a Monocle or FT weekend spread, a library reading room, an annotated manuscript.
- **Palette:** paper `oklch(0.955 0.008 85)`, surface `oklch(0.985 0.004 85)`, ink `oklch(0.21 0.012 70)`, muted `oklch(0.48 0.012 70)`, border `oklch(0.86 0.01 85)`, accent oxblood `oklch(0.45 0.13 25)`.
- **Type:** Spectral or Source Serif 4 for display; Source Sans 3 for UI; IBM Plex Mono for folios and tabular data.
- **Layout:** a two-column editorial spread on desktop; visible grid, 1 px rules, marginal notes, running heads. The story stays on paper, with a thin oxblood rule instead of a dark stage.
- **Signature:** folio numbers and margin notes that carry player state beside the prose.
- **Strengths:** excellent for lore, attributes, and long-form world text; feels authored; density is a feature.
- **Risks:** mobile requires a real re-composition, not a squeeze; the dark reading stage disappears, so the product feels less cinematic.
- **Choose if:** the user spends more time building worlds than reading in the dark, and wants Fworld to feel like a literary publication.

#### C. Cinematic Chapter + skeuomorphism (selected)

- **Reference feeling:** a title card before a film, a leather-bound screenplay on a brass reading stand, a projector warming up.
- **Palette:** shell `oklch(0.17 0.012 160)`, surface `oklch(0.22 0.014 160)`, text `oklch(0.93 0.01 90)`, muted `oklch(0.72 0.015 90)`, border `oklch(0.32 0.012 160)`, brass `oklch(0.78 0.11 75)`.
- **Materials:** leather for structure (rail, panels), brass for affordance (primary, focus, selected, progress), film grain for atmosphere (stage), paper for the editor only. Bevels are 1–2 px and pressed states move 1 px.
- **Type:** Newsreader display, oversized for chapter titles; Public Sans for controls; IBM Plex Mono for timecodes and turn markers.
- **Layout:** a dark shell with a centered, letterboxed scene, generous negative space, minimal persistent chrome, and chapter cards that fade in. The editor is a separate daylight paper desk framed by the dark rail.
- **Signature:** a slow, quiet scene transition and a brass progress hairline that advances by chapter.
- **Strengths:** the most immersive reading experience; tactile controls are self-explanatory; screenshots are immediately distinctive.
- **Risks:** skeuomorphism can become kitsch or hurt contrast; the daylight editor doubles the surface system and must be maintained as a first-class mode.
- **Choose if:** immersion is the product’s main promise and the user accepts a distinct light workspace for editing. **This is the chosen direction.**

#### D. Pulp Paperback

- **Reference feeling:** a worn paperback rack, chapter numerals, colored spines, dramatic cover blocks.
- **Palette:** warm paper `oklch(0.96 0.015 85)`, ink `oklch(0.19 0.01 70)`, accent chosen per world from a curated set (oxblood, teal, mustard, aubergine) but only one per screen.
- **Type:** Bricolage Grotesque for display and chapter numerals; Public Sans for body; a condensed face for cover titles only.
- **Layout:** library as a shelf of strong covers; world page as a trade-paperback title page; session as a chapter with oversized numerals and pull quotes.
- **Signature:** genre-specific cover art and a colored spine that follows the current world.
- **Strengths:** gives each world a personality; makes the library fun to browse; strong mobile identity.
- **Risks:** easily becomes loud or childish; dynamic accents complicate contrast checks; serious horror or grief stories may feel mismatched.
- **Choose if:** the user wants Fworld to feel like a shelf of books and values variety over a single restrained mood.

#### E. Quiet Studio

- **Reference feeling:** Linear or a well-made desktop editor; fast, precise, almost invisible.
- **Palette:** neutral `oklch(0.98 0.002 250)`, white surface, ink `oklch(0.22 0.01 250)`, muted `oklch(0.52 0.01 250)`, border `oklch(0.9 0.005 250)`, accent forest `oklch(0.45 0.07 155)`.
- **Type:** Public Sans throughout; Newsreader only inside the story surface; IBM Plex Mono for data.
- **Layout:** split panes, a command palette, a persistent inspector, compact 32–36 px controls, keyboard-first.
- **Signature:** speed — open, search, edit, and resume without ceremony.
- **Strengths:** best for configuration, large lorebooks, and desktop power use; lowest visual risk.
- **Risks:** loses the literary identity; may feel like a developer tool; weak emotional pull on the library screen.
- **Choose if:** the user’s main frustration is editing speed, not atmosphere.

### 14.4 Recommendation

**Selected: C. Cinematic Chapter + skeuomorphism.** It makes the story the product, and it uses material depth for affordance rather than decoration. The daylight paper editor answers C’s main risk directly, and the left rail gives the shell a stable place to live.

Keep without changing the system:

- From **B**: the world page’s editorial clarity, and rules or folios only where metadata is dense.
- From **D**: stronger, original cover art in the library — not the chrome.
- From **E**: keyboard shortcuts, the command palette, and compact editor controls.
- From **A**: quiet fades and the copper warmth, re-expressed as brass highlights.

**Guardrail:** if the material layer starts to read as costume — stitching, rivets, torn paper, wax seals — stop and return to structure plus affordance. Depth must explain what is clickable, not decorate what is not.

### 14.5 Side-by-side consequences

| Decision | A. Field Journal | B. Editorial Archive | C. Cinematic + skeuomorphism | D. Pulp Paperback |
| --- | --- | --- | --- | --- |
| Story surface | Dark forest + amber | Paper + oxblood rule | Dark shell, letterboxed | Paper + world accent |
| Primary accent | Copper | Oxblood | Brass | Per-world, one at a time |
| Display face | Newsreader | Spectral / Source Serif | Newsreader, oversized | Bricolage Grotesque |
| Library posture | Editorial two-column | Dense index + spread | Poster-like cover wall | Bookshelf |
| Editor posture | Workshop on paper | Annotated manuscript | Daylight mode required | Playful workshop |
| Motion | Quiet fades | Minimal, page-like | Slow cinematic transitions | Snappy, tactile |
| Materials | none | paper only | leather + brass + paper | paper + ink |

### 14.6 Material translation rules

The skeuomorphic layer is a grammar, not a texture pack. Six rules keep it from becoming kitsch:

1. **Leather is structure.** Use it for the rail and large panel fields, never behind prose or form labels. If it reads as a pattern behind text, it is wrong.
2. **Brass is affordance.** Primary action, focus ring, selected state, chapter progress. At most two functional brass marks per screen; brass edges on cards are neutral hardware and do not count.
3. **Paper is thinking.** The editor and only the editor sits on paper. Never place paper inside the dark shell as a decorative card.
4. **Grain is atmosphere.** Stage background only, ≤3% opacity, disabled under `prefers-contrast: more` and `forced-colors`.
5. **Bevel is touch.** 1–2 px highlight/shadow pairs; pressed states translate 1 px. No inner glow, no glossy gradients, no drop shadows thicker than 2 px.
6. **No props.** No stitching, rivets, torn edges, wax seals, film sprockets, wood grain, or glass. If an element would not exist in a screening room or a bindery, it does not ship.

**Progressive enhancement test:** with all textures and bevels removed, every screen must remain readable and every control identifiable. Materials add recognition; they never carry meaning alone.

---

## 15. Decisions

All 16 questions are answered. No open decision blocks the prototype.

| # | Decision | Answer | Impact |
| --- | --- | --- | --- |
| 1 | Screen scope | All screens; Library, World, Session are P0 | Six prototype screens, editor and settings included |
| 2 | Narration stage | Keep it dark amber, refined to amber on deep forest | Section 3 tokens hold; no light-mode story surface |
| 3 | Name and copy | Keep Fworld and Indonesian; English for technical terms | No rename, no full i18n pass |
| 4 | Prototype delivery | Separate screen files plus an index launcher | Six HTML files sharing `assets/` |
| 5 | Template chooser | Ship it, but only templates that already exist | No invented starters; chooser may launch with one card |
| 6 | Fonts | Self-host Newsreader, Public Sans, IBM Plex Mono (OFL) | Local `woff2` files; CDN only as prototype fallback |
| 7 | Desktop shell | Left rail at ≥1200 px, compact top bar below | Section 7 breakpoints confirmed |
| 8 | Dialogue vs narration | Visually distinct: italic narration, upright ivory dialogue | Section 6.2 hierarchy confirmed |
| 9 | World page | Add it between Library and Session as `5.2` | `world.html` in Phase A, `WorldView.tsx` in Phase B |
| 10 | Design direction | **C. Cinematic Chapter + skeuomorphism** | Sections 3–12 rewritten; 14.6 governs materials |
| 11 | Session names | Ship in v1, with a small metadata migration | Phase B migration work is in scope |
| 12 | Lorebook gallery | v1.1, after World page and new-session flow | Not in the prototype's critical path |
| 13 | Transcript export | Markdown; JSON remains the save format | Export is a render, not a second save path |
| 14 | TTS and focus mode | P2; focus mode first, TTS later | Focus mode may enter the prototype as a state |
| 15 | Timeline fork | Optional, post-v1; needs backend support | Backlog; no UI commitment in v1 |
| 16 | Starter packs | Only existing, licensed packs in `examples/` | Gallery shows real content or an honest empty state |

---

## 16. Next step

1. Reply **“build the prototype”** to generate the high-fidelity HTML screens from this plan in Design mode.
2. Review the prototype at 1280, 768, and 360 px, plus `prefers-contrast: more` and `forced-colors`. Check the brass budget and the leather/paper boundary first; they are the two most likely failures.
3. After approval, use Phase B as the implementation checklist in `I:\Gim\Fworld`, starting with tokens and the shell before any screen.
4. Record every deviation from this document in the file as it happens, so the plan and the app do not drift.

**Primary file for the next run:** `fworld-ui-ux-redesign-plan.md`
**Planned artifact entry point:** `index.html` (overview launcher) linking `library.html`, `world.html`, `session.html`, `editor.html`, and `settings.html`.
