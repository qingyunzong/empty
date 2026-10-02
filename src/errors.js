export class LogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LogError';
    this.code = code;
  }
}

export const E_CRC = 'E_CRC';
export const E_REVISION = 'E_REVISION';
export const E_FORMAT = 'E_FORMAT';
export const E_TRUNCATED = 'E_TRUNCATED';
export const E_NO_CORRECTION = 'E_NO_CORRECTION';
