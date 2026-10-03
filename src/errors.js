export class QError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'QError';
    this.code = code;
  }
  toJSON() {
    return { code: this.code, message: this.message };
  }
}

export function qerror(code, message) {
  return new QError(code, message);
}

export function toErrorJSON(e) {
  if (e instanceof QError) return e.toJSON();
  return { code: 'E_INTERNAL', message: String(e && e.message ? e.message : e) };
}
