export class BusinessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BusinessError';
  }
}

export class CorruptionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorruptionError';
  }
}
