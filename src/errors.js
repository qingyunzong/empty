export class PlanSyncError extends Error {
  constructor(code, message, exitCode, details) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.details = details ?? null;
  }
}
export const validation = (msg, details) => new PlanSyncError('VALIDATION_FAILED', msg, 2, details);
export const conflictPending = (msg, details) => new PlanSyncError('CONFLICT_PENDING', msg, 3, details);
export const recovery = (msg, details) => new PlanSyncError('RECOVERY_FAILED', msg, 4, details);
export const usage = (msg, details) => new PlanSyncError('USAGE', msg, 1, details);
