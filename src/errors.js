export const E = {
  STATE: 'E_STATE',
  LOCK: 'E_LOCK',
  DUP: 'E_DUP',
  IO: 'E_IO',
  PARSE: 'E_PARSE',
  TYPE: 'E_TYPE',
};

export class RevError extends Error {
  constructor(code, message, { txnId = null, pc = null } = {}) {
    super(message);
    this.name = 'RevError';
    this.code = code;
    this.txnId = txnId;
    this.pc = pc;
  }

  format() {
    const parts = [`error[${this.code}]`];
    if (this.txnId != null) parts.push(`txn=${this.txnId}`);
    if (this.pc != null) parts.push(`pc=${this.pc}`);
    return `${parts.join(' ')}: ${this.message}`;
  }
}
