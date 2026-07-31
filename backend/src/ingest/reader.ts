/**
 * Streaming NDJSON reader for a byte range of a file.
 *
 * Boundary rule: a chunk owns every line whose *first byte* falls inside
 * `[start, end)`. So a chunk that does not start at byte 0 discards the partial
 * line it opens on (the previous chunk owns it), and reads past `end` to finish
 * the line it opened last. Every line is therefore processed exactly once, with
 * no coordination between workers.
 *
 * Lines are split on the 0x0A byte before any UTF-8 decoding. A newline byte
 * cannot appear inside a multi-byte UTF-8 sequence, so splitting first is safe
 * and avoids decoding the whole chunk into one giant string.
 */
import { createReadStream } from 'node:fs';
import type { Chunk } from './discover.js';

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

export interface ChunkReadResult {
  /** Bytes belonging to lines this chunk owned. */
  bytesRead: number;
  /** Non-empty lines handed to the callback. */
  linesRead: number;
}

export interface ReadChunkOptions {
  /** Read buffer size. Larger buffers mean fewer syscalls on large files. */
  highWaterMark?: number;
}

/**
 * Reads the lines owned by `chunk`, invoking `onLine` for each.
 *
 * `onLine` receives the raw buffer plus offsets rather than a string, so
 * callers that can reject a line cheaply (by scanning bytes) may do so before
 * paying for UTF-8 decoding.
 */
export async function readChunk(
  chunk: Chunk,
  onLine: (buffer: Buffer, start: number, end: number) => void,
  options: ReadChunkOptions = {},
): Promise<ChunkReadResult> {
  // Read one byte earlier than `start` on every chunk but the first. That byte
  // answers "is `start` already a line start?" without a second read: if it is
  // a newline, the discard below consumes only the newline and the line at
  // `start` is kept; if it is not, the discard correctly drops the partial line
  // the previous chunk owns. Reading from `start` alone cannot distinguish the
  // two, and silently loses any line that begins exactly on a boundary.
  const readFrom = chunk.start > 0 ? chunk.start - 1 : 0;

  const stream = createReadStream(chunk.path, {
    start: readFrom,
    highWaterMark: options.highWaterMark ?? 1 << 20,
  });

  let leftover: Buffer | undefined;
  /** Absolute file offset of `leftover[0]`. */
  let leftoverOffset = readFrom;
  /** True until the partial line owned by the previous chunk is discarded. */
  let discardingPartialLine = chunk.start > 0;
  let bytesRead = 0;
  let linesRead = 0;
  let stop = false;

  for await (const piece of stream) {
    const incoming = piece as Buffer;
    let data: Buffer;
    let dataOffset: number;

    if (leftover && leftover.length > 0) {
      data = Buffer.concat([leftover, incoming]);
      dataOffset = leftoverOffset;
    } else {
      data = incoming;
      dataOffset = leftoverOffset;
    }

    let cursor = 0;
    let newlineIndex: number;
    while ((newlineIndex = data.indexOf(NEWLINE, cursor)) !== -1) {
      const lineStartOffset = dataOffset + cursor;

      if (discardingPartialLine) {
        discardingPartialLine = false;
        cursor = newlineIndex + 1;
        continue;
      }

      if (lineStartOffset >= chunk.end) {
        stop = true;
        break;
      }

      let lineEnd = newlineIndex;
      if (lineEnd > cursor && data[lineEnd - 1] === CARRIAGE_RETURN) lineEnd -= 1;
      if (lineEnd > cursor) {
        onLine(data, cursor, lineEnd);
        linesRead += 1;
        bytesRead += lineEnd - cursor;
      }
      cursor = newlineIndex + 1;
    }

    if (stop) break;

    leftoverOffset = dataOffset + cursor;
    // `subarray` keeps a view on `data`; copy so the (large) read buffer can be
    // collected while we hold only the trailing partial line.
    leftover = cursor < data.length ? Buffer.from(data.subarray(cursor)) : undefined;
  }

  stream.destroy();

  // A final line with no trailing newline still belongs to this chunk if it
  // started before `end`.
  if (!stop && leftover && leftover.length > 0 && !discardingPartialLine && leftoverOffset < chunk.end) {
    let lineEnd = leftover.length;
    if (lineEnd > 0 && leftover[lineEnd - 1] === CARRIAGE_RETURN) lineEnd -= 1;
    if (lineEnd > 0) {
      onLine(leftover, 0, lineEnd);
      linesRead += 1;
      bytesRead += lineEnd;
    }
  }

  return { bytesRead, linesRead };
}
