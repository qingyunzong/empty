export const EXIT = Object.freeze({
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  BROKEN_CHAIN: 9,
  SEQ_TAMPER: 10,
  CERT_MISMATCH: 11,
  CRASH_STATE: 12,
});

export class AuditError extends Error {
  constructor(code, message, seq) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    if (seq !== undefined) this.seq = seq;
  }
}
