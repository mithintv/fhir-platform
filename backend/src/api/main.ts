#!/usr/bin/env node
/**
 * Entry point for the read-only review API.
 *
 * Separate from `cli.ts` because it is a different kind of program: the CLI
 * runs a batch job and exits, this one binds a port and stays up. Sharing an
 * argument parser between them buys nothing and couples a long-running server
 * to the ingest's flag set.
 *
 *   pnpm --filter @autonomy/backend serve [--port 4000] [--db PATH] [--static DIR]
 */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { startServer } from './server.js';

const DEFAULT_DB = resolve(import.meta.dirname, '../../../.data/fhir.db');
const DEFAULT_PORT = 4000;

/** Vite's dev server origin, allowed for CORS when it talks to us directly. */
const DEFAULT_DEV_ORIGIN = 'http://localhost:5173';

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    db: { type: 'string' },
    static: { type: 'string' },
    'dev-origin': { type: 'string' },
  },
  allowPositionals: false,
});

const dbPath = values.db ?? DEFAULT_DB;
const port = Number(values.port ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid --port: ${values.port}`);
  process.exit(1);
}

const staticDir = values.static;

/**
 * Turns a startup failure into one actionable line.
 *
 * The two ways this realistically fails — the port is taken, or there is no
 * store yet — both have a specific fix, and a 12-frame async stack trace buries
 * it. Anything else is unexpected and keeps its stack.
 */
function reportStartupFailure(error: unknown): never {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;

  if (code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use — most likely an earlier API process.`);
    console.error(`  lsof -ti tcp:${port} | xargs kill     # stop it`);
    console.error(`  pnpm run api --port ${port + 1}       # or use another port`);
    process.exit(1);
  }

  if (code === 'EACCES') {
    console.error(`Not permitted to bind port ${port}. Ports below 1024 need elevated privileges.`);
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
}

// try/catch rather than `.catch()`: the missing-store check throws
// synchronously, before there is a promise to attach a handler to.
let server;
try {
  ({ server } = await startServer({
    dbPath,
    port,
    staticDir,
    devOrigin: values['dev-origin'] ?? DEFAULT_DEV_ORIGIN,
  }));
} catch (error) {
  reportStartupFailure(error);
}

console.log(`API    http://localhost:${port}/api`);
console.log(`store  ${dbPath}`);
console.log(
  staticDir
    ? `UI     http://localhost:${port}  (serving ${staticDir})`
    : `UI     run \`pnpm --filter @autonomy/frontend dev\``,
);

// Close the listener on signal so a restart does not hit EADDRINUSE.
const stop = (): void => {
  server.close(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
