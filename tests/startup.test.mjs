import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createServer } from "vite";

test("frontend starts, serves its entry point, and renders the app", async () => {
  const server = await createServer({
    server: { port: 0, open: false },
  });
  try {
    await server.listen();
    const address = server.httpServer.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(origin);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<div id="root"><\/div>/);
    const entryPath = html.match(/src="([^\"]*\/src\/main\.tsx)"/)?.[1];
    assert.ok(entryPath, "HTML must reference the application entry point");
    const entry = await fetch(new URL(entryPath, origin));
    assert.equal(entry.status, 200);
    assert.match(await entry.text(), /createRoot/);
    const { default: App } = await server.ssrLoadModule("/src/App.tsx");
    const markup = renderToStaticMarkup(createElement(App));
    assert.match(markup, /<main>/);
    assert.match(markup, /<h1 class="brand">.*Fworld<\/h1>/);
    assert.match(markup, /class="bottom-nav"/);
  } finally {
    await server.close();
  }
});
