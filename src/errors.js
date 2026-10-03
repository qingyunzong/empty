export class SettleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SettleError';
    this.code = code;
  }
}

export const E = {
  ARGS: 'E_ARGS',
  IO: 'E_IO',
  PARSE: 'E_PARSE',
  SCHEMA: 'E_SCHEMA',
  DUP_TRADE: 'E_DUP_TRADE',
  BAD_NULL: 'E_BAD_NULL',
  UNKNOWN_TRADE: 'E_UNKNOWN_TRADE',
  BAD_EVENT: 'E_BAD_EVENT',
  CERT_TAMPER: 'E_CERT_TAMPER',
};
