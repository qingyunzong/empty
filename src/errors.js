export const ERR_SCHEMA = 'ERR_SCHEMA';
export const ERR_CLOCK = 'ERR_CLOCK';
export const ERR_CONFLICT = 'ERR_CONFLICT';

export class OeeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'OeeError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export const schemaError = (message, details) => new OeeError(ERR_SCHEMA, message, details);
export const clockError = (message, details) => new OeeError(ERR_CLOCK, message, details);
export const conflictError = (message, details) => new OeeError(ERR_CONFLICT, message, details);
