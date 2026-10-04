export const ERR_CURVE = 'ERR_CURVE';
export const ERR_DOMAIN = 'ERR_DOMAIN';
export const ERR_NOT_FOUND = 'ERR_NOT_FOUND';

export class SchedulerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SchedulerError';
    this.code = code;
  }
}
