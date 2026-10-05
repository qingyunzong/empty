/** Error raised for any canonical-encoding or canonical-parsing failure. */
export class CanonicalError extends Error {
  /** Absolute byte offset in the input stream where the problem was detected. */
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} (at byte offset ${offset})`);
    this.name = 'CanonicalError';
    this.offset = offset;
  }
}
