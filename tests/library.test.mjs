import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

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

function entry(id, updatedAt, sessions = []) {
  return {
    game: { revision: 1, value: { id, title: id, updatedAt } },
    sessions: sessions.map(
      ([sessionId, sessionUpdatedAt, pinned = false], index) => ({
        revision: 1,
        value: {
          id: sessionId,
          updatedAt: sessionUpdatedAt,
          index,
          pinned,
        },
        turnCount: 0,
        excerpt: null,
      }),
    ),
  };
}

test("latest session and overall activity follow session timestamps", () => {
  const older = entry("older", "2026-10-01T10:00:00.000Z", [
    ["s-old", "2026-10-02T10:00:00.000Z"],
    ["s-new", "2026-10-05T10:00:00.000Z"],
  ]);
  const newer = entry("newer", "2026-10-03T10:00:00.000Z", [
    ["s-newer", "2026-10-04T10:00:00.000Z"],
  ]);
  const draft = entry("draft", "2026-10-09T10:00:00.000Z");

  assert.equal(library.latestSession(older).value.id, "s-new");
  assert.equal(library.latestSession(draft), undefined);
  assert.equal(
    library.latestOverall([older, newer, draft])?.session.value.id,
    "s-new",
  );
  assert.deepEqual(
    library
      .sortByActivity([older, newer, draft])
      .map((item) => item.game.value.id),
    ["draft", "older", "newer"],
  );
});

test("pinned display order does not affect recency selectors", () => {
  const world = entry("world", "2026-10-01T00:00:00.000Z", [
    ["latest-unpinned", "2026-10-09T00:00:00.000Z"],
    ["pinned-older", "2026-10-04T00:00:00.000Z", true],
    ["z-tie", "2026-10-05T00:00:00.000Z", true],
    ["a-tie", "2026-10-05T00:00:00.000Z", true],
  ]);

  assert.deepEqual(
    library.displaySessions(world).map((session) => session.value.id),
    ["a-tie", "z-tie", "pinned-older", "latest-unpinned"],
  );
  assert.equal(library.latestSession(world).value.id, "latest-unpinned");
  assert.equal(
    library.latestOverall([world])?.session.value.id,
    "latest-unpinned",
  );
});

test("cover selection maps titles and genres to all six originals", () => {
  const mappings = [
    [{ genre: "Fantasy", title: "Ragnarok" }, "lantern"],
    [{ genre: "Drama", title: "Fantasy in the rain" }, "archive"],
    [{ genre: "Misteri", title: "Pesisir Utara" }, "coast"],
    [{ genre: "Petualangan", title: "Pesisir Utara" }, "coast"],
    [{ genre: "Petualangan", title: "Lentera di Hutan" }, "lantern"],
    [{ genre: "Petualangan", title: "Arsip Hujan" }, "archive"],
    [{ genre: "Petualangan", title: "Mountain Pass" }, "mountain"],
    [{ genre: "Petualangan", title: "Desert Bloom" }, "desert"],
    [{ genre: "Petualangan", title: "Rainfall" }, "rain"],
    [{ genre: "Adventure", title: "Gurun Pasir" }, "desert"],
    [{ genre: "Adventure", title: "Hujan di Desa" }, "rain"],
    [{ genre: "Adventure", title: "Gunung Utara" }, "mountain"],
    [{ genre: "Gurun", title: "Hamparan Pasir" }, "desert"],
    [{ genre: "Hujan", title: "Musim Panjang" }, "rain"],
  ];

  for (const [game, expected] of mappings) {
    assert.equal(library.coverIdFor(game), expected);
  }
});

test("unknown cover selection is repeatable and distributes across all six", () => {
  const coverIds = [
    "coast",
    "lantern",
    "archive",
    "desert",
    "mountain",
    "rain",
  ];
  const unknown = { genre: "unclassified", title: "Dunia tanpa penanda" };
  const selected = library.coverIdFor(unknown);
  const fallbackIds = [..."ABCDEF"].map((title) =>
    library.coverIdFor({ genre: "", title }),
  );

  assert.equal(library.coverIdFor(unknown), selected);
  assert.ok(coverIds.includes(selected));
  assert.deepEqual([...new Set(fallbackIds)].sort(), [...coverIds].sort());
});

test("relative time labels stay in Indonesian buckets", () => {
  const now = Date.parse("2026-10-20T12:00:00.000Z");
  assert.equal(
    library.relativeTime("2026-10-20T11:59:30.000Z", now),
    "baru saja",
  );
  assert.equal(
    library.relativeTime("2026-10-20T11:40:00.000Z", now),
    "20 menit lalu",
  );
  assert.equal(
    library.relativeTime("2026-10-20T09:00:00.000Z", now),
    "3 jam lalu",
  );
  assert.equal(
    library.relativeTime("2026-10-19T09:00:00.000Z", now),
    "kemarin",
  );
  assert.equal(
    library.relativeTime("2026-10-17T09:00:00.000Z", now),
    "3 hari lalu",
  );
  assert.equal(
    library.relativeTime("2026-09-01T09:00:00.000Z", now),
    new Intl.DateTimeFormat("id-ID", { dateStyle: "medium" }).format(
      new Date("2026-09-01T09:00:00.000Z"),
    ),
  );
  assert.equal(library.relativeTime("bukan tanggal", now), "");
});
