export type ArchiveErrorCode =
  | 'ESCAPE_ROOT'
  | 'EMPTY_PATH'
  | 'DUPLICATE_PATH'
  | 'TYPE_CONFLICT'
  | 'MISSING_TARGET'
  | 'SYMLINK_CYCLE'
  | 'NOT_FOUND';

export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode;
  /** For SYMLINK_CYCLE: the shortest repeated chain of normalized symlink paths. */
  readonly chain: string[] | undefined;

  constructor(code: ArchiveErrorCode, message: string, chain?: string[]) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
    this.chain = chain;
  }
}

export function isArchiveError(err: unknown, code?: ArchiveErrorCode): err is ArchiveError {
  return err instanceof ArchiveError && (code === undefined || err.code === code);
}
