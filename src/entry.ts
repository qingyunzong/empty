import type { Digest } from './digest.js';

/** A file was created; after-image is its digest, before-image is "absent". */
export interface CreateEntry {
  id: number;
  kind: 'create';
  path: string;
  after: Digest;
}

/** An existing file's bytes were replaced. */
export interface WriteEntry {
  id: number;
  kind: 'write';
  path: string;
  before: Digest;
  after: Digest;
}

/** A file was removed; after-image is "absent". */
export interface DeleteEntry {
  id: number;
  kind: 'delete';
  path: string;
  before: Digest;
}

/**
 * A file was renamed. `before` is the digest at `from` before the move,
 * `after` the digest at `to` after it (identical bytes, so identical digest).
 * If the move overwrote an existing file at `to`, `overwritten` holds that
 * victim's digest and its bytes are kept in the backup store.
 */
export interface MoveEntry {
  id: number;
  kind: 'move';
  from: string;
  to: string;
  before: Digest;
  after: Digest;
  overwritten: Digest | null;
}

export type Entry = CreateEntry | WriteEntry | DeleteEntry | MoveEntry;
