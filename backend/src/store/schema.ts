/**
 * SQLite schema for the normalized patient store.
 *
 * Design notes:
 * - `resource` holds the shared envelope as columns (for indexed filtering) plus
 *   the full normalized record as JSON (so nothing is lost to the projection).
 *   Queries filter on columns and hydrate from the JSON.
 * - Codings are modelled properly: a FHIR CodeableConcept is one-to-many over
 *   Codings, so `coding` is a dictionary of distinct (system, code) pairs and
 *   `resource_coding` is the association between a resource and them. The whole
 *   1.6M-resource export references only ~950 distinct codings, so repeating the
 *   system URL and display string on every row — as a flat side table does —
 *   stores the same few hundred strings a million times over.
 * - `observation_component` exists because blood pressure stores its values in
 *   `component[]`, not `valueQuantity` — without this table, a BP reading has no
 *   queryable number at all. Its codes reference the same dictionary.
 * - Indexes are deliberately NOT created here. They are added after the bulk
 *   load (see `createIndexes`), because maintaining a b-tree per row during a
 *   1.4M-row insert is far slower than sorting once at the end.
 */

/** Applied before any write. WAL lets readers run during the load. */
export const PRAGMAS_WRITE = [
  'PRAGMA journal_mode = WAL',
  // NORMAL is durable across process crashes (only a power loss can lose the
  // tail of a transaction). For a re-runnable ingest that is the right trade.
  'PRAGMA synchronous = NORMAL',
  'PRAGMA temp_store = MEMORY',
  'PRAGMA cache_size = -64000', // 64 MB page cache
  'PRAGMA busy_timeout = 30000', // wait out another worker's commit
] as const;

/** Applied by read-only consumers (the API in later parts). */
export const PRAGMAS_READ = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA cache_size = -32000',
  'PRAGMA busy_timeout = 5000',
] as const;

export const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS patient (
  id             TEXT PRIMARY KEY,
  name_text      TEXT,
  family         TEXT,
  given          TEXT,
  gender         TEXT,
  birth_date     TEXT,
  birth_sort     INTEGER,
  deceased       INTEGER,
  deceased_date  TEXT,
  birth_sex      TEXT,
  race           TEXT,
  ethnicity      TEXT,
  marital_status TEXT,
  city           TEXT,
  state          TEXT,
  postal_code    TEXT,
  issues         TEXT,
  json           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resource (
  id              TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  patient_id      TEXT,
  encounter_id    TEXT,
  status          TEXT,
  /** CodeableConcept.text — the human label, not a coding. */
  code_text       TEXT,
  effective_value TEXT,
  effective_sort  INTEGER,
  value_num       REAL,
  value_unit      TEXT,
  value_text      TEXT,
  issues          TEXT,
  json            TEXT NOT NULL
);

/**
 * Dictionary of distinct codings. ~950 rows for the whole export.
 *
 * \`system\` and \`code\` are stored as '' rather than NULL when absent: SQLite
 * treats NULLs as distinct in a UNIQUE index, so a nullable key would let the
 * same partial coding be inserted repeatedly.
 */
CREATE TABLE IF NOT EXISTS coding (
  id      INTEGER PRIMARY KEY,
  system  TEXT NOT NULL,
  code    TEXT NOT NULL,
  display TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS coding_key ON coding (system, code);

/**
 * Association between a resource and the codings of its \`code\` element.
 *
 * \`ordinal\` is the position within CodeableConcept.coding[]; 0 is the primary
 * coding. Keeping it means the original order is recoverable, and lets a query
 * ask for "the primary code" without consulting the JSON.
 */
CREATE TABLE IF NOT EXISTS resource_coding (
  resource_type TEXT    NOT NULL,
  resource_id   TEXT    NOT NULL,
  coding_id     INTEGER NOT NULL,
  ordinal       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS observation_component (
  observation_id TEXT NOT NULL,
  patient_id     TEXT,
  coding_id      INTEGER,
  value_num      REAL,
  value_unit     TEXT
);

/** Run metadata and data-quality counters, as JSON values keyed by name. */
CREATE TABLE IF NOT EXISTS ingest_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * The pre-optimization coding table, kept so `bench` can measure the change
 * rather than assert it. One row per coding, repeating the system URL and
 * display string on every row.
 */
export const CREATE_TABLES_LEGACY_CODING = `
CREATE TABLE IF NOT EXISTS resource_coding_flat (
  resource_id   TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  patient_id    TEXT,
  system        TEXT,
  code          TEXT,
  display       TEXT
);
`;

export const CREATE_INDEXES_LEGACY_CODING = `
CREATE INDEX IF NOT EXISTS resource_coding_flat_lookup
  ON resource_coding_flat (system, code);
CREATE INDEX IF NOT EXISTS resource_coding_flat_patient
  ON resource_coding_flat (patient_id, code);
`;

/** Index set for the current dictionary + association coding model. */
export const CREATE_INDEXES_CODING = `
CREATE INDEX IF NOT EXISTS resource_coding_by_coding
  ON resource_coding (coding_id, resource_type, resource_id);
CREATE INDEX IF NOT EXISTS resource_coding_by_resource
  ON resource_coding (resource_type, resource_id, ordinal);
`;

/**
 * Created after the bulk load.
 *
 * The index set is driven by the queries the later parts actually run:
 *  - patient timeline:    resource(patient_id, effective_sort)
 *  - clinical snapshot:   resource(patient_id, resource_type, effective_sort)
 *  - AI grounding lookup: resource(resource_type, id)
 *  - code -> resources:   resource_coding(coding_id, ...)   [cohort scans]
 *  - resource -> codes:   resource_coding(resource_type, resource_id, ordinal)
 *  - blood pressure:      observation_component(coding_id)
 *
 * `coding_key` is created with the table rather than here: the dictionary is
 * looked up on every insert during the load, so it needs its index up front.
 */
export const CREATE_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS resource_pk
  ON resource (resource_type, id);
CREATE INDEX IF NOT EXISTS resource_patient_time
  ON resource (patient_id, effective_sort);
CREATE INDEX IF NOT EXISTS resource_patient_type_time
  ON resource (patient_id, resource_type, effective_sort);
CREATE INDEX IF NOT EXISTS observation_component_coding
  ON observation_component (coding_id, patient_id);
CREATE INDEX IF NOT EXISTS patient_name
  ON patient (name_text);
`;
