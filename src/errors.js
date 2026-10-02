export class ParamSyncError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ParamSyncError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
  toJSON() {
    const out = { code: this.code, message: this.message };
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

export class ValidationError extends ParamSyncError {
  constructor(message, details) {
    super('VALIDATION', message, details);
    this.name = 'ValidationError';
  }
}

export class RollbackError extends ParamSyncError {
  constructor(message, details) {
    super('ROLLBACK', message, details);
    this.name = 'RollbackError';
  }
}

export class SyncPendingError extends ParamSyncError {
  constructor(message, details) {
    super('SYNC_PENDING', message, details);
    this.name = 'SyncPendingError';
  }
}

export class FaultInjected extends ParamSyncError {
  constructor(point) {
    super('FAULT', `injected fault at ${point}`, { point });
    this.name = 'FaultInjected';
    this.point = point;
  }
}

export const EXIT_CODES = {
  VALIDATION: 2,
  ROLLBACK: 3,
  SYNC_PENDING: 11,
};
