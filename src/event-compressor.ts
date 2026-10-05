/**
 * Event compressor.
 *
 * A stream of events contains `put` events (key + monotonically increasing
 * per-key version + payload bytes) and explicit `barrier` events.
 *
 * compress(): adjacent `put` events that share a key AND have consecutive
 * versions are merged into one group. A barrier is never merged and forbids
 * merging across it. Each group reports its initial value, final value and
 * the merged event ids, and retains every frame so the merge is lossless.
 *
 * decompress(): expands groups back into the original event order, so the
 * restored byte sequence is identical to the input.
 */

export interface PutEvent {
  kind: 'put';
  id: string;
  key: string;
  version: number;
  data: Buffer;
}

export interface BarrierEvent {
  kind: 'barrier';
  id: string;
}

export type StreamEvent = PutEvent | BarrierEvent;

export interface MergedFrame {
  id: string;
  version: number;
  data: Buffer;
}

export interface MergedGroup {
  kind: 'group';
  key: string;
  startVersion: number;
  endVersion: number;
  /** Payload of the first merged event. */
  initialValue: Buffer;
  /** Payload of the last merged event. */
  finalValue: Buffer;
  /** Ids of all merged events, in original order. */
  mergedIds: string[];
  /** Every merged frame, kept for lossless decompression. */
  frames: MergedFrame[];
}

export interface BarrierRecord {
  kind: 'barrier';
  id: string;
}

export type CompressedRecord = MergedGroup | BarrierRecord;

export function compress(events: readonly StreamEvent[]): CompressedRecord[] {
  const records: CompressedRecord[] = [];
  let open: MergedGroup | null = null;

  const flush = (): void => {
    if (open !== null) {
      records.push(open);
      open = null;
    }
  };

  for (const event of events) {
    if (event.kind === 'barrier') {
      flush();
      records.push({ kind: 'barrier', id: event.id });
      continue;
    }
    if (open === null || open.key !== event.key || event.version !== open.endVersion + 1) {
      flush();
      open = {
        kind: 'group',
        key: event.key,
        startVersion: event.version,
        endVersion: event.version,
        initialValue: Buffer.from(event.data),
        finalValue: Buffer.from(event.data),
        mergedIds: [],
        frames: [],
      };
    }
    open.endVersion = event.version;
    open.finalValue = Buffer.from(event.data);
    open.mergedIds.push(event.id);
    open.frames.push({ id: event.id, version: event.version, data: Buffer.from(event.data) });
  }
  flush();
  return records;
}

export function decompress(records: readonly CompressedRecord[]): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const record of records) {
    if (record.kind === 'barrier') {
      events.push({ kind: 'barrier', id: record.id });
      continue;
    }
    for (const frame of record.frames) {
      events.push({
        kind: 'put',
        id: frame.id,
        key: record.key,
        version: frame.version,
        data: Buffer.from(frame.data),
      });
    }
  }
  return events;
}

/** Deterministic byte-level serialization of a stream, used for round-trip checks. */
export function serializeStream(events: readonly StreamEvent[]): Buffer {
  const parts: Buffer[] = [];
  for (const event of events) {
    if (event.kind === 'barrier') {
      parts.push(Buffer.from(`barrier|${event.id}\n`, 'utf8'));
    } else {
      parts.push(Buffer.from(`put|${event.id}|${event.key}|${event.version}|`, 'utf8'));
      parts.push(event.data);
      parts.push(Buffer.from('\n', 'utf8'));
    }
  }
  return Buffer.concat(parts);
}

/** Human-readable summary: one line per record with initial/final values and merged ids. */
export function summarize(records: readonly CompressedRecord[]): string[] {
  return records.map((record) => {
    if (record.kind === 'barrier') {
      return `barrier id=${record.id}`;
    }
    return (
      `group key=${record.key} versions=${record.startVersion}..${record.endVersion} ` +
      `initial=${record.initialValue.toString('hex') || '(empty)'} ` +
      `final=${record.finalValue.toString('hex') || '(empty)'} ` +
      `mergedIds=[${record.mergedIds.join(',')}]`
    );
  });
}
