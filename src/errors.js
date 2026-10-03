export const E = Object.freeze({
  RATIONAL: 'E_RATIONAL',
  GEOMETRY: 'E_GEOMETRY',
  INTERVAL: 'E_INTERVAL',
  VALIDATION: 'E_VALIDATION',
  PARSE: 'E_PARSE',
  INTERNAL: 'E_INTERNAL',
});

export class QError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QError';
    this.code = code;
  }
}
