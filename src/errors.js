export class PlannerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlannerError';
    this.code = code;
  }
}

export const CODES = {
  SPEC_SHAPE: 'E_SPEC_SHAPE',
  FIELD_TYPE: 'E_FIELD_TYPE',
  DUPLICATE: 'E_DUPLICATE',
  BAD_ARTIFACT_TYPE: 'E_BAD_ARTIFACT_TYPE',
  PARSE: 'E_PARSE',
  UNKNOWN_REF: 'E_UNKNOWN_REF',
  TYPE_MISMATCH: 'E_TYPE_MISMATCH',
  NO_FEASIBLE: 'E_NO_FEASIBLE',
  TOO_MANY_TASKS: 'E_TOO_MANY_TASKS',
  UNKNOWN_VERSION: 'E_UNKNOWN_VERSION',
  UNKNOWN_TASK: 'E_UNKNOWN_TASK',
};
