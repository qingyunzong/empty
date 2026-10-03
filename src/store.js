import { Polynomial } from './polynomial.js';
import { computeInstruction } from './quantize.js';
import { stateError } from './errors.js';

// Coefficient revision store with transactional commits and undo/redo.
//
// - begin() opens a transaction on a private working copy.
// - commit() validates the staged coefficients; an invalid transaction is
//   discarded and the active version is left untouched.
// - undo()/redo() walk the linear version history; a new commit truncates
//   any redo tail.
export class OvenStore {
  constructor(initialCoeffs = ['0']) {
    const validated = OvenStore._validate(initialCoeffs);
    this._versions = [validated];
    this._index = 0;
    this._tx = null;
  }

  static _validate(coeffs) {
    // Polynomial constructor performs full validation (E_CONFIG / E_RATIONAL).
    const poly = new Polynomial(coeffs);
    return poly.coeffs.map((c) => c.toString());
  }

  get depth() {
    return this._versions.length;
  }

  get index() {
    return this._index;
  }

  get inTransaction() {
    return this._tx !== null;
  }

  activeCoefficients() {
    return [...this._versions[this._index]];
  }

  activePolynomial() {
    return new Polynomial(this._versions[this._index]);
  }

  begin() {
    if (this._tx !== null) {
      throw stateError('E_STATE: a transaction is already open');
    }
    this._tx = { staged: null };
    return this._tx;
  }

  stage(coeffs) {
    if (this._tx === null) {
      throw stateError('E_STATE: no open transaction; call begin() first');
    }
    // Keep the raw payload; validation happens only at commit time so an
    // illegal transaction can never half-mutate the active version.
    this._tx.staged = Array.isArray(coeffs) ? [...coeffs] : coeffs;
  }

  commit() {
    if (this._tx === null) {
      throw stateError('E_STATE: no open transaction to commit');
    }
    const tx = this._tx;
    this._tx = null;
    if (tx.staged === null) {
      throw stateError('E_STATE: nothing staged in transaction');
    }
    // Throws E_CONFIG / E_RATIONAL on illegal input; active version unchanged.
    const validated = OvenStore._validate(tx.staged);
    this._versions = this._versions.slice(0, this._index + 1);
    this._versions.push(validated);
    this._index += 1;
    return this.activeCoefficients();
  }

  rollback() {
    if (this._tx === null) {
      throw stateError('E_STATE: no open transaction to roll back');
    }
    this._tx = null;
  }

  canUndo() {
    return this._index > 0;
  }

  canRedo() {
    return this._index < this._versions.length - 1;
  }

  undo() {
    if (!this.canUndo()) {
      throw stateError('E_STATE: nothing to undo');
    }
    this._index -= 1;
    return this.activeCoefficients();
  }

  redo() {
    if (!this.canRedo()) {
      throw stateError('E_STATE: nothing to redo');
    }
    this._index += 1;
    return this.activeCoefficients();
  }

  // Control instruction computed from the currently active coefficients.
  instruction(lo, hi, k) {
    return computeInstruction(this.activePolynomial(), lo, hi, k);
  }

  toJSON() {
    return {
      versions: this._versions.map((v) => [...v]),
      index: this._index,
    };
  }

  static fromJSON(data) {
    const store = Object.create(OvenStore.prototype);
    if (!data || !Array.isArray(data.versions) || data.versions.length === 0) {
      throw stateError('E_STATE: malformed persisted store');
    }
    store._versions = data.versions.map((v) => OvenStore._validate(v));
    store._index = data.index;
    if (!Number.isInteger(store._index) || store._index < 0 || store._index >= store._versions.length) {
      throw stateError('E_STATE: persisted index out of range');
    }
    store._tx = null;
    return store;
  }
}
