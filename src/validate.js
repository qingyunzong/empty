'use strict';
const { validation } = require('./errors.js');

const BIN_RE = /^[A-Z]-\d{2}$/;
const ITEM_RE = /^[A-Z]{2,4}-\d{4,12}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NODE_RE = /^[A-Za-z0-9_-]{1,16}$/;

function validateBin(bin) {
  if (typeof bin !== 'string' || !BIN_RE.test(bin)) {
    throw validation('INVALID_BARCODE', `invalid bin barcode: ${JSON.stringify(bin)} (expected like "A-01")`);
  }
}

function validateItem(item) {
  if (typeof item !== 'string' || !ITEM_RE.test(item)) {
    throw validation('INVALID_BARCODE', `invalid item barcode: ${JSON.stringify(item)} (expected like "ITM-0001")`);
  }
}

function validateDelta(delta) {
  if (typeof delta !== 'number' || !Number.isInteger(delta) || delta === 0) {
    throw validation('INVALID_QTY', `quantity delta must be a non-zero integer, got ${JSON.stringify(delta)}`);
  }
}

function validateSessionId(id) {
  if (typeof id !== 'string' || !SESSION_RE.test(id)) {
    throw validation('INVALID_SESSION', `invalid session id: ${JSON.stringify(id)}`);
  }
}

function validateNodeId(id) {
  if (typeof id !== 'string' || !NODE_RE.test(id)) {
    throw validation('INVALID_NODE', `invalid node id: ${JSON.stringify(id)}`);
  }
}

module.exports = { validateBin, validateItem, validateDelta, validateSessionId, validateNodeId };
