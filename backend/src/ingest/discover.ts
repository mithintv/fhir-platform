/**
 * Discovers the NDJSON files in a FHIR bulk-export directory and splits them
 * into work chunks.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface BulkFile {
  path: string;
  fileName: string;
  /** Resource type inferred from the bulk-export filename convention. */
  resourceType: string;
  sizeBytes: number;
}

/** A byte range of one file, sized so work can be balanced across workers. */
export interface Chunk {
  id: number;
  path: string;
  resourceType: string;
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset; the reader finishes whatever line straddles it. */
  end: number;
}

/** Bulk exports name files `<ResourceType>.<sequence>.ndjson`. */
const BULK_FILE_NAME = /^([A-Z][A-Za-z]*)\.(\d+)?\.?ndjson$/;

/** Not patient data — the export manifest/log. */
const IGNORED_FILES = new Set(['log.ndjson']);

/**
 * Lists the NDJSON files in an export directory, largest first.
 *
 * Anything that does not match the bulk-export naming convention is ignored, so
 * a stray file in the directory cannot be mistaken for patient data.
 */
export async function discoverBulkFiles(directory: string): Promise<BulkFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: BulkFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (IGNORED_FILES.has(entry.name)) continue;
    const match = BULK_FILE_NAME.exec(entry.name);
    if (!match?.[1]) continue;

    const filePath = join(directory, entry.name);
    const { size } = await stat(filePath);
    if (size === 0) continue;

    files.push({ path: filePath, fileName: entry.name, resourceType: match[1], sizeBytes: size });
  }

  // Largest first: with a dynamic work queue this keeps the tail short, because
  // the big chunks start early and the small ones fill in the gaps at the end.
  files.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return files;
}

/**
 * Splits files into byte-range chunks.
 *
 * Chunking within a file (rather than one task per file) matters here: the
 * export contains 51 MB shards but also a 700 MB-class type spread unevenly, and
 * file-level tasks would leave workers idle waiting on the longest single file.
 */
export function planChunks(files: readonly BulkFile[], targetChunkBytes: number): Chunk[] {
  const chunks: Chunk[] = [];
  let id = 0;

  for (const file of files) {
    if (targetChunkBytes <= 0 || file.sizeBytes <= targetChunkBytes) {
      chunks.push({ id: id++, path: file.path, resourceType: file.resourceType, start: 0, end: file.sizeBytes });
      continue;
    }
    for (let start = 0; start < file.sizeBytes; start += targetChunkBytes) {
      const end = Math.min(start + targetChunkBytes, file.sizeBytes);
      chunks.push({ id: id++, path: file.path, resourceType: file.resourceType, start, end });
    }
  }

  return chunks;
}
