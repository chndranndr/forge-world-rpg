# Surface brief: `src/components/GameLibrary.tsx`

Mode: Operate. Scope: existing home/library and its world-detail continuation route. Audience: the local author choosing a world, resuming progress, or starting an independent playthrough. Seed: none (existing surface extension). Build path: code-led. The app’s established palette, typography, responsive shell, and native controls remain authoritative; no new visual identity or concept seed.

## Direction contract

**THESIS:** Put the author’s next useful action at the top; reject a feature-story banner that competes with creating or finding a world.

**OWN-WORLD:** Inherit the existing forest-and-brass interface, literary headings, practical controls, compact metadata, and restrained illustrated covers. Keep the tile and resume area native to Fworld, not a new metaphor.

**STORY:** Distinguish saved worlds from saved sessions. Creation is always visible; a world’s `Sesi baru` shortcut opens its own form, focuses the name field, and creates nothing until submit.

**FIRST VIEWPORT:** `Dunia kamu.` and a brass `Buat dunia` action lead the same header in empty and populated states. A real latest session may add a compact resume row with a small cover, title, session name, location/time, and quiet continuation action. At 390×844, creation stays visible without scrolling.

**FORM:** Code-led extension; `seed: none (existing surface extension)`. Signature interaction: world tile → `Sesi baru` → focused fresh-session form, with no POST before submit.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
