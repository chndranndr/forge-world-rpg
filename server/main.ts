import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as createHttpServerNative,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type AiConfig,
  type GameDefinition,
  type GameSession,
  type Message,
} from "../shared/types.js";
import { exportTemplate } from "../shared/template.js";
import {
  ConflictError,
  CorruptDatabaseError,
  DatabaseError,
  GameDatabase,
  NotFoundError,
  ValidationError,
  type MigrationReceipt,
  type RunRecord,
} from "./db.js";
import { getSessionRun, startSessionRun } from "./turn.js";

const JSON_LIMIT = 2 * 1024 * 1024;
const TRANSFER_LIMIT = 32 * 1024 * 1024;
const CANONICAL_ORIGIN = "http://127.0.0.1:5173";
const ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

interface DatabaseRef {
  current: GameDatabase;
  path: string;
}

interface HttpOptions {
  development?: boolean;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  staticRoot?: string;
  backupDirectory?: string;
  envFilePath?: string;
}

export interface StartServerOptions {
  development?: boolean;
  port?: number;
  databasePath?: string;
  dataDirectory?: string;
  backupDirectory?: string;
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectBody(
  value: unknown,
  allowed: string[],
  required: string[] = [],
): Record<string, unknown> {
  if (!isObject(value))
    throw new ValidationError("Request body harus JSON object.");
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw new ValidationError(`Field request tidak dikenal: ${key}.`);
  }
  for (const key of required) {
    if (!(key in value)) throw new ValidationError(`Field ${key} wajib diisi.`);
  }
  return value;
}

function jsonResponse(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const output = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(output),
    "x-content-type-options": "nosniff",
  });
  response.end(output);
}

function publicRun(run: RunRecord) {
  const error = isObject(run.error) ? run.error : undefined;
  return {
    requestId: run.requestId,
    status:
      run.status === "committed"
        ? "succeeded"
        : run.status === "interrupted"
          ? "interrupted"
          : run.status,
    ...(run.result === undefined ? {} : { result: run.result }),
    ...(error
      ? {
          error: {
            code: typeof error.code === "string" ? error.code : "RUN_FAILED",
            message:
              typeof error.message === "string" ? error.message : "Run gagal.",
            retryable: false,
          },
        }
      : {}),
  };
}

function errorBody(error: unknown, requestId?: string) {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(requestId ? { requestId } : {}),
      },
    };
  }
  if (error instanceof ValidationError) {
    return {
      status: 400,
      body: {
        code: error.code,
        message: error.message,
        retryable: false,
        ...(requestId ? { requestId } : {}),
      },
    };
  }
  if (error instanceof NotFoundError) {
    return {
      status: 404,
      body: {
        code: error.code,
        message: error.message,
        retryable: false,
        ...(requestId ? { requestId } : {}),
      },
    };
  }
  if (error instanceof ConflictError) {
    return {
      status: 409,
      body: {
        code: error.code,
        message: error.message,
        retryable: false,
        ...(requestId ? { requestId } : {}),
      },
    };
  }
  if (error instanceof SyntaxError) {
    return {
      status: 400,
      body: {
        code: "INVALID_JSON",
        message: "Request body bukan JSON valid.",
        retryable: false,
        ...(requestId ? { requestId } : {}),
      },
    };
  }
  if (error instanceof DatabaseError) {
    return {
      status: error instanceof CorruptDatabaseError ? 500 : 400,
      body: {
        code: error.code,
        message:
          error instanceof CorruptDatabaseError
            ? "Database tidak dapat dibaca dengan aman."
            : error.message,
        retryable: false,
        ...(requestId ? { requestId } : {}),
      },
    };
  }
  return {
    status: 500,
    body: {
      code: "INTERNAL_ERROR",
      message: "Permintaan gagal diproses.",
      retryable: true,
      ...(requestId ? { requestId } : {}),
    },
  };
}

async function readJson(
  request: IncomingMessage,
  limit: number,
): Promise<unknown> {
  const length = Number(request.headers["content-length"]);
  if (Number.isFinite(length) && length > limit) {
    throw new HttpError(
      "Ukuran request melampaui batas.",
      413,
      "PAYLOAD_TOO_LARGE",
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) {
      throw new HttpError(
        "Ukuran request melampaui batas.",
        413,
        "PAYLOAD_TOO_LARGE",
      );
    }
    chunks.push(bytes);
  }
  if (!size) throw new ValidationError("Request body wajib diisi.");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requiredRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new ValidationError("expectedRevision harus integer positif.");
  }
  return Number(value);
}

function requiredString(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ValidationError(`${label} tidak valid.`);
  }
  return value;
}

function requiredId(value: string | undefined, label: string): string {
  if (!value || value.length > 256)
    throw new ValidationError(`${label} tidak valid.`);
  return value;
}

function providerKey(provider: AiConfig["provider"]): string | undefined {
  const settingsEnvironmentName =
    provider === "gemini"
      ? "FWORLD_GEMINI_API_KEY"
      : "FWORLD_OPENROUTER_API_KEY";
  const environmentName =
    provider === "gemini" ? "GEMINI_API_KEY" : "OPENROUTER_API_KEY";
  return (
    process.env[settingsEnvironmentName]?.trim() ||
    process.env[environmentName]?.trim() ||
    undefined
  );
}

function saveProviderKey(
  envFilePath: string,
  provider: AiConfig["provider"],
  apiKey: string,
): void {
  if (!/^[A-Za-z0-9._-]{1,512}$/.test(apiKey)) {
    throw new ValidationError("Format API key tidak valid.");
  }

  const environmentName =
    provider === "gemini"
      ? "FWORLD_GEMINI_API_KEY"
      : "FWORLD_OPENROUTER_API_KEY";
  let contents = "";
  try {
    contents = readFileSync(envFilePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new HttpError(
        "Credential tidak dapat dibaca dari konfigurasi server.",
        500,
        "CREDENTIAL_PERSISTENCE_FAILED",
      );
    }
  }

  const hasByteOrderMark = contents.startsWith("\uFEFF");
  if (hasByteOrderMark) contents = contents.slice(1);
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const hasTrailingNewline = /\r?\n$/.test(contents);
  const lines = contents ? contents.split(/\r?\n/) : [];
  if (hasTrailingNewline) lines.pop();
  const assignment = new RegExp(
    "^\\s*(?:export\\s+)?" + environmentName + "\\s*=",
  );
  let replaced = false;
  const updatedLines: string[] = [];
  for (const line of lines) {
    if (assignment.test(line)) {
      if (!replaced) updatedLines.push(environmentName + "=" + apiKey);
      replaced = true;
    } else {
      updatedLines.push(line);
    }
  }
  if (!replaced) updatedLines.push(environmentName + "=" + apiKey);
  let updated = updatedLines.join(newline);
  if (hasTrailingNewline && updated) updated += newline;
  if (hasByteOrderMark) updated = "\uFEFF" + updated;

  const temporaryPath = envFilePath + "." + randomUUID() + ".tmp";
  try {
    mkdirSync(dirname(envFilePath), { recursive: true });
    writeFileSync(temporaryPath, updated, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, envFilePath);
  } catch {
    rmSync(temporaryPath, { force: true });
    throw new HttpError(
      "Credential tidak dapat disimpan di konfigurasi server.",
      500,
      "CREDENTIAL_PERSISTENCE_FAILED",
    );
  }
  process.env[environmentName] = apiKey;
}

function providerModel(ai: AiConfig, key: string) {
  if (!key)
    throw new HttpError(
      "Credential provider belum dikonfigurasi di server.",
      503,
      "PROVIDER_NOT_CONFIGURED",
    );
  if (ai.provider === "gemini")
    return createGoogleGenerativeAI({ apiKey: key })(ai.model);
  if (ai.provider === "openrouter")
    return createOpenRouter({ apiKey: key })(ai.model);
  throw new ValidationError("Provider tidak dikenal.");
}

function allowedRequest(
  request: IncomingMessage,
  hosts: Set<string>,
  origins: Set<string>,
): void {
  const host = request.headers.host?.toLowerCase();
  if (!host || (!hosts.has("*") && !hosts.has(host))) {
    throw new HttpError(
      "Host request tidak diizinkan.",
      403,
      "HOST_NOT_ALLOWED",
    );
  }
  const origin = request.headers.origin;
  if (origin && !origins.has(origin)) {
    throw new HttpError(
      "Origin request tidak diizinkan.",
      403,
      "ORIGIN_NOT_ALLOWED",
    );
  }
  if (request.headers["sec-fetch-site"] === "cross-site") {
    throw new HttpError(
      "Request lintas situs ditolak.",
      403,
      "CROSS_SITE_REQUEST",
    );
  }
}

function publicMessages(messages: Message[]) {
  return messages;
}

function validateRequestId(value: unknown): string {
  return requiredString(value, "requestId");
}

function parseAi(value: unknown): AiConfig {
  const input = objectBody(value, ["provider", "model"], ["provider", "model"]);
  if (input.provider !== "gemini" && input.provider !== "openrouter") {
    throw new ValidationError("Provider harus gemini atau openrouter.");
  }
  return {
    provider: input.provider,
    model: requiredString(input.model, "model", 200),
  };
}

function stripVersion<T extends { revision: number }>(
  value: T,
): Omit<T, "revision"> {
  const { revision: _revision, ...result } = value;
  return result;
}

function versioned<T extends { revision: number }>(record: T) {
  return { value: stripVersion(record), revision: record.revision };
}

function backupFiles(directory: string) {
  mkdirSync(directory, { recursive: true });
  return readdirSync(directory)
    .filter((name) => /^fworld-[0-9a-f-]{36}\.sqlite$/i.test(name))
    .map((name) => {
      const path = join(directory, name);
      const stats = statSync(path);
      return {
        id: name.slice("fworld-".length, -".sqlite".length),
        createdAt: stats.mtime.toISOString(),
        size: stats.size,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function restoreDatabase(
  ref: DatabaseRef,
  backupDirectory: string,
  id: string,
): Promise<void> {
  if (!ID_PATTERN.test(id)) throw new ValidationError("ID backup tidak valid.");
  if (ref.current.hasRunningRuns()) {
    throw new ConflictError(
      "Backup tidak dapat dipulihkan selama run berjalan.",
    );
  }
  const backupPath = join(backupDirectory, `fworld-${id}.sqlite`);
  if (!statSync(backupPath, { throwIfNoEntry: false })?.isFile()) {
    throw new NotFoundError("Backup tidak ditemukan.");
  }
  const stagedPath = `${ref.path}.restore-${randomUUID()}`;
  const oldPath = `${ref.path}.previous-${randomUUID()}`;
  const staged = await GameDatabase.restoreFrom(backupPath, stagedPath);
  staged.close();
  ref.current.close();
  rmSync(`${ref.path}-wal`, { force: true });
  rmSync(`${ref.path}-shm`, { force: true });
  try {
    renameSync(ref.path, oldPath);
    renameSync(stagedPath, ref.path);
    ref.current = new GameDatabase(ref.path);
    rmSync(oldPath, { force: true });
  } catch (error) {
    rmSync(ref.path, { force: true });
    if (statSync(oldPath, { throwIfNoEntry: false })?.isFile())
      renameSync(oldPath, ref.path);
    ref.current = new GameDatabase(ref.path);
    throw error;
  } finally {
    rmSync(stagedPath, { force: true });
    rmSync(`${stagedPath}-wal`, { force: true });
    rmSync(`${stagedPath}-shm`, { force: true });
  }
}

async function legacyReadback(db: GameDatabase, receipt: MigrationReceipt) {
  const games: GameDefinition[] = [];
  const sessions: GameSession[] = [];
  const messages: Message[] = [];
  for (const id of receipt.ids.games) {
    const game = db.getGame(id);
    if (!game) throw new CorruptDatabaseError(`Read-back game hilang: ${id}.`);
    games.push(stripVersion(game));
  }
  for (const id of receipt.ids.sessions) {
    const session = db.getSession(id);
    if (!session)
      throw new CorruptDatabaseError(`Read-back session hilang: ${id}.`);
    sessions.push(stripVersion(session));
    messages.push(...db.getHistory(id));
  }
  messages.sort(
    (a, b) => a.sessionId.localeCompare(b.sessionId) || a.sequence - b.sequence,
  );
  return {
    format: "fworld-legacy-migration",
    version: 1,
    games,
    sessions,
    messages,
  };
}

export function createHttpServer(
  databaseRef: DatabaseRef,
  options: HttpOptions = {},
): Server {
  const hosts = new Set(
    options.allowedHosts ??
      (options.development
        ? ["127.0.0.1:5173", "127.0.0.1:3001"]
        : ["127.0.0.1:5173"]),
  );
  const origins = new Set(options.allowedOrigins ?? [CANONICAL_ORIGIN]);
  const backupDirectory = resolve(options.backupDirectory ?? "./backups");
  const envFilePath = resolve(options.envFilePath ?? ".env");
  const staticRoot = options.staticRoot
    ? resolve(options.staticRoot)
    : undefined;

  return createHttpServerNative((request, response) => {
    void (async () => {
      let requestId: string | undefined;
      try {
        allowedRequest(request, hosts, origins);
        const host = request.headers.host!;
        let url: URL;
        try {
          url = new URL(request.url ?? "/", `http://${host}`);
        } catch {
          throw new HttpError("URL request tidak valid.", 400, "INVALID_URL");
        }
        let pathname: string;
        try {
          pathname = decodeURIComponent(url.pathname);
        } catch {
          throw new HttpError("Path request tidak valid.", 400, "INVALID_PATH");
        }
        if (pathname.includes("\0") || pathname.includes("\\")) {
          throw new HttpError("Path request tidak valid.", 400, "INVALID_PATH");
        }
        const method = request.method ?? "GET";
        const db = databaseRef.current;
        if (pathname.startsWith("/api/")) {
          const write =
            method === "POST" || method === "PUT" || method === "DELETE";
          let body: unknown;
          if (write) {
            const contentType = request.headers["content-type"]
              ?.split(";")[0]
              .trim()
              .toLowerCase();
            if (contentType !== "application/json") {
              throw new HttpError(
                "Mutasi API harus memakai application/json.",
                415,
                "JSON_REQUIRED",
              );
            }
            const large =
              pathname === "/api/saves" ||
              pathname === "/api/migrations/legacy";
            body = await readJson(request, large ? TRANSFER_LIMIT : JSON_LIMIT);
            if (isObject(body) && typeof body.requestId === "string")
              requestId = body.requestId;
          } else if (method !== "GET" && method !== "HEAD") {
            throw new HttpError(
              "Method API tidak didukung.",
              405,
              "METHOD_NOT_ALLOWED",
            );
          }

          if (pathname === "/api/health" && method === "GET") {
            jsonResponse(response, 200, {
              status: "ok",
              schemaVersion: 1,
              nodeVersion: process.versions.node,
            });
            return;
          }
          if (pathname === "/api/games" && method === "GET") {
            jsonResponse(response, 200, db.listGames().map(versioned));
            return;
          }
          if (pathname === "/api/games" && method === "POST") {
            const input = objectBody(body, ["definition"], ["definition"]);
            jsonResponse(
              response,
              201,
              versioned(db.createGame(input.definition)),
            );
            return;
          }
          if (pathname === "/api/sessions/start" && method === "POST") {
            const input = objectBody(
              body,
              ["definition", "expectedGameRevision", "ai"],
              ["definition", "ai"],
            );
            jsonResponse(
              response,
              201,
              db.startSessionForDefinition({
                definition: input.definition,
                ...(input.expectedGameRevision === undefined
                  ? {}
                  : {
                      expectedGameRevision: requiredRevision(
                        input.expectedGameRevision,
                      ),
                    }),
                ai: parseAi(input.ai),
              }),
            );
            return;
          }
          if (pathname === "/api/saves" && method === "POST") {
            jsonResponse(response, 201, db.importSave(body));
            return;
          }
          const credentialMatch = pathname.match(
            /^\/api\/ai\/credentials\/(gemini|openrouter)$/,
          );
          if (credentialMatch && method === "PUT") {
            const input = objectBody(body, ["apiKey"], ["apiKey"]);
            const apiKey = requiredString(input.apiKey, "apiKey", 512).trim();
            const provider = credentialMatch[1] as AiConfig["provider"];
            saveProviderKey(envFilePath, provider, apiKey);
            jsonResponse(response, 200, { configured: true });
            return;
          }
          if (pathname === "/api/migrations/legacy" && method === "POST") {
            jsonResponse(response, 200, db.transferLegacyStores(body));
            return;
          }
          if (pathname === "/api/migrations/legacy" && method === "GET") {
            jsonResponse(response, 200, db.getLatestMigrationReceipt() ?? null);
            return;
          }
          if (pathname === "/api/ai/settings" && method === "GET") {
            jsonResponse(response, 200, {
              providers: {
                gemini: { configured: Boolean(providerKey("gemini")) },
                openrouter: { configured: Boolean(providerKey("openrouter")) },
              },
            });
            return;
          }
          if (pathname === "/api/ai/test" && method === "POST") {
            const ai = parseAi(body);
            const key = providerKey(ai.provider);
            if (!key)
              throw new HttpError(
                "Credential provider belum dikonfigurasi di server.",
                503,
                "PROVIDER_NOT_CONFIGURED",
              );
            const startedAt = performance.now();
            const record = db.startAiRequest({
              kind: "connection_test",
              attempt: 1,
              provider: ai.provider,
              model: ai.model,
            });
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 20_000);
            try {
              const result = await generateText({
                model: providerModel(ai, key),
                prompt: "Jawab dengan tepat satu kata: siap.",
                maxRetries: 0,
                maxOutputTokens: 8,
                abortSignal: controller.signal,
              });
              const usage = {
                inputTokens: result.usage.inputTokens ?? null,
                outputTokens: result.usage.outputTokens ?? null,
                totalTokens: result.usage.totalTokens ?? null,
              };
              db.finishAiRequest(record.id, {
                status: "succeeded",
                usage,
                latencyMs: Math.round(performance.now() - startedAt),
              });
              jsonResponse(response, 200, {
                message: `Berhasil. Jawaban model: ${result.text}`,
                usage,
              });
            } catch {
              db.finishAiRequest(record.id, {
                status: "unknown",
                latencyMs: Math.round(performance.now() - startedAt),
              });
              throw new HttpError(
                "Koneksi provider gagal. Periksa model, credential, dan koneksi server.",
                502,
                "AI_PROVIDER_ERROR",
                true,
              );
            } finally {
              clearTimeout(timeout);
            }
            return;
          }
          if (pathname === "/api/backups" && method === "GET") {
            jsonResponse(response, 200, backupFiles(backupDirectory));
            return;
          }
          if (pathname === "/api/backups" && method === "POST") {
            objectBody(body, []);
            mkdirSync(backupDirectory, { recursive: true });
            const id = randomUUID();
            const path = join(backupDirectory, `fworld-${id}.sqlite`);
            await db.backupTo(path);
            const stats = statSync(path);
            jsonResponse(response, 201, {
              id,
              createdAt: stats.mtime.toISOString(),
              size: stats.size,
            });
            return;
          }

          const gameMatch = pathname.match(
            /^\/api\/games\/([^/]+)(?:\/(sessions|template))?$/,
          );
          if (gameMatch) {
            const id = requiredId(gameMatch[1], "gameId");
            const sub = gameMatch[2];
            if (sub === "sessions" && method === "GET") {
              if (!db.getGame(id))
                throw new NotFoundError("Game tidak ditemukan.");
              jsonResponse(response, 200, db.listSessions(id).map(versioned));
              return;
            }
            if (sub === "template" && method === "GET") {
              const game = db.getGame(id);
              if (!game) throw new NotFoundError("Game tidak ditemukan.");
              jsonResponse(response, 200, exportTemplate(game));
              return;
            }
            if (!sub && method === "GET") {
              const game = db.getGame(id);
              if (!game) throw new NotFoundError("Game tidak ditemukan.");
              jsonResponse(response, 200, versioned(game));
              return;
            }
            if (!sub && method === "PUT") {
              const input = objectBody(
                body,
                ["expectedRevision", "definition"],
                ["expectedRevision", "definition"],
              );
              jsonResponse(
                response,
                200,
                versioned(
                  db.updateGame(
                    id,
                    input.definition,
                    requiredRevision(input.expectedRevision),
                  ),
                ),
              );
              return;
            }
            if (!sub && method === "DELETE") {
              const input = objectBody(
                body,
                ["expectedRevision"],
                ["expectedRevision"],
              );
              db.deleteGame(id, requiredRevision(input.expectedRevision));
              response.writeHead(204);
              response.end();
              return;
            }
          }

          const migrationMatch = pathname.match(
            /^\/api\/migrations\/legacy\/([a-f0-9]{64})\/readback$/,
          );
          if (migrationMatch && method === "GET") {
            const fingerprint = migrationMatch[1];
            const receipt = db.getMigrationReceipt(fingerprint);
            if (!receipt)
              throw new NotFoundError("Receipt migrasi tidak ditemukan.");
            jsonResponse(response, 200, await legacyReadback(db, receipt));
            return;
          }

          const backupRestoreMatch = pathname.match(
            /^\/api\/backups\/([^/]+)\/restore$/,
          );
          if (backupRestoreMatch && method === "POST") {
            objectBody(body, []);
            await restoreDatabase(
              databaseRef,
              backupDirectory,
              backupRestoreMatch[1],
            );
            response.writeHead(204);
            response.end();
            return;
          }

          const sessionMatch = pathname.match(
            /^\/api\/sessions\/([^/]+)(?:\/(.+))?$/,
          );
          if (sessionMatch) {
            const id = requiredId(sessionMatch[1], "sessionId");
            const action = sessionMatch[2];
            if (!action && method === "GET") {
              const session = db.getSession(id);
              if (!session) throw new NotFoundError("Session tidak ditemukan.");
              jsonResponse(response, 200, versioned(session));
              return;
            }
            if (action === "messages" && method === "GET") {
              const limitRaw = url.searchParams.get("limit");
              const limit = limitRaw === null ? undefined : Number(limitRaw);
              const beforeRaw = url.searchParams.get("beforeSequence");
              const before = beforeRaw === null ? undefined : Number(beforeRaw);
              const page =
                before === undefined
                  ? db.listMessagesBefore(id, Number.MAX_SAFE_INTEGER, limit)
                  : db.listMessagesBefore(id, before, limit);
              jsonResponse(response, 200, {
                messages: publicMessages(page.messages),
                nextBeforeSequence: page.hasMore
                  ? page.nextBeforeSequence
                  : null,
              });
              return;
            }
            if (action === "ai" && method === "PUT") {
              const input = objectBody(
                body,
                ["expectedRevision", "ai"],
                ["expectedRevision", "ai"],
              );
              const updated = db.updateSession(
                id,
                { ai: parseAi(input.ai) },
                requiredRevision(input.expectedRevision),
              );
              jsonResponse(response, 200, versioned(updated));
              return;
            }
            if (action === "save" && method === "GET") {
              jsonResponse(response, 200, db.exportSave(id));
              return;
            }
            if (action === "usage" && method === "GET") {
              const requestId = url.searchParams.get("requestId") ?? undefined;
              jsonResponse(response, 200, db.getUsageSummary(id, requestId));
              return;
            }
            const runMatch = action?.match(/^runs\/([^/]+)$/);
            if (runMatch && method === "GET") {
              const run = getSessionRun(
                db,
                id,
                requiredId(runMatch[1], "requestId"),
              );
              if (!run) throw new NotFoundError("Run tidak ditemukan.");
              jsonResponse(response, 200, publicRun(run));
              return;
            }
            if (action === "opening" && method === "POST") {
              const input = objectBody(
                body,
                ["requestId", "expectedRevision"],
                ["requestId", "expectedRevision"],
              );
              jsonResponse(
                response,
                202,
                publicRun(
                  startSessionRun(db, {
                    sessionId: id,
                    requestId: validateRequestId(input.requestId),
                    expectedRevision: requiredRevision(input.expectedRevision),
                    work: { kind: "opening" },
                    providerKey: providerKey(
                      db.getSession(id)?.ai.provider ?? "gemini",
                    ),
                  }),
                ),
              );
              return;
            }
            if (action === "turns" && method === "POST") {
              const input = objectBody(
                body,
                ["requestId", "expectedRevision", "input"],
                ["requestId", "expectedRevision", "input"],
              );
              const text = requiredString(input.input, "input", 8000);
              const session = db.getSession(id);
              if (!session) throw new NotFoundError("Session tidak ditemukan.");
              jsonResponse(
                response,
                202,
                publicRun(
                  startSessionRun(db, {
                    sessionId: id,
                    requestId: validateRequestId(input.requestId),
                    expectedRevision: requiredRevision(input.expectedRevision),
                    work: { kind: "turn", input: text },
                    providerKey: providerKey(session.ai.provider),
                  }),
                ),
              );
              return;
            }
            if (action === "choices" && method === "POST") {
              const input = objectBody(
                body,
                ["requestId", "expectedRevision"],
                ["requestId", "expectedRevision"],
              );
              const session = db.getSession(id);
              if (!session) throw new NotFoundError("Session tidak ditemukan.");
              jsonResponse(
                response,
                202,
                publicRun(
                  startSessionRun(db, {
                    sessionId: id,
                    requestId: validateRequestId(input.requestId),
                    expectedRevision: requiredRevision(input.expectedRevision),
                    work: { kind: "choices" },
                    providerKey: providerKey(session.ai.provider),
                  }),
                ),
              );
              return;
            }
            const itemMatch = action?.match(/^items\/([^/]+)\/use$/);
            if (itemMatch && method === "POST") {
              const input = objectBody(
                body,
                ["requestId", "expectedRevision"],
                ["requestId", "expectedRevision"],
              );
              jsonResponse(
                response,
                202,
                publicRun(
                  startSessionRun(db, {
                    sessionId: id,
                    requestId: validateRequestId(input.requestId),
                    expectedRevision: requiredRevision(input.expectedRevision),
                    work: {
                      kind: "item_use",
                      itemId: requiredId(itemMatch[1], "itemId"),
                    },
                  }),
                ),
              );
              return;
            }
          }

          throw new HttpError(
            "Endpoint tidak ditemukan.",
            404,
            "ROUTE_NOT_FOUND",
          );
        }

        if (method !== "GET" && method !== "HEAD") {
          throw new HttpError(
            "Method tidak didukung.",
            405,
            "METHOD_NOT_ALLOWED",
          );
        }
        if (options.development || !staticRoot) {
          throw new HttpError("File tidak ditemukan.", 404, "NOT_FOUND");
        }
        const requested = pathname === "/" ? "/index.html" : pathname;
        const root = resolve(staticRoot);
        const candidate = resolve(root, `.${requested}`);
        const rel = relative(root, candidate);
        if (
          rel === ".." ||
          rel.startsWith(`..${sep}`) ||
          resolve(candidate) === root
        ) {
          throw new HttpError("Path file tidak valid.", 404, "NOT_FOUND");
        }
        let filePath = candidate;
        if (!statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
          if (request.headers.accept?.includes("text/html"))
            filePath = join(root, "index.html");
          else throw new HttpError("File tidak ditemukan.", 404, "NOT_FOUND");
        }
        const realRoot = realpathSync(root);
        const realFile = realpathSync(filePath);
        if (
          realFile !== realRoot &&
          !realFile.startsWith(`${realRoot}${sep}`)
        ) {
          throw new HttpError("Path file tidak valid.", 404, "NOT_FOUND");
        }
        const content = readFileSync(realFile);
        response.writeHead(200, {
          "cache-control": filePath.endsWith("index.html")
            ? "no-cache"
            : "public, max-age=3600",
          "content-length": content.byteLength,
          "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
          "x-content-type-options": "nosniff",
        });
        response.end(method === "HEAD" ? undefined : content);
      } catch (error) {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        const mapped = errorBody(error, requestId);
        jsonResponse(response, mapped.status, mapped.body);
      }
    })();
  });
}

export function startServer(options: StartServerOptions = {}): Promise<Server> {
  const development = options.development ?? false;
  const dataDirectory = resolve(
    options.dataDirectory ?? process.env.FWORLD_DATA_DIR ?? "./data",
  );
  const backupDirectory = resolve(
    options.backupDirectory ?? process.env.FWORLD_BACKUP_DIR ?? "./backups",
  );
  mkdirSync(dataDirectory, { recursive: true });
  mkdirSync(backupDirectory, { recursive: true });
  const databasePath = resolve(
    options.databasePath ?? join(dataDirectory, "fworld.sqlite"),
  );
  const ref: DatabaseRef = {
    current: new GameDatabase(databasePath),
    path: databasePath,
  };
  const port = options.port ?? (development ? 3001 : 5173);
  const server = createHttpServer(ref, {
    development,
    backupDirectory,
    staticRoot: development ? undefined : resolve("dist/client"),
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.on("close", () => ref.current.close());
  return new Promise((resolvePromise, reject) => {
    server.once("error", (error) => {
      ref.current.close();
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      server.removeAllListeners("error");
      resolvePromise(server);
    });
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  await startServer();
}

export type { DatabaseRef, HttpOptions };
