import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VIEWPORTS = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 600, height: 960 },
  { width: 820, height: 1180 },
  { width: 1024, height: 768 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];
const BASE_URL = process.argv[2] ?? "http://127.0.0.1:5173/";
const OUTPUT_DIRECTORY = process.env.UI_CHECK_OUTPUT ?? ".pstack/ui-check";
const SCREENSHOTS = [
  ["library", 'section[aria-label="Perpustakaan game"]'],
  ["create-world", 'section[aria-label="Buat dunia"]'],
  ["blank-editor", ".editor-workshop"],
  ["settings", ".settings-page"],
  ["world-detail", 'section[aria-label^="Detail dunia "]'],
  ["session", ".session-view"],
];
const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
const edgePath = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
if (!edgePath) {
  console.error("Microsoft Edge tidak ditemukan. Set EDGE_PATH.");
  process.exit(1);
}

mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
for (const { width, height } of VIEWPORTS) {
  rmSync(join(OUTPUT_DIRECTORY, `${width}x${height}.png`), { force: true });
}
for (const [screen] of SCREENSHOTS) {
  for (const { width, height } of VIEWPORTS) {
    rmSync(join(OUTPUT_DIRECTORY, `${screen}-${width}x${height}.png`), {
      force: true,
    });
  }
}
const profileDirectory = mkdtempSync(join(tmpdir(), "fworld-ui-check-"));
let edge;
let socket;
let send;
let activeLabel = "browser startup";
const failures = [];
const exceptions = [];
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForExit(milliseconds) {
  if (!edge || edge.exitCode !== null || edge.signalCode !== null) return;
  await new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      edge.off("exit", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    edge.once("exit", finish);
  });
}

try {
  edge = spawn(
    edgePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-mode",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let launchError;
  edge.on("error", (error) => {
    launchError = error;
  });

  const activePortFile = join(profileDirectory, "DevToolsActivePort");
  let debugPort;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (launchError) throw new Error(`Edge gagal dijalankan: ${launchError}`);
    if (edge.exitCode !== null) {
      throw new Error(
        `Edge berhenti saat memulai dengan kode ${edge.exitCode}.`,
      );
    }
    try {
      debugPort = Number(
        readFileSync(activePortFile, "utf8").split(/\r?\n/, 1)[0],
      );
      if (!Number.isInteger(debugPort) || debugPort <= 0 || debugPort > 65535) {
        debugPort = undefined;
      }
    } catch {
      debugPort = undefined;
    }
    if (debugPort !== undefined) break;
    await sleep(250);
  }
  if (debugPort === undefined) {
    throw new Error("DevToolsActivePort tidak tersedia setelah 10 detik.");
  }

  let pageSocketUrl;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      ).json();
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) {
        pageSocketUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch {
      await sleep(250);
    }
  }
  if (!pageSocketUrl) throw new Error("CDP tidak siap setelah 10 detik.");

  socket = new WebSocket(pageSocketUrl);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") {
      const detail =
        message.params?.exceptionDetails?.text ??
        message.params?.exceptionDetails?.exception?.description ??
        "runtime exception";
      exceptions.push(`${activeLabel}: ${detail}`);
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`${activeLabel}: ${result.exceptionDetails.text}`);
    }
    return result.result.value;
  };
  const waitFor = async (expression, description) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await sleep(250);
    }
    throw new Error(`${activeLabel}: timed out waiting for ${description}.`);
  };
  const clickAt = async (selector, index, description) => {
    const clicked = await evaluate(`(() => {
      const element = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!element || element.disabled) return false;
      element.click();
      return true;
    })()`);
    if (!clicked)
      throw new Error(`${activeLabel}: could not click ${description}.`);
  };
  const clickText = async (selector, text, description) => {
    const clicked = await evaluate(`(() => {
      const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
        .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(text)});
      if (!element || element.disabled) return false;
      element.click();
      return true;
    })()`);
    if (!clicked)
      throw new Error(`${activeLabel}: could not click ${description}.`);
  };
  const capture = async (screen, viewport) => {
    const screenSelector = SCREENSHOTS.find(([name]) => name === screen)?.[1];
    activeLabel = `${screen} ${viewport.width}x${viewport.height}`;
    const identity = await evaluate(
      "document.title === 'Fworld' && document.querySelector('.brand b')?.textContent.trim() === 'Fworld'",
    );
    const screenPresent = await evaluate(
      `document.querySelector(${JSON.stringify(screenSelector)}) !== null`,
    );
    const overflow = await evaluate(
      "document.documentElement.scrollWidth - window.innerWidth",
    );
    const screenshot = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    if (screen === "blank-editor") {
      // Other screens can contain saved user content.
      writeFileSync(
        join(
          OUTPUT_DIRECTORY,
          `${screen}-${viewport.width}x${viewport.height}.png`,
        ),
        Buffer.from(screenshot.data, "base64"),
      );
    }
    console.log(`${activeLabel} overflow=${overflow}`);
    if (!identity) failures.push(`${activeLabel}: Fworld identity missing.`);
    if (!screenPresent)
      failures.push(`${activeLabel}: expected screen missing.`);
    if (overflow > 0) {
      failures.push(`${activeLabel}: horizontal overflow ${overflow}px.`);
    }
  };
  const libraryReady =
    'Boolean(document.querySelector(\'section[aria-label="Perpustakaan game"]\')) && !document.querySelector(".library-loading")';
  const primaryNavClick = async (label, viewport) => {
    activeLabel = `${label} ${viewport.width}x${viewport.height}`;
    await clickText(
      'nav[aria-label="Navigasi utama"] button',
      label,
      `primary navigation ${label}`,
    );
  };

  await send("Page.enable");
  await send("Runtime.enable");
  for (const viewport of VIEWPORTS) {
    activeLabel = `library ${viewport.width}x${viewport.height}`;
    await send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.width <= 430,
    });
    const navigation = await send("Page.navigate", { url: BASE_URL });
    if (navigation.errorText) {
      throw new Error(
        `${activeLabel}: navigation failed: ${navigation.errorText}`,
      );
    }
    await waitFor(libraryReady, "library and loading completion");
    await capture("library", viewport);
    const libraryState = await evaluate(`(() => {
      const library = document.querySelector('section[aria-label="Perpustakaan game"]');
      return {
        worldCount: document.querySelectorAll('button[aria-label^="Buka dunia "]').length,
        error: library?.querySelector('[role="alert"]')?.textContent.trim() ?? null,
      };
    })()`);
    if (libraryState.worldCount === 0 && libraryState.error) {
      throw new Error(
        `${activeLabel}: precondition failed: saved worlds could not be loaded (${libraryState.error}).`,
      );
    }

    activeLabel = `create-world ${viewport.width}x${viewport.height}`;
    await clickText(
      "button",
      libraryState.worldCount > 0 ? "Dunia baru" : "Buat dunia",
      libraryState.worldCount > 0 ? "Dunia baru" : "Buat dunia",
    );
    await waitFor(
      "document.querySelector('section[aria-label=\"Buat dunia\"]') !== null",
      "Create World screen",
    );
    await capture("create-world", viewport);

    activeLabel = `blank-editor ${viewport.width}x${viewport.height}`;
    await clickAt(
      'button[aria-label="Pilih dunia kosong"]',
      0,
      "Pilih dunia kosong",
    );
    await waitFor(
      'document.querySelector(\'button[aria-label="Pilih dunia kosong"]\')?.getAttribute("aria-pressed") === "true"',
      "blank world selection",
    );
    await clickText(
      "button",
      "Gunakan pilihan & buka editor",
      "open blank editor",
    );
    await waitFor(
      'document.querySelector(".editor-workshop") !== null',
      "blank editor",
    );
    await capture("blank-editor", viewport);
    await clickAt(".editor-workshop button.editor-back", 0, "editor Kembali");
    await waitFor(
      'document.querySelector("dialog[open]") !== null',
      "unsaved draft prompt",
    );
    await clickText(
      "dialog[open] button",
      "Buang perubahan",
      "Buang perubahan",
    );
    await waitFor(libraryReady, "library after discarding the in-memory draft");

    await primaryNavClick("Pengaturan", viewport);
    await waitFor(
      'document.querySelector(".settings-page") !== null',
      "Settings screen",
    );
    await capture("settings", viewport);
    await primaryNavClick("Perpustakaan", viewport);
    await waitFor(libraryReady, "library after Settings");

    activeLabel = `world-detail ${viewport.width}x${viewport.height}`;
    const savedWorldCount = await evaluate(
      "document.querySelectorAll('button[aria-label^=\"Buka dunia \"]').length",
    );
    if (savedWorldCount === 0) {
      throw new Error(
        `${activeLabel}: precondition failed: World Detail requires at least one saved world button.`,
      );
    }
    let openedSession = false;
    for (let index = 0; index < savedWorldCount; index += 1) {
      activeLabel = `world-detail ${viewport.width}x${viewport.height}`;
      await clickAt(
        'button[aria-label^="Buka dunia "]',
        index,
        `saved-world button ${index + 1}`,
      );
      await waitFor(
        "document.querySelector('section[aria-label^=\"Detail dunia \"]') !== null",
        "saved World Detail",
      );
      const sessionRows = await evaluate(
        "document.querySelectorAll('section[aria-labelledby=\"world-sessions-title\"] li.fact-row h3 button').length",
      );
      if (sessionRows === 0) {
        if (index === savedWorldCount - 1) {
          await capture("world-detail", viewport);
          throw new Error(
            `${activeLabel}: precondition failed: no saved-session rows exist in any saved world.`,
          );
        }
        await clickAt(
          'nav[aria-label="Jejak navigasi"] button',
          0,
          "World Detail Perpustakaan",
        );
        await waitFor(libraryReady, "library while locating a saved session");
        continue;
      }

      await capture("world-detail", viewport);
      activeLabel = `session ${viewport.width}x${viewport.height}`;
      const runMarkers = await evaluate(
        "Object.keys(sessionStorage).filter((key) => /^fworld:run:.*:(opening|turn|choices|item)$/.test(key))",
      );
      if (runMarkers.length > 0) {
        throw new Error(
          `${activeLabel}: precondition failed: sessionStorage contains pending run markers (${runMarkers.join(", ")}).`,
        );
      }
      await clickAt(
        'section[aria-labelledby="world-sessions-title"] li.fact-row h3 button',
        0,
        "existing saved-session row",
      );
      await waitFor(
        'document.querySelector(".session-view") !== null',
        "saved Session screen",
      );
      await capture("session", viewport);
      openedSession = true;
      break;
    }
    if (!openedSession) {
      throw new Error(
        `session ${viewport.width}x${viewport.height}: precondition failed: no saved-session row could be opened.`,
      );
    }
  }

  const issues = [
    ...failures,
    ...exceptions.map((exception) => `Runtime.exceptionThrown: ${exception}`),
  ];
  if (issues.length > 0) {
    console.error(
      `UI matrix failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `UI viewport check passed. Checked ${VIEWPORTS.length * SCREENSHOTS.length} screen/viewport samples; stored ${VIEWPORTS.length} blank-editor screenshots.`,
    );
  }
} finally {
  try {
    if (socket?.readyState === WebSocket.OPEN && send)
      await send("Browser.close");
  } catch {
    // The browser may close the CDP socket before replying to Browser.close.
  }
  socket?.close();
  if (edge && edge.exitCode === null && edge.signalCode === null) {
    edge.kill();
    await waitForExit(2000);
  }
  if (edge && edge.exitCode === null && edge.signalCode === null) {
    edge.kill("SIGKILL");
    await waitForExit(2000);
  }
  rmSync(profileDirectory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
