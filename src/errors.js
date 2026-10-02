export const ExitCode = Object.freeze({
  OK: 0,
  ERROR: 1,
  TAMPER_DETECTED: 2,
  MISSING_BLOCK: 3,
  INVALID_PROOF: 4,
  STALE_EPOCH: 5,
  USAGE: 6,
});

export const Code = Object.freeze({
  TAMPER_DETECTED: 'TAMPER_DETECTED',
  MISSING_BLOCK: 'MISSING_BLOCK',
  INVALID_PROOF: 'INVALID_PROOF',
  STALE_EPOCH: 'STALE_EPOCH',
  CONFLICT: 'CONFLICT',
  INDEX_OUT_OF_RANGE: 'INDEX_OUT_OF_RANGE',
  USAGE: 'USAGE',
  IO: 'IO_ERROR',
  INTERNAL: 'INTERNAL',
});

export class PackError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PackError';
    this.code = code;
    this.details = details;
  }
}

export function exitCodeFor(code) {
  switch (code) {
    case Code.TAMPER_DETECTED: return ExitCode.TAMPER_DETECTED;
    case Code.MISSING_BLOCK: return ExitCode.MISSING_BLOCK;
    case Code.INVALID_PROOF: return ExitCode.INVALID_PROOF;
    case Code.STALE_EPOCH: return ExitCode.STALE_EPOCH;
    case Code.USAGE: return ExitCode.USAGE;
    default: return ExitCode.ERROR;
  }
}
