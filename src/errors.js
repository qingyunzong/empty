export class AlarmError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AlarmError';
    this.code = code;
    this.details = details ?? null;
  }
}

export function serializeError(error) {
  if (error instanceof AlarmError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  const message = error && error.message ? error.message : String(error);
  return { code: 'INTERNAL', message, details: null };
}
