# Fworld Design System Package Guide

This Claude Design package guide helps designers and agents reuse the source-backed Fworld interface system.

## Product Overview

Fworld is a locally hosted, story-first AI roleplay RPG. Its primary surfaces are the world library, world detail, long-form story session, daylight world editor, settings, and world creation. Core capabilities include resuming a story, searching and opening worlds, reading narration and dialogue, checking field notes, composing an action, configuring the narrator, and authoring a world.

## Product Context

The approved direction is **Cinematic Chapter**: a nocturnal forest shell with quiet brass affordances frames the reading stage; a daylight paper workshop supports editing. The product copy is Indonesian. Newsreader carries story and titles, Public Sans carries interface text, and IBM Plex Mono carries compact metadata. Source evidence includes original covers, an SVG icon sprite, local WOFF2 fonts, shared interaction code, and implemented screens.

## Source and Context References

- `context/source-context.md` identifies the source project and copied files.
- `context/provenance.md` maps evidence to package assets.
- `fworld-ui-ux-redesign-plan.md` records product goals, screen behavior, constraints, and the selected direction.
- `DESIGN.md` provides complete visual and interaction rules.
- `assets/tokens.css`, `assets/app.css`, and `assets/app.js` are the implementation references.
- `source_examples/` contains substantive copies of all six source screens and shared implementation files.

## Package Contents

- `DESIGN.md`, `SKILL.md`, and `colors_and_type.css`: design rules, discoverable skill instructions, and reusable token/type bindings.
- `assets/`: original tokens, app code, icon sprite, favicon, cover illustrations, material textures, and source fonts.
- `build/`: byte-preserved runtime assets with original filenames, including icon sprite, favicon, six covers, three textures, and five font files.
- `fonts/`: local WOFF2 files used by preview cards and the UI kit.
- `source_examples/`: six full HTML screen examples plus shared CSS, JavaScript, tokens, and SVG icons.
- `preview/`: focused review cards, embedded styles, and `manifest.json`.
- `ui_kits/app/`: runnable React kit with a composed entry point and modular components.
- Root HTML files remain the original prototype screens.

## Preview Manifest

Use `preview/manifest.json` to find each card. All paths below are exact, standalone HTML review cards. Each demonstrates source-backed values, components, or preserved assets.

| Path | Review purpose | Source evidence |
|---|---|---|
| `preview/colors.html` | Nocturnal, brass, story, and paper pairings | `assets/tokens.css` |
| `preview/colors-primary.html` | Primary and semantic color specimens | `colors_and_type.css` |
| `preview/typography.html` | Display, body, metadata, and editor type | `fonts/newsreader-*`, `fonts/public-sans-*`, `fonts/ibm-plex-mono-*` |
| `preview/typography-specimens.html` | Narrative and interface type scale | Self-hosted Newsreader, Public Sans, IBM Plex Mono |
| `preview/spacing.html` | Rhythm, reading measure, app frame, touch target | `assets/tokens.css` |
| `preview/spacing-tokens.html` | 4 px-based spacing scale | `assets/tokens.css` |
| `preview/depth.html` | Radius, bevel, well, and texture | `assets/textures/grain.svg`, `paper.svg`, `leather.svg` |
| `preview/components.html` | Story, world, field, and readiness patterns | `assets/app.css`, `build/icons.svg`, `build/covers/coast.svg` |
| `preview/components-buttons.html` | Primary, secondary, and focus states | `assets/app.css`, `colors_and_type.css` |
| `preview/brand-assets.html` | Product mark, cover artwork, and icon sprite | `build/favicon.svg`, `build/covers/*.svg`, `build/icons.svg` |
| `preview/applied-surfaces.html` | Implemented screens and editor composition | Six source screens and the original screenshot |

## UI Kit: `ui_kits/app/`

Open `ui_kits/app/index.html` to inspect the composed interface. It loads `../../colors_and_type.css`, embeds its review CSS, loads React 18.3.1, ReactDOM 18.3.1, Babel 7.29.0, and modular JSX files from `ui_kits/app/components/`. It exposes components on `window` and mounts `<App />` into `#root`. The kit supports library/session/settings navigation, world search, field notes, action composition, and text-size changes.

## Package Reuse Guide

1. Read `DESIGN.md` and the relevant file in `source_examples/` before changing a surface.
2. Load `colors_and_type.css`; keep the source OKLCH values, radius tokens, and local font files intact.
3. Choose a focused card from `preview/manifest.json` to review a token, component, or applied screen.
4. Reuse original assets from `build/` with relative paths. Do not redraw, replace, or hotlink this source artwork.
5. Compose new UI in `ui_kits/app/components/`, export the component to `window`, and mount it through the UI-kit entry.
6. Update the affected preview and manifest row when a reusable pattern changes.
7. Review desktop and mobile reflow, focus visibility, reduced motion, contrast, and Indonesian copy against the source screen before delivery.

This package guide documents reuse from actual Fworld product evidence; generated previews supplement the source files and do not replace them.