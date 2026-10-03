export class AuditError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const intervalError = (message, details) => new AuditError('E_INTERVAL', message, details);
export const patchError = (message, details) => new AuditError('E_PATCH', message, details);
export const certError = (message, details) => new AuditError('E_CERT', message, details);
export const unknownError = (message, details) => new AuditError('E_UNKNOWN', message, details);
