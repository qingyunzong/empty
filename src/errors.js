export class EvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EvidenceError';
    this.code = code;
  }
}

export const E = {
  cycle: (msg) => new EvidenceError('E_CYCLE', msg),
  sourceGone: (msg) => new EvidenceError('E_SOURCE_GONE', msg),
  wal: (msg) => new EvidenceError('E_WAL', msg),
  hash: (msg) => new EvidenceError('E_HASH', msg),
};
