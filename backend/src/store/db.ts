/**
 * SQLite connection helpers.
 *
 * Uses `node:sqlite` (built into Node 22.5+), so the store needs no native
 * dependency and no build step.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { CREATE_INDEXES, CREATE_TABLES, PRAGMAS_READ, PRAGMAS_WRITE } from './schema.js';
import { UPSERT_META } from './statements.js';

export type Db = DatabaseSync;

/** A value SQLite can bind. `undefined` is not bindable, so it becomes null. */
export type Bindable = string | number | bigint | null | Uint8Array;

/** Maps an optional value onto a bindable one. */
export function bind(value: string | number | undefined | null): Bindable {
  return value === undefined || value === null ? null : value;
}

/** Maps an optional boolean onto SQLite's 0/1 integer convention. */
export function bindBool(value: boolean | undefined): Bindable {
  return value === undefined ? null : value ? 1 : 0;
}

/** Serializes a list of issue codes into a single column. */
export function bindIssues(issues: readonly string[] | undefined): Bindable {
  return issues && issues.length > 0 ? issues.join(',') : null;
}

export interface OpenOptions {
  /** Delete any existing database first. */
  fresh?: boolean;
  /** Open read-only (for API consumers). */
  readOnly?: boolean;
}

/**
 * Opens (and, if needed, creates) the store, applying the pragmas for the
 * access mode. Parent directories are created so a first run works from a
 * clean checkout.
 */
export function openDatabase(path: string, options: OpenOptions = {}): Db {
  if (options.fresh) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  }
  mkdirSync(dirname(path), { recursive: true });

  // `DatabaseSync` rejects an explicit `undefined` second argument, so the
  // options object is only passed when there is something to say.
  const db = options.readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
  for (const pragma of options.readOnly ? PRAGMAS_READ : PRAGMAS_WRITE) db.exec(pragma);
  return db;
}

/** Creates tables if absent. Indexes are added separately, after bulk load. */
export function createTables(db: Db): void {
  db.exec(CREATE_TABLES);
}

/**
 * Builds the query indexes.
 *
 * Deliberately deferred until after the load: SQLite maintains every index on
 * every insert, so building them up front makes the bulk load meaningfully
 * slower than sorting the finished tables once.
 */
export function createIndexes(db: Db): void {
  db.exec(CREATE_INDEXES);
}

/** Stores a JSON-serializable run fact in `ingest_meta`, replacing any prior value. */
export function recordMeta(db: Db, key: string, value: unknown): void {
  db.prepare(UPSERT_META).run(key, JSON.stringify(value));
}

/**
 * Reads a value written by {@link recordMeta}. Missing keys and unparseable
 * values both yield `undefined` — a store written by an older build should not
 * crash a reader.
 */
export function readMeta<T>(db: Db, key: string): T | undefined {
  const row = db.prepare('SELECT value FROM ingest_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return undefined;
  }
}
