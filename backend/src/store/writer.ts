/**
 * Batched writer for normalized records.
 *
 * Rows are buffered and flushed inside a single transaction. Batching is the
 * difference between ~1k inserts/sec (autocommit, one fsync per row) and
 * ~1.8M/sec — but it is table stakes, not the optimization this exercise is
 * about; see docs/PART_A.md §3.
 */
import type {
  NormalizedCoding,
  NormalizedObservation,
  NormalizedPatient,
  NormalizedResource,
} from '../model/types.js';
import { bind } from './db.js';
import type { Db } from './db.js';
import {
  INSERT_CODING,
  INSERT_COMPONENT,
  INSERT_PATIENT,
  INSERT_RESOURCE,
  INSERT_RESOURCE_CODING,
  SELECT_CODING,
  numericValue,
  patientParams,
  resourceParams,
} from './statements.js';

/** Row counts produced by one writer instance (one thread's share of a run). */
export interface WriterStats {
  patients: number;
  resources: number;
  /** Rows written to the resource_coding association. */
  resourceCodings: number;
  /** Distinct codings this writer added to the dictionary. */
  codingsInterned: number;
  components: number;
  batches: number;
}

/**
 * Buffers normalized records and commits them in fixed-size transactions.
 *
 * One instance owns one SQLite connection and is not safe to share across
 * threads; each ingest worker constructs its own.
 */
export class StoreWriter {
  private readonly insertPatient;
  private readonly insertResource;
  private readonly insertResourceCoding;
  private readonly insertCoding;
  private readonly selectCoding;
  private readonly insertComponent;

  /**
   * system|code -> coding.id, so the dictionary is hit once per distinct coding
   * rather than once per resource. The export has ~950 distinct codings, so this
   * map stays tiny and after warm-up nearly every lookup is a cache hit.
   */
  private readonly codingIds = new Map<string, number>();

  private pendingPatients: NormalizedPatient[] = [];
  private pendingResources: NormalizedResource[] = [];
  private pendingRows = 0;

  readonly stats: WriterStats = {
    patients: 0,
    resources: 0,
    resourceCodings: 0,
    codingsInterned: 0,
    components: 0,
    batches: 0,
  };

  constructor(
    private readonly db: Db,
    /** Rows buffered before a transaction is committed. */
    private readonly batchSize = 25_000,
  ) {
    this.insertPatient = db.prepare(INSERT_PATIENT);
    this.insertResource = db.prepare(INSERT_RESOURCE);
    this.insertResourceCoding = db.prepare(INSERT_RESOURCE_CODING);
    this.insertCoding = db.prepare(INSERT_CODING);
    this.selectCoding = db.prepare(SELECT_CODING);
    this.insertComponent = db.prepare(INSERT_COMPONENT);
  }

  /** Queues a patient, flushing automatically once the batch is full. */
  addPatient(patient: NormalizedPatient): void {
    this.pendingPatients.push(patient);
    this.pendingRows += 1;
    if (this.pendingRows >= this.batchSize) this.flush();
  }

  /** Queues a non-Patient resource, flushing automatically when the batch is full. */
  addResource(resource: NormalizedResource): void {
    this.pendingResources.push(resource);
    this.pendingRows += 1;
    if (this.pendingRows >= this.batchSize) this.flush();
  }

  /**
   * Commits everything buffered so far in one transaction. Callers must invoke
   * this once at the end of a run to persist the final partial batch.
   *
   * A failure rolls the whole batch back and rethrows: a half-written batch
   * would leave counts that no longer reconcile against the source.
   */
  flush(): void {
    if (this.pendingRows === 0) return;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const patient of this.pendingPatients) this.writePatient(patient);
      for (const resource of this.pendingResources) this.writeResource(resource);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    this.stats.patients += this.pendingPatients.length;
    this.stats.resources += this.pendingResources.length;
    this.stats.batches += 1;
    this.pendingPatients = [];
    this.pendingResources = [];
    this.pendingRows = 0;
  }

  /**
   * Writes one patient row. `INSERT OR REPLACE` means a repeated id collapses
   * to a single row; `verifyStore` reports the collapse count as intentional
   * de-duplication rather than loss.
   */
  private writePatient(patient: NormalizedPatient): void {
    this.insertPatient.run(...patientParams(patient));
  }

  /**
   * Resolves a coding to its dictionary id, inserting it on first sight.
   *
   * Safe across concurrent workers: `INSERT OR IGNORE` against the UNIQUE
   * (system, code) index means a race resolves to the same row, and the
   * following SELECT returns whichever id won.
   */
  private codingId(coding: NormalizedCoding): number | undefined {
    const system = coding.system ?? '';
    const code = coding.code ?? '';
    if (system === '' && code === '') return undefined;

    const key = `${system}|${code}`;
    const cached = this.codingIds.get(key);
    if (cached !== undefined) return cached;

    this.insertCoding.run(system, code, bind(coding.display));
    const row = this.selectCoding.get(system, code) as { id: number } | undefined;
    if (!row) return undefined;

    this.codingIds.set(key, row.id);
    this.stats.codingsInterned += 1;
    return row.id;
  }

  /**
   * Writes the `resource` row, its coding associations, and — for Observations
   * — one `observation_component` row per panel member.
   */
  private writeResource(resource: NormalizedResource): void {
    this.insertResource.run(...resourceParams(resource, JSON.stringify(resource)));

    // One association row per coding. A CodeableConcept is one-to-many over
    // Codings — 10% of this export carries two (a DocumentReference typed as
    // both "History and physical note" and "Evaluation + Plan note", say) — so
    // a single code column on the resource cannot represent it.
    const codings = resource.code?.codings ?? [];
    for (let ordinal = 0; ordinal < codings.length; ordinal += 1) {
      const id = this.codingId(codings[ordinal]!);
      if (id === undefined) continue;
      this.insertResourceCoding.run(resource.resourceType, resource.id, id, ordinal);
      this.stats.resourceCodings += 1;
    }

    if (resource.resourceType !== 'Observation') return;
    for (const component of (resource as NormalizedObservation).components ?? []) {
      const componentCoding = component.code?.codings[0];
      this.insertComponent.run(
        resource.id,
        bind(resource.patientId),
        bind(componentCoding ? this.codingId(componentCoding) : undefined),
        bind(numericValue(component.value)),
        bind(component.value?.kind === 'quantity' ? component.value.unit : undefined),
      );
      this.stats.components += 1;
    }
  }

}
