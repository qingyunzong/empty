export class EvidenceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'EvidenceError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const E_CYCLE = 'E_CYCLE';
export const E_SOURCE_GONE = 'E_SOURCE_GONE';
export const E_WAL = 'E_WAL';
export const E_HASH = 'E_HASH';
export const E_DUP = 'E_DUP';
export const E_INPUT = 'E_INPUT';
export const E_CRASH = 'E_CRASH'; // simulated crash injected at a fault point

export function err(code, message, details) {
  return new EvidenceError(code, message, details);
}
