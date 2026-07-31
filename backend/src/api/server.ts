/**
 * The HTTP server: `node:http` plus the routing table, no framework.
 *
 * The backend has no runtime dependencies and this does not add one. What a
 * framework would provide here — routing, query parsing, JSON serialization —
 * is a few dozen lines against a fixed set of five read-only endpoints.
 *
 * One connection is opened read-only and shared by every request. `node:sqlite`
 * is synchronous, so requests are already serialized by the event loop; a pool
 * would add contention management for concurrency this process cannot have.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { closeDatabase, openDatabase } from '../store/db.js';
import type { Db } from '../store/db.js';
import { route } from './routes.js';

export interface ServerOptions {
  dbPath: string;
  port: number;
  /** Optional built frontend to serve, so one process runs the whole demo. */
  staticDir?: string;
  /** Allowed dev-server origin for CORS. Omitted in single-process mode. */
  devOrigin?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // The store is rebuilt by a separate ingest run, so a stale cached response
    // would show data the operator believes they replaced.
    'cache-control': 'no-store',
  });
  response.end(payload);
}

/**
 * Serves a file from the built frontend.
 *
 * Any path that is not a real file falls back to `index.html` so client-side
 * routes survive a page reload. Paths are resolved and checked to stay inside
 * `staticDir` — `GET /../../.data/fhir.db` must not be servable.
 */
function serveStatic(staticDir: string, urlPath: string, response: ServerResponse): void {
  const root = resolve(staticDir);
  const requested = resolve(root, `.${normalize(urlPath)}`);
  const inside = requested === root || requested.startsWith(root + sep);

  const candidate =
    inside && existsSync(requested) && statSync(requested).isFile()
      ? requested
      : join(root, 'index.html');

  if (!existsSync(candidate)) {
    sendJson(response, 404, { error: 'not-found', detail: urlPath });
    return;
  }

  response.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(candidate)] ?? 'application/octet-stream',
  });
  createReadStream(candidate).pipe(response);
}

/**
 * Handles one request.
 *
 * A thrown error becomes a 500 with the message rather than a hung socket. The
 * message is included because this is a local review tool run against a local
 * store, not an internet-facing service where it would leak internals.
 */
function handleRequest(
  db: Db,
  options: ServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (options.devOrigin) {
    response.setHeader('access-control-allow-origin', options.devOrigin);
    response.setHeader('vary', 'origin');
  }

  if (!url.pathname.startsWith('/api/')) {
    if (options.staticDir) {
      serveStatic(options.staticDir, url.pathname, response);
      return;
    }
    sendJson(response, 404, {
      error: 'not-found',
      detail: 'This process serves /api/* only; run the frontend dev server for the UI.',
    });
    return;
  }

  try {
    const result = route(db, request.method ?? 'GET', url.pathname, url.searchParams);
    sendJson(response, result.status, result.body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[api] ${request.method} ${url.pathname} failed:`, error);
    sendJson(response, 500, { error: 'internal-error', detail });
  }
}

/**
 * Folds a leftover WAL back into the main database file, if there is one.
 *
 * `openDatabase` refuses a read-only connection while a non-empty WAL exists,
 * because a read-only connection cannot write the `-shm` index and SQLite
 * therefore ignores the WAL entirely — serving rows that silently predate the
 * last write, with no error. That guard is right, but "go and checkpoint it
 * yourself" is a poor thing to tell someone whose only crime was killing an
 * ingest with ^C.
 *
 * Checkpointing needs a write connection, so this opens one briefly and closes
 * it before the server's read-only connection is created. It is lossless — the
 * WAL's contents are committed data either way — and idempotent.
 */
function checkpointIfNeeded(dbPath: string): void {
  if (!existsSync(`${dbPath}-wal`) || statSync(`${dbPath}-wal`).size === 0) return;

  console.log(`[api] folding ${statSync(`${dbPath}-wal`).size} bytes of WAL into ${dbPath}…`);
  // closeDatabase checkpoints, then closes — the only correct way to close a
  // writer, per store/db.ts.
  closeDatabase(openDatabase(dbPath));
}

/** Opens the store read-only and starts listening. Resolves once bound. */
export function startServer(options: ServerOptions): Promise<{ server: Server; db: Db }> {
  if (!existsSync(options.dbPath)) {
    // A clear message beats SQLITE_CANTOPEN: the fix is to run the ingest.
    throw new Error(
      `No store at ${options.dbPath}. Run \`pnpm exec tsx src/cli.ts ingest\` first.`,
    );
  }

  checkpointIfNeeded(options.dbPath);
  const db = openDatabase(options.dbPath, { readOnly: true });
  const server = createServer((request, response) =>
    handleRequest(db, options, request, response),
  );

  return new Promise((resolveStarted, rejectStarted) => {
    server.once('error', rejectStarted);
    server.listen(options.port, () => resolveStarted({ server, db }));
  });
}
