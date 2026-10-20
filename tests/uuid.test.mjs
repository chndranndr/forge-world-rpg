import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

let server;
let createUuid;

test.before(async () => {
  server = await createServer({ server: { port: 0, open: false } });
  await server.listen();
  ({ createUuid } = await server.ssrLoadModule("/shared/uuid.ts"));
});

test.after(async () => {
  await server.close();
});

test("creates v4 UUIDs with Web Crypto when randomUUID is unavailable", () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  let randomFillCount = 0;

  try {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        getRandomValues(bytes) {
          randomFillCount += 1;
          bytes.fill(0);
          bytes[0] = 1;
          return bytes;
        },
      },
    });
    assert.equal(createUuid(), "01000000-0000-4000-8000-000000000000");
    assert.equal(randomFillCount, 1);

    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { randomUUID: () => "native-uuid" },
    });
    assert.equal(createUuid(), "native-uuid");

    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {},
    });
    assert.throws(createUuid, /Secure random number generation is unavailable/);
  } finally {
    if (originalCrypto) {
      Object.defineProperty(globalThis, "crypto", originalCrypto);
    } else {
      Reflect.deleteProperty(globalThis, "crypto");
    }
  }
});
