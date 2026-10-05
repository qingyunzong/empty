export interface Change {
  id: string;
  content: string;
}

export interface Page {
  changes: Change[];
  /** Idempotency key for this page; also becomes the stored cursor. */
  nextCursor: string;
}

export interface Snapshot {
  records: Record<string, string>;
  cursor: string | null;
  /** Cursors of every page ever applied; used to detect page replays. */
  appliedCursors: string[];
}

export function emptySnapshot(): Snapshot {
  return { records: {}, cursor: null, appliedCursors: [] };
}
