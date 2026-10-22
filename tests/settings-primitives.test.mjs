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
