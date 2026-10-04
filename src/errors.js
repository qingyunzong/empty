export const ExitCode = Object.freeze({
  OK: 0,
  E_UNKNOWN: 1,
  E_DUP: 2,
  E_NOTFOUND: 3,
  E_ARGS: 4,
  E_IO: 5,
  E_CRASH: 101,
});

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export function exitCodeFor(code) {
  return Object.prototype.hasOwnProperty.call(ExitCode, code) ? ExitCode[code] : ExitCode.E_UNKNOWN;
}
