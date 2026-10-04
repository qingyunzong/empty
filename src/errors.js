export const EXIT = { OK: 0, VALIDATION: 2, STORAGE: 3, CONFLICT: 4 };

export class TraceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'TraceError';
    this.code = code; // VALIDATION | STORAGE | CONFLICT
    if (details !== undefined) this.details = details;
  }
  toJSON() {
    return { ok: false, code: this.code, message: this.message, details: this.details ?? null };
  }
}

export const validation = (msg, details) => new TraceError('VALIDATION', msg, details);
export const storage = (msg, details) => new TraceError('STORAGE', msg, details);
