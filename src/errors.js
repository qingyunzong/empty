export class InputError extends Error {
  constructor(code, at, message) {
    super(message || code);
    this.name = 'InputError';
    this.code = code; // e.g. E_INPUT
    this.at = at;     // e.g. orders.jsonl:3 or order/O7.mold
  }
  toJSON() { return { code: this.code, at: this.at }; }
}

export class InfeasibleError extends Error {
  constructor(conflict) {
    super('infeasible: minimal conflict set = [' + conflict.join(', ') + ']');
    this.name = 'InfeasibleError';
    this.code = 'E_INFEASIBLE';
    this.conflict = conflict; // minimal set of order ids
  }
  toJSON() { return { code: this.code, conflict: this.conflict }; }
}
