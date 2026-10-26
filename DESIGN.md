---
name: Fworld
description: A local worldbuilding and AI-narrated roleplay RPG.
colors:
  forest-night: "oklch(0.17 0.012 160)"
  forest-surface: "oklch(0.215 0.014 160)"
  forest-raised: "oklch(0.25 0.014 160)"
  forest-deep: "oklch(0.135 0.01 160)"
  forest-border: "oklch(0.32 0.012 160)"
  warm-linen: "oklch(0.93 0.01 90)"
  muted-linen: "oklch(0.72 0.015 90)"
  aged-brass: "oklch(0.78 0.11 75)"
  brass-ink: "oklch(0.2 0.02 75)"
  story-gold: "oklch(0.885 0.06 85)"
typography:
  display:
    fontFamily: '"Newsreader", "Iowan Old Style", "Palatino Linotype", Georgia, serif'
    fontSize: "clamp(34px, 4vw, 54px)"
    fontWeight: 500
    lineHeight: 1.05
  body:
    fontFamily: '"Public Sans", system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.55
  story:
    fontFamily: '"Newsreader", "Iowan Old Style", "Palatino Linotype", Georgia, serif'
    fontSize: "19px"
    fontWeight: 400
    lineHeight: 1.75
  label:
    fontFamily: '"IBM Plex Mono", ui-monospace, "Cascadia Mono", Consolas, monospace'
    fontSize: "10px"
    fontWeight: 400
    letterSpacing: "0.1em"
rounded:
  control: "4px"
  panel: "8px"
  sheet: "14px"
spacing:
  space-1: "4px"
  space-2: "8px"
  space-3: "12px"
  space-4: "16px"
  space-5: "24px"
  space-6: "32px"
components:
  button-primary:
    backgroundColor: "{colors.aged-brass}"
    textColor: "{colors.brass-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 18px"
    height: "46px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.muted-linen}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "44px"
  nav-active:
    backgroundColor: "{colors.forest-raised}"
    textColor: "{colors.warm-linen}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "44px"
  text-field:
    backgroundColor: "{colors.forest-raised}"
    textColor: "{colors.warm-linen}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
    height: "44px"
  story-scene:
    backgroundColor: "{colors.forest-deep}"
    textColor: "{colors.warm-linen}"
    padding: "44px 52px"
---

# Design System: Fworld

## Overview

**Creative North Star: "A field journal in lamplight"**

Fworld's implemented interface pairs deep forest-dark surfaces with an aged-brass accent. Newsreader gives world titles and story prose a literary cadence; Public Sans keeps controls and forms direct; IBM Plex Mono marks compact metadata. The atmosphere comes from restrained material cues and clear state changes, not decorative clutter.

The confirmed shared direction is dark forest and brass across every page. The current library, settings, and story surfaces use that palette, but the Editor still uses a warm-paper treatment. That page-by-page split conflicts with PRODUCT.md. Treat the paper Editor as a documented implementation exception, not as a second approved theme or a pattern for new work. This document records the current CSS and the confirmed common direction; it does not change the UI.

**Key Characteristics:**

- Deep forest surfaces, warm linen text, and restrained aged-brass actions.
- Literary Newsreader narrative, practical Public Sans controls, and compact mono labels.
- Tactile depth through tonal layers and inset wells, with visible focus states.
- One shared dark palette is the target; the paper Editor is a known mismatch.

## Colors

The rendered dark system uses the OKLCH values in the frontmatter; `src/styles.css` keeps fallback declarations before the active OKLCH definitions. Forest tones carry the application shell and panels, warm linen carries primary text, and aged brass marks actions, focus, and selected states.

### Primary

- **Aged brass** (`colors.aged-brass`): primary actions, selected navigation markers, and focus emphasis.
- **Warm story gold** (`colors.story-gold`): narrative prose on the dark story stage.

### Neutral

- **Forest night** (`colors.forest-night`): the application canvas.
- **Forest surface** (`colors.forest-surface`): rails, featured content, and grouped panels.
- **Raised forest** (`colors.forest-raised`): interactive and inset surfaces.
- **Deep forest** (`colors.forest-deep`): the narrative scene and recessed fields.
- **Forest border** (`colors.forest-border`): quiet separation between regions.
- **Warm linen** (`colors.warm-linen`): primary text on dark surfaces.
- **Muted linen** (`colors.muted-linen`): secondary text and quiet controls.

The Editor currently applies a separate light-paper token family from `src/styles.css`. It is not part of the shared direction and should not be extended to other pages.

**The One Palette Rule.** Use the same dark forest and aged-brass palette across every page; do not create page-specific light and dark themes.

## Typography

**Display Font:** Newsreader (with Iowan Old Style, Palatino Linotype, Georgia, and serif fallbacks)  
**Body Font:** Public Sans (with system sans-serif fallbacks)  
**Label/Mono Font:** IBM Plex Mono (with platform monospace fallbacks)

**Character:** The serif voice gives story text a measured, literary rhythm. The sans-serif interface stays practical and legible; mono labels make compact status and metadata easy to scan.

### Hierarchy

- **Display** (500, `clamp(34px, 4vw, 54px)`, `1.05`): page titles and the strongest world headings.
- **Headline** (500, `34px` for featured titles and `42px` for scene headings, `1.1`): featured-world and scene headings.
- **Title** (500, `26px`, `1.15`): settings sections and grouped content.
- **Body** (400, `14px`, `1.55`): controls, descriptions, and general interface text.
- **Story** (400 italic where narrated, `19px`, `1.75`; session prose uses `20px/1.8`): narrative with a readable measure of about `70ch`.
- **Label** (400, `10px`, `0.1em`, uppercase for eyebrows): compact section labels and metadata.

**The Reading-Tool Split.** Keep Newsreader for display and story content, Public Sans for interface controls, and IBM Plex Mono for compact metadata.

## Layout

The desktop shell uses a fixed-width navigation rail (`248px`) beside a centered main column capped at `1180px`. Library cards form a three-column grid at wide sizes; the story layout pairs a bounded narrative column with a notes panel. The Editor uses a `232px` section rail beside its form and may add a preview column on wide screens.

At `1199px` and below, the main rail moves to a horizontal top bar and content becomes full-width. At `899px` and below, navigation becomes a fixed bottom bar that respects the device safe area; the library grid and Editor collapse to one column, and session notes move out of the side-by-side layout. These thresholds reflect `src/styles.css`; the older breakpoint wording in README.md is not the current CSS contract.

## Elevation & Depth

Depth is tactile but restrained. Tonal forest surfaces and borders do most of the separation; inset wells and bevels mark interactive or recessed areas. Raised shadows are reserved for overlays and elevated elements, not applied indiscriminately. Reduced-motion preferences suppress transitions and animation.

**The Tactile-Depth Rule.** Let tonal forest surfaces and borders carry most separation; reserve raised shadows for elements that need lift.

### Shadow Vocabulary

- **Raised surface** (`--shadow-raised`): low, wide lift for elevated controls or surfaces that need separation.
- **Sunken well** (`--well`): inset depth for fields that sit inside a panel.
- **Scene edge** (`inset 0 1px #ffffff08`): a restrained inner highlight on the narrative stage.
- **Paper Editor legacy** (`--shadow-paper`): current Editor-only treatment; not a shared-page pattern.

## Shapes

Interactive controls use gently squared corners (`4px`); panels use a modest round (`8px`); the larger sheet token is `14px`. The story scene and main feature frame remain square-edged. Borders are thin and tonal, with brass reserved for state emphasis rather than general framing.

## Components

### Buttons

- **Shape:** Gently squared (`4px`), with minimum heights of `44px` for quiet controls and `46px` for primary actions.
- **Primary:** Aged-brass fill, dark brass-ink text, and a subtle inset highlight; hover shifts to the brighter brass token.
- **Quiet:** Transparent at rest with a tonal border and muted text; hover fills with the raised forest surface.
- **Focus:** A visible `2px` brass outline with `3px` offset.

### Cards / Containers

- **Library feature:** Forest surface, thin border, inset spacing, and a wide cover image; the cover uses a `3:2` source ratio in world cards.
- **World tiles:** Quiet at rest; a forest surface and border appear on hover, with a slight `1px` lift.
- **Story scene:** Deep forest panel, thin border, square corners, and generous `44px 52px` desktop padding; narrower screens reduce the padding.
- **Editor:** The existing Editor is wrapped in a light-paper surface with paper-specific form, card, and shadow tokens. This is the sole current page-level palette exception and conflicts with the confirmed shared direction.

### Inputs / Fields

- **Style:** Dark raised surface, tonal border, `4px` corners, and `44px` minimum height; textareas grow vertically.
- **Focus:** The shared brass focus outline remains visible for keyboard users.
- **Editor exception:** Editor fields currently use the light-paper token family; do not reproduce that exception on new pages.

### Navigation

The desktop rail is forest-surface with a thin divider. Active items use a raised surface and a narrow inset brass marker. At tablet widths it becomes a horizontal top rail; on narrow screens it becomes a fixed three-item bottom bar with safe-area padding.

**The Focus Ring Rule.** Keyboard focus remains visible; never remove the brass outline without an equally clear replacement.

## Do's and Don'ts

### Do:

- **Do** use the shared dark forest and aged-brass palette on every page.
- **Do** keep story typography, interface typography, and mono metadata in their established roles.
- **Do** preserve the visible focus ring and comfortable `44px` control targets.
- **Do** use tonal layering before adding heavier shadows.

### Don't:

- **Don't** extend the Editor's light-paper treatment to other pages; it is a current mismatch, not a second theme.
- **Don't** create a page-by-page light/dark split.
- **Don't** introduce a new accent color without an explicit system-level decision.
