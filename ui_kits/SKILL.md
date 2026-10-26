---
name: fworld-design-system
description: Apply Fworld's source-backed Cinematic Chapter design system to story, library, world, editor, settings, and responsive web surfaces.
user-invocable: true
---

# Fworld Design System Skill

## What is inside

This package provides reusable visual rules, source-derived tokens, standalone preview cards, original build assets, source screen snapshots, and a composed React UI kit. Start with `DESIGN.md`; use `assets/tokens.css` for the complete original token implementation and `colors_and_type.css` for portable palette and font bindings.

## Source context

Fworld is a local-first AI roleplay RPG. This package is derived from the Web Prototype source project and its approved “Cinematic Chapter” redesign. Evidence includes the source context and redesign plan, six implemented HTML screens, shared app CSS/JS, token CSS, original SVG icon sprite, favicon, cover illustrations, material textures, self-hosted font files, and the editor screenshot. See `context/provenance.md` for the source-to-package map and `source_examples/` for preserved implementation snapshots.

## When to use this skill

Use this skill when creating, extending, reviewing, or refining Fworld web UI: the library, world details, story session, world editor, settings, creation flow, field notes, and their responsive states. Keep the visual direction and Indonesian product voice consistent unless the user explicitly changes them.

## How to use

1. Read `DESIGN.md` and the relevant source screen in `source_examples/` before implementation.
2. Load `colors_and_type.css` and use Newsreader for narrative/display text, Public Sans for interface text, and IBM Plex Mono for compact metadata.
3. Preserve the nocturnal shell for reading and browsing; use daylight paper for editing.
4. Reuse original files from `build/` and bundled fonts rather than redrawing or hotlinking them.
5. Keep one solid primary action in a viewport, controls at least 44 px high, and visible focus states.
6. Compose patterns from `ui_kits/app/components/`; update the matching card and `preview/manifest.json` when a reusable pattern changes.
7. Verify responsive reflow, contrast, reduced motion, and Indonesian copy against the source context.

## Design system highlights

- Forest-black shell, ivory text, restrained brass signal, deep story stage, and paper editor.
- Newsreader / Public Sans / IBM Plex Mono type system with local WOFF2 files.
- 4 px spacing base, 4/8/14 px control-panel-sheet radii, shallow bevels, and inset writing wells.
- 248 px desktop rail, content capped near 1180 px, tablet compact navigation, mobile single-column reflow.
- Leather, paper, and grain textures are structural and subtle; never place them behind text or controls.
- No emoji icons, raw IDs, invented metrics, competing primary buttons, decorative material props, or horizontal scrolling.
