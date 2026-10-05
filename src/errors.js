export class MergeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MergeError';
    this.code = code;
  }
}

export const EXIT_CODES = {
  BAD_RANGE: 2,
  UNKNOWN_SITE: 3,
  TOMBSTONE_HIT: 4,
};
