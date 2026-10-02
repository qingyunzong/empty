export class BusinessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BusinessError';
    this.code = 'REJECTED';
  }
}

export class CorruptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorruptError';
    this.code = 'CORRUPT';
  }
}
