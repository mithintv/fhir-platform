/**
 * Second-level profiler for the `store` stage.
 *
 * The top-level profile showed `store` dominating the run, but "store" bundles
 * three different costs: serializing each record to JSON, writing the wide
 * `resource` row (whose largest column is that JSON blob), and writing the
 * the `observation_component` side table. This isolates them,
 * so the optimization targets the expensive one rather than the obvious one.
 *
 * Run with: pnpm exec tsx src/bench/store-profile.ts [sampleMB]
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { discoverBulkFiles, planChunks } from '../ingest/discover.js';
import type { Chunk } from '../ingest/discover.js';
import { readChunk } from '../ingest/reader.js';
import { DEFAULT_NORMALIZE_OPTIONS, normalizeResource } from '../normalize/index.js';
import type { NormalizedPatient, NormalizedResource } from '../model/types.js';
import { createTables, openDatabase } from '../store/db.js';
import { StoreWriter } from '../store/writer.js';
import { INSERT_RESOURCE, resourceParams } from '../store/statements.js';

const now = () => performance.now();
const ms = (value: number) => `${value.toFixed(0)}ms`;

/** Picks chunks round-robin across resource types so the sample isn't skewed. */
function sampleChunks(chunks: Chunk[], targetBytes: number): Chunk[] {
  const byType = new Map<string, Chunk[]>();
  for (const chunk of chunks) {
    const list = byType.get(chunk.resourceType);
    if (list) list.push(chunk);
    else byType.set(chunk.resourceType, [chunk]);
  }
  const picked: Chunk[] = [];
  let bytes = 0;
  let index = 0;
  let exhausted = false;
  while (!exhausted && bytes < targetBytes) {
    exhausted = true;
    for (const list of byType.values()) {
      const chunk = list[index];
      if (!chunk) continue;
      exhausted = false;
      picked.push(chunk);
      bytes += chunk.end - chunk.start;
      if (bytes >= targetBytes) break;
    }
    index += 1;
  }
  return picked;
}

/**
 * Normalizes a sample once, then writes it four ways — serialize only, the full
 * writer, the `resource` table alone, and the same table with the JSON blob
 * replaced by two bytes — and prints the differences between them.
 */
async function main(): Promise<void> {
  const sourceDir = resolve(import.meta.dirname, '../../../sample-bulk-fhir-datasets-1000-patients');
  const sampleBytes = Number(process.argv[2] ?? 150) * 1024 * 1024;

  const files = await discoverBulkFiles(sourceDir);
  const sample = sampleChunks(planChunks(files, 8 * 1024 * 1024), sampleBytes);

  // Normalize up front so the write timings below exclude parse and normalize.
  const resources: NormalizedResource[] = [];
  const patients: NormalizedPatient[] = [];
  for (const chunk of sample) {
    await readChunk(chunk, (buffer, start, end) => {
      try {
        const raw: unknown = JSON.parse(buffer.toString('utf8', start, end));
        const result = normalizeResource(raw, chunk.resourceType, DEFAULT_NORMALIZE_OPTIONS);
        if (result.kind === 'resource') resources.push(result.resource);
        else if (result.kind === 'patient') patients.push(result.patient);
      } catch {
        /* counted properly during real ingest */
      }
    });
  }
  console.log(`normalized ${resources.length.toLocaleString()} resources, ${patients.length} patients\n`);

  // 1. Serialization alone.
  let start = now();
  let jsonBytes = 0;
  for (const resource of resources) jsonBytes += JSON.stringify(resource).length;
  const stringifyMs = now() - start;

  // 2. The production writer: stringify + all three tables.
  const fullPath = join(tmpdir(), `store-profile-full-${process.pid}.db`);
  const fullDb = openDatabase(fullPath, { fresh: true });
  createTables(fullDb);
  const writer = new StoreWriter(fullDb, 25_000);
  start = now();
  for (const resource of resources) writer.addResource(resource);
  for (const patient of patients) writer.addPatient(patient);
  writer.flush();
  const fullMs = now() - start;
  const writerStats = { ...writer.stats };
  fullDb.close();

  // 3. `resource` table only, JSON pre-serialized (isolates side-table cost).
  const payloads = resources.map((resource) => JSON.stringify(resource));
  const mainPath = join(tmpdir(), `store-profile-main-${process.pid}.db`);
  const mainDb = openDatabase(mainPath, { fresh: true });
  createTables(mainDb);
  const insertMain = mainDb.prepare(INSERT_RESOURCE);
  start = now();
  mainDb.exec('BEGIN IMMEDIATE');
  resources.forEach((resource, index) => {
    insertMain.run(...resourceParams(resource, payloads[index] ?? '{}'));
  });
  mainDb.exec('COMMIT');
  const resourceOnlyMs = now() - start;
  mainDb.close();

  // 4. Identical, but with a 2-byte payload — isolates the blob's write cost.
  const slimPath = join(tmpdir(), `store-profile-slim-${process.pid}.db`);
  const slimDb = openDatabase(slimPath, { fresh: true });
  createTables(slimDb);
  const insertSlim = slimDb.prepare(INSERT_RESOURCE);
  start = now();
  slimDb.exec('BEGIN IMMEDIATE');
  for (const resource of resources) {
    insertSlim.run(...resourceParams(resource, '{}'));
  }
  slimDb.exec('COMMIT');
  const noBlobMs = now() - start;
  slimDb.close();

  for (const path of [fullPath, mainPath, slimPath]) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  }

  const avgBytes = jsonBytes / resources.length;
  console.log(
    `JSON payload: ${(jsonBytes / 1048576).toFixed(0)} MB total, ${avgBytes.toFixed(0)} B/resource`,
  );
  console.log(
    `rows: ${writerStats.resources.toLocaleString()} resource + ` +
      `${writerStats.resourceCodings.toLocaleString()} coding-link + ` +
      `${writerStats.components.toLocaleString()} component  ` +
      `(${writerStats.codingsInterned.toLocaleString()} distinct codings)\n`,
  );
  console.log(`  JSON.stringify only ............... ${ms(stringifyMs).padStart(8)}`);
  console.log(`  insert resource rows (with blob) .. ${ms(resourceOnlyMs).padStart(8)}`);
  console.log(`  insert resource rows (no blob) .... ${ms(noBlobMs).padStart(8)}`);
  console.log(`  full writer (3 tables) ............ ${ms(fullMs).padStart(8)}`);
  console.log(`\n  attributable to the JSON blob ..... ${ms(resourceOnlyMs - noBlobMs).padStart(8)}`);
  console.log(`  attributable to side tables ....... ${ms(fullMs - resourceOnlyMs - stringifyMs).padStart(8)}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
