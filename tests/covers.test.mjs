import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createServer } from "vite";

const COVERS = ["coast", "lantern", "archive", "desert", "mountain", "rain"];
let vite;
let library;

test.before(async () => {
  vite = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  library = await vite.ssrLoadModule("/src/library.ts");
});

test.after(async () => {
  await vite?.close();
});

test("every cover asset is a 3:2 illustration", () => {
  for (const name of COVERS) {
    const svg = readFileSync(`src/assets/covers/${name}.svg`, "utf8");
    const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1];
    assert.ok(viewBox, `${name}.svg must declare a viewBox`);
    const [, , width, height] = viewBox.trim().split(/\s+/).map(Number);
    assert.equal(width / height, 1.5, `${name}.svg must be 3:2`);
  }
});

test("cover selection is deterministic and genre-aware", () => {
  assert.equal(
    library.coverIdFor({ genre: "Fantasy adventure RPG", title: "Ragnarok" }),
    "lantern",
  );
  assert.equal(
    library.coverIdFor({ genre: "Drama", title: "Arsip Hujan" }),
    "archive",
  );
  assert.equal(
    library.coverIdFor({ genre: "Misteri", title: "Pesisir Utara" }),
    "coast",
  );
  const first = library.coverIdFor({ genre: "", title: "Dunia Tanpa Genre" });
  const second = library.coverIdFor({ genre: "", title: "Dunia Tanpa Genre" });
  assert.equal(first, second);
  assert.ok(COVERS.includes(first));
});
