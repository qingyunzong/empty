export class RevError extends Error {
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'RevError';
    this.code = code;
    this.txnId = opts.txnId ?? null;
    this.pc = opts.pc ?? null;
    if (opts.line != null) this.line = opts.line;
    if (opts.col != null) this.col = opts.col;
  }

  toJSON() {
    const out = { code: this.code, message: this.message, txnId: this.txnId, pc: this.pc };
    if (this.line != null) {
      out.line = this.line;
      out.col = this.col;
    }
    return out;
  }
}

export class CrashFault extends Error {
  constructor(seq) {
    super(`simulated crash after WAL record seq=${seq}`);
    this.name = 'CrashFault';
    this.code = 'E_CRASH';
    this.seq = seq;
  }
}

export const ioError = (message, opts) => new RevError('E_IO', message, opts);
export const stateError = (message, opts) => new RevError('E_STATE', message, opts);
export const lockError = (message, opts) => new RevError('E_LOCK', message, opts);
export const dupError = (message, opts) => new RevError('E_DUP', message, opts);
export const parseError = (message, opts) => new RevError('E_PARSE', message, opts);
export const typeError = (message, opts) => new RevError('E_TYPE', message, opts);
export const scopeError = (message, opts) => new RevError('E_SCOPE', message, opts);
