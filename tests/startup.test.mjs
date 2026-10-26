import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createServer } from "vite";

test("frontend starts and renders app and narrative dialogue", async (t) => {
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
    assert.match(markup, /<main class="main">/);
    assert.match(markup, /class="rail texture"/);
    assert.match(markup, /<nav aria-label="Navigasi utama">/);
    assert.match(markup, /Perpustakaan/);
    const { StoryMarkdown } = await server.ssrLoadModule(
      "/src/components/StoryMarkdown.tsx",
    );
    await t.test(
      "quoted dialogue stays normal across Markdown formatting",
      () => {
        const storyMarkup = renderToStaticMarkup(
          createElement(StoryMarkdown, {
            content: [
              'Mioca menekan **Accept Order**. "Untuk Katsu-nya? Omakase *set-nya* sudah disediakan." Setelah itu.',
              "",
              '- "Bawa mantel."',
              "",
              "Narasi lanjutan.",
            ].join("\n"),
          }),
        );
        const dialogueText = [
          ...storyMarkup.matchAll(
            /<span class="story-dialogue">([^<]*)<\/span>/g,
          ),
        ]
          .map(([, text]) => text)
          .join("")
          .replaceAll("&quot;", '"');

        assert.equal(
          dialogueText,
          '"Untuk Katsu-nya? Omakase set-nya sudah disediakan.""Bawa mantel."',
        );
        assert.match(storyMarkup, /<li><span class="story-dialogue">/);
        assert.match(storyMarkup, /<strong>Accept Order<\/strong>/);
        assert.match(
          storyMarkup,
          /<em><span class="story-dialogue">set-nya<\/span><\/em>/,
        );
        assert.match(storyMarkup, /<p>Narasi lanjutan\.<\/p>/);
      },
    );
  } finally {
    await server.close();
  }
});
