export class RiskError extends Error {
  constructor(code, message, pos) {
    super(pos ? `${message} (line ${pos.line}, col ${pos.col})` : message);
    this.name = 'RiskError';
    this.code = code;
  }
}
