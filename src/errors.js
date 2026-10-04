export const ERR_DOMAIN = 'ERR_DOMAIN';
export const ERR_CYCLE = 'ERR_CYCLE';

export class SimError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SimError';
    this.code = code;
  }
}
