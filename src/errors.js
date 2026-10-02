export const ERR = Object.freeze({
  SCHEMA: 'ERR_SCHEMA',
  CLOCK: 'ERR_CLOCK',
  CONFLICT: 'ERR_CONFLICT',
});

export class OeeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'OeeError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function errJson(e) {
  const error = { code: e.code, message: e.message };
  if (e.details !== undefined) error.details = e.details;
  return { ok: false, error };
}
