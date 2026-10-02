export const E = Object.freeze({
  PARSE: 'E_PARSE',
  CCY: 'E_CCY',
  TYPE: 'E_TYPE',
  SCOPE: 'E_SCOPE',
  CYCLE_DUP: 'E_CYCLE_DUP',
  NO_SOL: 'E_NO_SOL',
});

export class NetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NetError';
    this.code = code;
  }
}

export const err = (code, message) => new NetError(code, message);
