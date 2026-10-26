# Fworld UI Kit Package Guide

## Product context

The kit applies Fworld's Cinematic Chapter system to its main tasks: return to a world, continue a story, inspect field notes, and adjust reading preferences. Reading surfaces use the dark forest shell; editing and preference surfaces use paper with the shared navigation frame.

## Structure

- `index.html` is the runnable React entry, loads `../../colors_and_type.css`, embeds review styles, loads React/ReactDOM/Babel, and mounts the app into `#root`.
- `components/NavigationRail.jsx` contains responsive primary navigation and recent worlds.
- `components/LibraryView.jsx` contains the featured story, searchable world collection, and source cover artwork.
- `components/SessionView.jsx` contains narration/dialogue, metadata, and the action composer.
- `components/NotesPanel.jsx` contains the field-notes drawer.
- `app.css` is the reusable responsive styling source embedded by `index.html`.
- The component HTML specimens in `components/` are standalone reference cards for the same patterns.

Each JSX module publishes its named component on `window` with `Object.assign` so the Babel-loaded entry can compose the modules without module scope.

## Usage workflow

1. Open `index.html` in a browser with network access for the specified React and Babel UMD scripts.
2. Navigate among Perpustakaan, Sesi, and Pengaturan. Search world titles, open and close Catatan, submit a sample action, and change story text size.
3. To add a product surface, implement a focused component in `components/`, publish it on `window`, mount it from `App`, and keep its labels and focus states in Indonesian.
4. Reuse token values through `../../colors_and_type.css`; use local artwork from `../../build/` and fonts from `../../fonts/`.
5. Add or update a focused preview card and its entry in `../../preview/manifest.json` when a pattern changes.
6. Compare the result with `../../source_examples/` and `DESIGN.md`; keep the desktop rail, mobile reflow, 44 px touch targets, and reduced-motion behavior intact.

## Design notes

Newsreader carries world titles and narrative; Public Sans handles controls and explanatory copy; IBM Plex Mono is reserved for compact metadata. Brass marks the active/primary state sparingly. Avoid texture behind text, raw IDs, emoji icons, duplicate primary actions, or invented product data. Artwork stays next to titles rather than carrying overlaid copy.

## Source basis

The kit is derived from the preserved `library.html`, `session.html`, `settings.html`, `editor.html`, shared `assets/app.css`, `assets/app.js`, `assets/tokens.css`, original SVG covers/icon sprite, and self-hosted font files. Detailed provenance is in `../../context/provenance.md`.