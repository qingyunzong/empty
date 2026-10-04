import { validationError } from './errors.js';

const ITEM_RE = /^[A-Z]{2,5}-\d{3,10}$/;
const BIN_RE = /^[A-Z]-\d{2}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function keyOf(bin, item) {
  return `${bin}|${item}`;
}

export function splitKey(key) {
  const idx = key.indexOf('|');
  return [key.slice(0, idx), key.slice(idx + 1)];
}

export function validateItem(item) {
  if (typeof item !== 'string' || !ITEM_RE.test(item)) {
    throw validationError(`invalid item barcode ${JSON.stringify(item)}; expected like WIP-0001 (${ITEM_RE})`);
  }
  return item;
}

export function validateBin(bin) {
  if (typeof bin !== 'string' || !BIN_RE.test(bin)) {
    throw validationError(`invalid bin barcode ${JSON.stringify(bin)}; expected like A-01 (${BIN_RE})`);
  }
  return bin;
}

export function validateId(id, what = 'id') {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw validationError(`invalid ${what} ${JSON.stringify(id)}; expected ${ID_RE}`);
  }
  return id;
}

export function validateScanQty(qty) {
  if (!Number.isInteger(qty) || qty < 1) {
    throw validationError(`scan qty must be a positive integer, got ${JSON.stringify(qty)}`);
  }
  return qty;
}

export function validateAdjustDelta(delta) {
  if (!Number.isInteger(delta) || delta === 0) {
    throw validationError(`adjust delta must be a non-zero integer, got ${JSON.stringify(delta)}`);
  }
  return delta;
}
