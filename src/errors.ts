import type { Digest } from './digest.js';

export interface StateMismatch {
  entryId: number;
  path: string;
  expected: Digest | null;
  actual: Digest | null;
}

function describe(mismatches: StateMismatch[]): string {
  return mismatches
    .map((m) => `${m.path} (expected ${m.expected ?? '<absent>'}, found ${m.actual ?? '<absent>'})`)
    .join('; ');
}

/**
 * Thrown by undo/redo when the current on-disk state is not the recorded
 * image the batch expects (e.g. a file was modified outside the journal).
 * Nothing on disk has been touched when this is thrown.
 */
export class ExternalModificationError extends Error {
  readonly mismatches: readonly StateMismatch[];

  constructor(mismatches: StateMismatch[]) {
    super(`batch rejected, ${mismatches.length} path(s) changed outside the journal: ${describe(mismatches)}`);
    this.name = 'ExternalModificationError';
    this.mismatches = mismatches;
  }
}

/**
 * Thrown when the post-apply verification of bytes and paths fails, i.e. the
 * disk does not look the way the just-applied batch should have left it.
 */
export class IntegrityError extends Error {
  readonly mismatches: readonly StateMismatch[];

  constructor(mismatches: StateMismatch[]) {
    super(`post-apply verification failed: ${describe(mismatches)}`);
    this.name = 'IntegrityError';
    this.mismatches = mismatches;
  }
}
