export class RiskError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'RiskError';
    this.code = code;
  }
}

export const E = (code, message) => new RiskError(code, message);
