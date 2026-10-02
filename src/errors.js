export class CodedError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'CodedError';
    this.code = code;
  }
}

export const ERRORS = {
  OFFSET_TABLE_CONFLICT: 'OFFSET_TABLE_CONFLICT',
  PERIOD_INVERSION: 'PERIOD_INVERSION',
  UNKNOWN_TIMEZONE: 'UNKNOWN_TIMEZONE',
  LOCAL_TIME_OUT_OF_TABLE: 'LOCAL_TIME_OUT_OF_TABLE',
  BAD_COMMAND: 'BAD_COMMAND',
};
