export const E = {
  CRC: 'E_CRC',
  DEPTH: 'E_DEPTH',
  TARGET: 'E_TARGET',
  DUP: 'E_DUP',
  FORMAT: 'E_FORMAT',
};

export class CncError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CncError';
    this.code = code;
  }
}
