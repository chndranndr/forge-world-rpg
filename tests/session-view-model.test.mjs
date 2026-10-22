import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

let vite;
let model;

test.before(async () => {
  vite = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  model = await vite.ssrLoadModule("/src/session-view-model.ts");
});

test.after(async () => {
  await vite?.close();
});

function message({ id, turnId, sequence, role, content = "teks", speakerId }) {
  return {
    id,
    sessionId: "session-1",
    turnId,
    sequence,
    role,
    ...(speakerId === undefined ? {} : { speakerId }),
    content,
    createdAt: "2026-10-21T00:00:00.000Z",
  };
}

test("dialogue stays scoped to the latest story turn", () => {
  const scene = model.latestSceneMessages([
    message({
      id: "m1",
      turnId: "turn-1",
      sequence: 1,
      role: "NPC",
      speakerId: "npc-mara",
      content: "dialog lama",
    }),
    message({
      id: "m2",
      turnId: "turn-2",
      sequence: 2,
      role: "NARRATOR",
      content: "narasi baru",
    }),
    message({
      id: "m3",
      turnId: "turn-2",
      sequence: 3,
      role: "NPC",
      speakerId: "npc-mara",
      content: "dialog baru",
    }),
  ]);
  assert.equal(scene.narration?.content, "narasi baru");
  assert.equal(scene.dialogue?.content, "dialog baru");
});

test("an older turn's dialogue never leaks into the current scene", () => {
  const scene = model.latestSceneMessages([
    message({
      id: "m1",
      turnId: "turn-1",
      sequence: 1,
      role: "NPC",
      speakerId: "npc-mara",
      content: "dialog lama",
    }),
    message({
      id: "m2",
      turnId: "turn-2",
      sequence: 2,
      role: "NARRATOR",
      content: "narasi baru",
    }),
  ]);
  assert.equal(scene.dialogue, null);
});

test("empty and system-only histories have no scene", () => {
  assert.deepEqual(model.latestSceneMessages([]), {
    narration: null,
    dialogue: null,
  });
  assert.deepEqual(
    model.latestSceneMessages([
      message({
        id: "m1",
        turnId: "turn-1",
        sequence: 1,
        role: "SYSTEM_EVENT",
        content: "item dipakai",
      }),
    ]),
    { narration: null, dialogue: null },
  );
});

test("scene eyebrow labels a scene, not a chapter", () => {
  assert.equal(model.sceneEyebrow(4, "Tepi Teluk"), "Adegan 04 · Tepi Teluk");
  assert.equal(model.sceneEyebrow(0, "Tepi Teluk"), "Adegan 01 · Tepi Teluk");
});

test("message author uses NPC names and never raw ids", () => {
  assert.equal(
    model.messageAuthor(
      { role: "NPC", speakerId: "npc-mara" },
      {
        "npc-mara": "Mara",
      },
    ),
    "Mara",
  );
  assert.equal(
    model.messageAuthor({ role: "NPC", speakerId: "npc-unknown" }, {}),
    "NPC",
  );
  assert.equal(model.messageAuthor({ role: "NARRATOR" }, {}), "Narator");
  assert.equal(model.messageAuthor({ role: "PLAYER" }, {}), "Pemain");
});
