'use strict';

const { normalizeBook } = require('./model');
const { jointAcceptable } = require('./automaton');
const { minRepairScripts } = require('./repair');
const { buildRejectCertificate } = require('./certificate');

// Main entry: diff two books (arrays of event objects).
// Returns { balanced, scripts, scriptsTruncated, certificate } and, when the
// repair search exceeds the bound k, also error: { code: 'SEARCH_BOUND', ... }.
// Input validation failures (DUP_ID, CURRENCY_MIX, SIZE_LIMIT, ...) throw.
function diffBooks(leftEvents, rightEvents, opts = {}) {
  const k = opts.k === undefined ? 5 : opts.k;
  const L = normalizeBook(leftEvents, 'left');
  const R = normalizeBook(rightEvents, 'right');
  if (jointAcceptable(L, R)) {
    // The left book's own sequence is a common accepted linearization of the
    // product automaton (see jointAcceptable in src/automaton.js).
    return {
      balanced: true,
      scripts: [],
      scriptsTruncated: false,
      certificate: { type: 'accept', witness: L.map((e) => e.id) },
    };
  }
  const reject = buildRejectCertificate(L, R);
  const res = minRepairScripts(L, R, k, opts);
  if (res.status === 'found') {
    return {
      balanced: false,
      scripts: res.scripts.map((ops) => ({ cost: ops.length, ops })),
      scriptsTruncated: res.truncated,
      certificate: { ...reject, repair: { minCost: res.cost, scriptCount: res.scripts.length } },
    };
  }
  if (res.status === 'exhausted') {
    return {
      balanced: false,
      scripts: [],
      scriptsTruncated: false,
      certificate: { ...reject, repair: { exists: false } },
    };
  }
  return {
    balanced: false,
    scripts: [],
    scriptsTruncated: false,
    error: {
      code: 'SEARCH_BOUND',
      message: `no repair script with cost <= ${k}; proven lower bound: ${res.provenLowerBound}`,
    },
    certificate: {
      type: 'search-bound',
      k,
      provenLowerBound: res.provenLowerBound,
      reject,
    },
  };
}

module.exports = { diffBooks };
