export class InvalidInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidInputError';
    this.code = 'INVALID_INPUT';
  }
}
