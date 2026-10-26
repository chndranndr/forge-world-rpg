# Source Project Context

This design-system workspace was created from an existing OpenDesign project. Treat the copied project files as the primary source evidence for the generated design system.

## Source project

- Source project id: efa176d1-7762-4537-9829-5b5ec6ba15af
- Source project name: Web Prototype
- New design-system project id: 2bd0b582-0f7d-461e-a3a1-008af0b568b0
- New design-system id: user:web-prototype-design-system
- Source skill id: (none)
- Source design system id: skeumorphism

## Source metadata

```json
{
  "kind": "prototype",
  "nameSource": "prompt",
  "linkedDirs": [
    "I:\\Gim\\Fworld"
  ],
  "scenarioBinding": {
    "schemaVersion": 1,
    "provenance": "explicit_user",
    "pluginId": "example-web-prototype",
    "snapshotId": "426c18ab-8ecb-490b-a2af-b763444a4208",
    "boundAt": 1792467090675
  }
}
```

## Copied files

- assets/app.css
- editor.html
- create-world.html
- screenshot-2026-10-20T07-37-52-617Z.png
- assets/app.js
- settings.html
- library.html
- session.html
- world.html
- assets/icons.svg
- assets/tokens.css
- assets/favicon.svg
- assets/textures/paper.svg
- assets/textures/leather.svg
- assets/textures/grain.svg
- assets/covers/archive.svg
- assets/covers/mountain.svg
- assets/covers/rain.svg
- assets/covers/desert.svg
- assets/covers/lantern.svg
- assets/covers/coast.svg
- assets/fonts/ibm-plex-mono-normal-500.woff2
- assets/fonts/ibm-plex-mono-normal-400.woff2
- assets/fonts/public-sans-normal-400-600.woff2
- assets/fonts/newsreader-normal-400-600.woff2
- assets/fonts/newsreader-italic-400-500.woff2
- fworld-ui-ux-redesign-plan.md

## Skipped files

- (none)

## Generation contract

- Read this file before editing design-system outputs.
- Read the copied files directly from the project workspace; they are source evidence, not generated design-system output.
- Preserve high-signal assets, source examples, UI surfaces, copy, tokens, typography, and interaction patterns from the copied project.
- Generate a reusable OpenDesign design-system package in this same project: DESIGN.md, README.md, SKILL.md, colors_and_type.css, context/provenance, focused preview cards, preserved assets/build/fonts when available, and ui_kits/app/.
- Before final response, run `"$OD_NODE_BIN" "$OD_BIN" tools connectors design-system-package-audit --path . --fail-on-warnings` and fix every actionable issue.
