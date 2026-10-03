export const E = Object.freeze({
  CCY: 'E_CCY',
  CYCLE_DUP: 'E_CYCLE_DUP',
  NO_SOL: 'E_NO_SOL',
  PARSE: 'E_PARSE',
});

export class NetError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'NetError';
    this.code = code;
  }
}
