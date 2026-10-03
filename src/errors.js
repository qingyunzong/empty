export const E_INTERVAL = 'E_INTERVAL';
export const E_PATCH = 'E_PATCH';
export const E_CERT = 'E_CERT';
export const E_UNKNOWN = 'E_UNKNOWN';

export class AuditError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
