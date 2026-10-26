# Fworld Design System

Fworld is a locally hosted, story-first AI roleplay RPG. Its interface should make returning to a story immediate, keep state close to the reading surface, and make world creation feel like working at a calm paper desk.

The visual language is **Cinematic Chapter**: a nocturnal forest shell with brass affordances and an uninterrupted reading stage, paired with a daylight paper workshop for editing. Skeuomorphic depth explains touch; it never becomes a prop.

## Visual foundations

- **Quiet chrome, loud story.** Give narration the strongest typographic presence and keep navigation restrained.
- **Light for thinking, dark for reading.** Library, world, and session use the nocturnal surface. The editor uses daylight paper while its navigation shell stays dark.
- **Depth has a job.** Use a shallow bevel for raised controls, an inset well for editable fields, and subtle shadows only for floating sheets.
- **One action leads.** A viewport has one solid primary action. Secondary actions use quiet outlines, text, or menus.
- **Local and personal.** Do not suggest accounts, cloud sync, social activity, or invented operational metrics.

## Source-backed product and component context

The following rules are tied to implemented Fworld screens, not generic design assumptions. Full originals stay available at the project root and are copied into `source_examples/` for package reuse.

- **Library (`library.html`):** shows the featured “continue story” path before the searchable world collection. World covers are original 3:2 SVG artwork; each row/card pairs its illustration with title, status, genre, and recency. Preserve one dominant resume action and keep world management contextual.
- **World detail (`world.html`):** gives a single world a title-card header, then session history and related world information. Session rows are editorial and excerpt-led; raw IDs are implementation data and must not enter user-facing copy.
- **Story session (`session.html`):** separates warm italic narration from upright dialogue on a deep stage. Turn metadata remains compact, action composition stays close to the reading flow, and character/inventory/world details open as field notes instead of replacing the story surface.
- **World editor (`editor.html`):** uses a daylight paper work area inside the persistent dark Fworld shell. Its section navigation, completion signals, form groups, preview column, and sticky save actions are source-backed patterns. The screenshot in the root captures the actual rail/form/preview composition.
- **Settings (`settings.html`):** groups AI configuration, profiles, appearance, and local data recovery. Keep recovery actions distinct from routine preferences and keep the local-only product promise explicit.
- **World creation (`create-world.html`):** starts from source-backed templates or an empty world, summarizes the selected starting point, and presents one clear create action. Availability labels distinguish ready templates from future examples.
- **Shared implementation (`assets/app.css`, `assets/app.js`, `assets/tokens.css`):** the source defines the 248 px rail, tablet/mobile navigation changes, 44 px controls, raised and inset states, focus rings, reduced motion, search/filter behavior, editor state, session drawer, and responsive layouts. Preserve these concrete conventions when extending a screen.
- **Original visual assets:** `assets/icons.svg` contains the product's 1.5 px line icon set; `assets/favicon.svg` supplies the mark; six cover illustrations support distinct worlds; leather/paper/grain SVGs provide low-contrast materials; local WOFF2 font files define the type system. Reuse their byte-preserved copies in `build/`.
## Color

Core values are inherited from `assets/tokens.css`; use OKLCH values as the source of truth.

| Token | Value | Use |
|---|---|---|
| `--bg` | `oklch(0.17 0.012 160)` | Nocturnal shell ground |
| `--surface` | `oklch(0.215 0.014 160)` | Leather rails and structural panels |
| `--surface-2` | `oklch(0.25 0.014 160)` | Raised controls and hover ground |
| `--surface-3` | `oklch(0.285 0.014 160)` | Higher neutral surface |
| `--fg` | `oklch(0.93 0.01 90)` | Primary dark-surface text |
| `--muted` | `oklch(0.72 0.015 90)` | Secondary dark-surface text |
| `--border` | `oklch(0.32 0.012 160)` | Hairlines and panel edges |
| `--accent` | `oklch(0.78 0.11 75)` | Brass action, selected state, focus |
| `--accent-ink` | `oklch(0.20 0.02 75)` | Text on brass |
| `--night` | `oklch(0.135 0.010 160)` | Story stage and deep wells |
| `--story` | `oklch(0.885 0.06 85)` | Narration |
| `--dialogue` | `oklch(0.955 0.012 90)` | Spoken dialogue |
| `--paper` | `oklch(0.955 0.010 85)` | Editor background |
| `--paper-raised` | `oklch(0.985 0.005 85)` | Paper fields and raised sheets |
| `--paper-ink` | `oklch(0.24 0.015 70)` | Daylight text |
| `--paper-muted` | `oklch(0.50 0.012 70)` | Daylight secondary text |
| `--paper-line` | `oklch(0.86 0.010 85)` | Daylight dividers |
| `--paper-action` | `oklch(0.28 0.03 155)` | Daylight primary control |
| `--danger` | `#a94a3c` | Destructive actions and errors |
| `--ok` | `#86ab92` | Positive system state |

Brass is the only chromatic accent and appears sparingly. In daylight, primary actions use forest ink; brass remains available for focus and small state marks. Pair colors semantically and keep normal text contrast at or above 4.5:1. Status always includes a word, never color alone.

## Typography

- **Display and story:** Newsreader, 400–600, followed by Iowan Old Style, Palatino Linotype, Georgia, serif. Use for chapter titles, story prose, and world names.
- **Body and controls:** Public Sans, 400–600, followed by system UI sans-serif. Use for navigation, forms, explanatory copy, and controls.
- **Metadata:** IBM Plex Mono, 400–500, followed by a system monospace stack. Use for folios, timecodes, turn markers, and compact status metadata.

Use the self-hosted WOFF2 files in `fonts/`. The evidenced scale is 12, 13, 14, 16, 18, 20, 24, 32, 40, 56, and 72 px. Story text is 20 px on desktop and 18 px on mobile, with 1.75–1.8 line-height and a 62–68 character measure. UI headings stay at or below 40 px.

## Spacing, shape, and depth

Use a 4 px base rhythm: 4, 8, 12, 16, 24, 32, 48, 64, and 96 px. Controls have 4 px corners, panels 8 px, and sheets 14 px. Reserve fully rounded shapes for status dots and monogram avatars.

Borders are one-pixel hairlines. Static cards stay flat. Raised controls get a shallow 1–2 px bevel; pressed controls move down 1 px and lose the highlight. Inputs and the story composer use an inset well. Floating sheets use the restrained raised shadow. Avoid thick shadows and decorative left bars.

Texture is limited to the leather rail/panel, paper editor, and story-stage grain. Keep it out from behind prose, labels, and fields. Hide texture and depth effects for increased contrast, forced colors, and print.

## Layout and composition

- **Desktop (≥1200 px):** 248 px persistent leather rail; content capped around 1180 px. Library uses a featured resume scene and a cover wall. World detail uses a title-card header and editorial session list. Session uses a centered, letterboxed reading stage plus nearby field notes. Editor uses a daylight work surface, section rail, and readiness/preview column.
- **Tablet (900–1199 px):** compact top navigation, single reading column, notes drawer, and collapsed editor section picker.
- **Mobile (<900 px):** 56 px top bar, one-column content, safe-area-aware bottom tabs for top-level destinations, story dock in session, and save bar in editor. Recompose content; do not squeeze desktop columns.

Keep the story measure readable and state within one gesture. Avoid cards when a hairline-separated section is clearer. Never allow horizontal overflow.

## Components

- **Navigation rail:** leather ground, wordmark, two top-level destinations, recent worlds, and a labeled local-backend status. A thin brass spine is the signature detail.
- **Buttons:** nocturnal primary is brass with dark ink; daylight primary is forest with paper text. Secondary actions are outlined or ghost. Minimum touch target is 44 px.
- **Fields:** paper-raised or night-raised fill, one-pixel border, inset well, persistent label, and concise hint. Focus ring is 2 px brass with offset.
- **World covers:** use original illustrations in a consistent 3:2 crop with title and a compact status/genre/recency line. Do not overlay copy on busy artwork.
- **Story stage:** deep night surface, warm italic narration, upright ivory dialogue, restrained metadata, and a composer anchored beneath the reading flow.
- **Field notes:** compact resource and character summaries, presented beside the story on desktop and in a drawer/sheet at narrower widths.
- **Editor section rail:** paper workspace with completion cues, section navigation, a live preview, and one persistent save action.
- **Dialogs and menus:** use for contextual or destructive actions; return focus to the trigger after closing.

Use the preserved sprite in `build/icons.svg`; icons are inline SVG, generally 20 px with a 1.5 px stroke. Do not use emoji for functional icons.

## Motion and interaction

Use 160–220 ms for control feedback and 400–600 ms for scene transitions. Scene changes fade; prose does not slide. Pressed controls move 1 px. Do not delay readable content. No parallax, page flips, spring physics, or ambient autoplay. Honor `prefers-reduced-motion` by making transitions effectively instant.

Every focusable control has a clear `:focus-visible` ring. Hover must preserve or improve text contrast. Active, disabled, busy, and selected states must remain distinguishable without relying on color alone.

## Voice and brand

The interface speaks Indonesian, with natural, concise, human wording. Prefer story language such as “Lanjutkan cerita,” “Dunia kamu,” and “Catatan” over implementation terms. Keep technical terms only where the user needs them; never expose raw IDs, turn-commit language, or backend mechanics as user-facing labels. Use sentence case and short, action-led labels.

## Anti-patterns

- Multiple solid primary actions competing in one viewport.
- Fragmented story prose in repeated generic cards.
- Texture behind text, form labels, or inputs.
- Stitching, rivets, wax seals, torn paper, wood grain, glass, plastic, glossy gradients, or photorealistic material skins.
- Emoji icons, vague status colors, raw identifiers, invented metrics, or fake content presented as real.
- Thick decorative bars, shadows on static cards, or controls below 44 px.
- A desktop layout squeezed into mobile or horizontal scrolling.
- Cloud, account, social, or sync UI that contradicts the local-first product.

