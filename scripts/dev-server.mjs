import { createServer } from "vite";

const vite = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
});

let backend;
try {
  const entry = await vite.ssrLoadModule("/server/main.ts");
  backend = await entry.startServer({ development: true });
} catch (error) {
  await vite.close();
  throw error;
}

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  process.exitCode = signal === "SIGINT" ? 130 : 0;
  await new Promise((resolve) => backend.close(resolve));
  await vite.close();
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
