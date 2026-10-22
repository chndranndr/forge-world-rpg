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
  const dialogLabel = markup.match(
    /<dialog\b[^>]*\baria-labelledby="([^"]+)"/,
  )?.[1];
  const titleId = markup.match(
    /<h2\b[^>]*\bid="([^"]+)">Hapus cerita\?<\/h2>/,
  )?.[1];
  assert.ok(dialogLabel, "dialog must reference an accessible label");
  assert.ok(titleId, "dialog title must have an id");
  assert.equal(dialogLabel, titleId);
  assert.match(markup, /Hapus permanen/);
  assert.match(markup, />Batal</);
});
