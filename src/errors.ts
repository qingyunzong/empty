import type { AssociationErrorCode } from './types.js';

/**
 * Thrown when the whole table cannot be associated.
 *
 * `path` is a reproducible chain of cell IDs starting at the offending data
 * cell and following the explicit `headers` dependency edges down to the
 * point of failure, so the same input always yields the same path.
 */
export class HeaderAssociationError extends Error {
  readonly code: AssociationErrorCode;
  readonly path: string[];

  constructor(code: AssociationErrorCode, path: string[], message: string) {
    super(message);
    this.name = 'HeaderAssociationError';
    this.code = code;
    this.path = [...path];
  }
}
