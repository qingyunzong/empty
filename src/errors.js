export class SafeZoneError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SafeZoneError';
    this.code = code;
  }
}

export function fail(code, message) {
  return { ok: false, error: { code, message } };
}

export function toErrorResult(e) {
  if (e instanceof SafeZoneError) {
    return fail(e.code, e.message);
  }
  throw e;
}
