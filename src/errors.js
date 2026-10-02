export class EngineError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}
