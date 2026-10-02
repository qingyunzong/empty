'use strict';

const { Polynomial } = require('./polynomial');
const { quantizeInterval } = require('./quantize');
const { E_TRANSACTION } = require('./errors');

function validateCoeffs(coeffs) {
  // Constructing a Polynomial enforces non-empty, rational, degree <= 4.
  return new Polynomial(coeffs);
}

class Transaction {
  #controller;
  #coeffs;
  #state = 'open';

  constructor(controller, baseCoeffs) {
    this.#controller = controller;
    this.#coeffs = baseCoeffs.slice();
  }

  setCoefficient(index, value) {
    this.#assertOpen();
    if (!Number.isInteger(index) || index < 0) {
      throw E_TRANSACTION(`coefficient index must be a non-negative integer, got ${index}`);
    }
    while (this.#coeffs.length <= index) this.#coeffs.push('0');
    this.#coeffs[index] = value;
    return this;
  }

  setCoefficients(coeffs) {
    this.#assertOpen();
    this.#coeffs = coeffs.slice();
    return this;
  }

  commit() {
    this.#assertOpen();
    // Validate first: an invalid transaction must not touch the active version.
    const poly = validateCoeffs(this.#coeffs);
    this.#state = 'committed';
    this.#controller._applyCommit(poly.coeffs.slice());
    return poly;
  }

  rollback() {
    this.#assertOpen();
    this.#state = 'rolled-back';
  }

  #assertOpen() {
    if (this.#state !== 'open') {
      throw E_TRANSACTION(`transaction is ${this.#state}`);
    }
  }
}

class OvenController {
  #active;
  #undoStack = [];
  #redoStack = [];

  constructor(coeffs) {
    this.#active = validateCoeffs(coeffs).coeffs.slice();
  }

  activeCoefficients() {
    return this.#active.slice();
  }

  beginTransaction() {
    return new Transaction(this, this.#active);
  }

  _applyCommit(coeffs) {
    this.#undoStack.push(this.#active);
    this.#active = coeffs;
    this.#redoStack = [];
  }

  undo() {
    if (this.#undoStack.length === 0) {
      throw E_TRANSACTION('nothing to undo');
    }
    this.#redoStack.push(this.#active);
    this.#active = this.#undoStack.pop();
  }

  redo() {
    if (this.#redoStack.length === 0) {
      throw E_TRANSACTION('nothing to redo');
    }
    this.#undoStack.push(this.#active);
    this.#active = this.#redoStack.pop();
  }

  // Exact instruction for the active version over [lo, hi] at scale 10^-k.
  instruction(lo, hi, k) {
    const poly = new Polynomial(this.#active);
    const { min, max } = poly.rangeOnInterval(lo, hi);
    const { value, errorBound } = quantizeInterval(min, max, k);
    return { interval: { min, max }, value, errorBound };
  }
}

module.exports = { OvenController, Transaction };
