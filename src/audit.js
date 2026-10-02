'use strict';
// Core library for the auditable aggregation CLI.
// Standard library only (node:crypto).

const crypto = require('node:crypto');

const VERSION = 1;
const NULL_CATEGORY = '(null)';

const EXIT = {
  OK: 0,
  GENERIC: 1,
  E_FUTURE_CORRECTION: 2,
  E_PROOF: 3,
  E_DUPLICATE_ID: 4,
  E_PARSE: 5,
};

class AuditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
  }
}

function sha256tag(data) {
  return 'sha256:' + crypto.createHash('sha256').update(data).digest('hex');
}

// Canonical JSON: object keys sorted recursively, no whitespace.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function normalizeCategory(c) {
  if (c === null || c === undefined) return NULL_CATEGORY;
  const s = String(c);
  return s === '' ? NULL_CATEGORY : s;
}

// Parse jsonl content. asOf = line-number cutoff (1-based); null means whole file.
// Returns { rows, totalLines, effAsOf }.
function parseEntries(content, asOf) {
  if (asOf !== null && asOf !== undefined && (!Number.isInteger(asOf) || asOf < 0)) {
    throw new AuditError('E_PARSE', `invalid --as-of value: ${asOf}`);
  }
  const rawLines = content.split(/\r?\n/);
  const rows = [];
  let totalLines = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    if (raw.trim() === '') continue; // skip blank lines, keep line numbers as seq
    totalLines = i + 1;
    const seq = i + 1;
    if (asOf !== null && asOf !== undefined && seq > asOf) continue;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new AuditError('E_PARSE', `line ${seq}: invalid JSON`);
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new AuditError('E_PARSE', `line ${seq}: entry must be a JSON object`);
    }
    let amount = obj.amount === null || obj.amount === undefined ? 0 : obj.amount;
    let amountInvalid = false;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      amount = 0;
      amountInvalid = true; // excluded from aggregation, still committed to proof
    }
    rows.push({
      seq,
      id: obj.id === undefined || obj.id === null ? `L${seq}` : String(obj.id),
      account: obj.account === undefined ? null : obj.account,
      amount,
      amountInvalid,
      category: normalizeCategory(obj.category),
      valid: obj.valid === undefined ? true : Boolean(obj.valid),
      corrects: obj.corrects === undefined || obj.corrects === null ? null : String(obj.corrects),
      raw,
      hash: sha256tag(raw),
      status: null,
      supersededBy: null,
    });
  }
  const effAsOf = asOf === null || asOf === undefined ? totalLines : Math.min(asOf, totalLines);
  return { rows, totalLines, effAsOf };
}

// Resolve supersede chains. Only valid correction rows supersede their target.
function resolveStatuses(rows) {
  const byId = new Map();
  for (const r of rows) {
    if (byId.has(r.id)) {
      throw new AuditError('E_DUPLICATE_ID', `duplicate id "${r.id}" at line ${r.seq}`);
    }
    byId.set(r.id, r);
  }
  for (const r of rows) {
    if (r.corrects !== null) {
      const t = byId.get(r.corrects);
      if (!t) {
        throw new AuditError(
          'E_FUTURE_CORRECTION',
          `line ${r.seq} ("${r.id}") corrects unknown entry "${r.corrects}"`
        );
      }
      if (t.seq >= r.seq) {
        throw new AuditError(
          'E_FUTURE_CORRECTION',
          `line ${r.seq} ("${r.id}") corrects entry "${r.corrects}" at line ${t.seq} (not yet seen)`
        );
      }
    }
  }
  const supersededBy = new Map();
  for (const r of rows) {
    if (r.corrects !== null && r.valid && !r.amountInvalid) {
      const t = byId.get(r.corrects);
      const prev = supersededBy.get(t.id);
      if (!prev || prev.seq < r.seq) supersededBy.set(t.id, r);
    }
  }
  for (const r of rows) {
    const sup = supersededBy.get(r.id);
    r.supersededBy = sup ? sup.id : null;
    r.status = !r.valid || r.amountInvalid ? 'invalid' : sup ? 'superseded' : 'active';
  }
}

// Aggregate active rows, optionally restricted to a set of categories.
function aggregateCategories(rows, onlyCategories) {
  const cats = new Map();
  for (const r of rows) {
    if (r.status !== 'active') continue;
    if (onlyCategories && !onlyCategories.has(r.category)) continue;
    let c = cats.get(r.category);
    if (!c) {
      c = { sumCents: 0, count: 0, leafHashes: [] };
      cats.set(r.category, c);
    }
    c.sumCents += Math.round(r.amount * 100);
    c.count += 1;
    c.leafHashes.push(r.hash);
  }
  const out = {};
  for (const [name, c] of [...cats.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const sum = c.sumCents / 100;
    out[name] = {
      sum,
      count: c.count,
      leafHashes: c.leafHashes,
      pathHash: sha256tag(
        canonicalize({ category: name, sum, count: c.count, leaves: c.leafHashes })
      ),
    };
  }
  return out;
}

// Normalized relational-algebra expression for the aggregation.
function expressionFor(effAsOf) {
  return (
    `pi[category,sum,count](` +
    `group_by[category; sum:=sum(amount); count:=count(*)](` +
    `select[valid AND NOT superseded](entries[1..${effAsOf}])))`
  );
}

function computeRootHash(categories) {
  const map = {};
  for (const [k, v] of Object.entries(categories)) map[k] = v.pathHash;
  return sha256tag(canonicalize(map));
}

function leavesOf(rows) {
  return rows.map((r) => ({
    seq: r.seq,
    id: r.id,
    hash: r.hash,
    status: r.status,
    supersededBy: r.supersededBy,
  }));
}

function assembleProof({ inputPath, content, effAsOf, totalLines, rows, categories, incrementalMeta }) {
  return {
    version: VERSION,
    input: inputPath,
    inputHash: sha256tag(content), // commits to the WHOLE input file -> stale proofs are rejected
    asOf: effAsOf,
    totalLines,
    expression: expressionFor(effAsOf),
    leaves: leavesOf(rows),
    categories,
    rootHash: computeRootHash(categories),
    outputHash: null, // filled in by the caller after the output file is written
    meta: { incremental: incrementalMeta || null },
  };
}

// Full rebuild: aggregate every category from scratch.
function buildFull(inputPath, content, asOf) {
  const { rows, totalLines, effAsOf } = parseEntries(content, asOf);
  resolveStatuses(rows);
  const categories = aggregateCategories(rows, null);
  const proof = assembleProof({
    inputPath,
    content,
    effAsOf,
    totalLines,
    rows,
    categories,
    incrementalMeta: null,
  });
  return { proof, rows };
}

// Incremental rebuild: reuse unaffected category aggregates from a previous proof.
// Falls back to a full rebuild when the history prefix no longer matches.
function buildIncremental(inputPath, content, asOf, prevProof) {
  const { rows, totalLines, effAsOf } = parseEntries(content, asOf);
  resolveStatuses(rows);

  const prevLeaves = prevProof && Array.isArray(prevProof.leaves) ? prevProof.leaves : [];
  let prefixOk = prevProof && prevProof.asOf <= effAsOf && prevLeaves.length > 0;
  if (prefixOk) {
    for (let i = 0; i < prevLeaves.length; i++) {
      const row = rows[i];
      if (!row || row.seq !== prevLeaves[i].seq || row.hash !== prevLeaves[i].hash) {
        prefixOk = false;
        break;
      }
    }
  }
  if (!prefixOk) {
    const categories = aggregateCategories(rows, null);
    const proof = assembleProof({
      inputPath,
      content,
      effAsOf,
      totalLines,
      rows,
      categories,
      incrementalMeta: { fallback: true, reason: 'no matching previous proof prefix' },
    });
    return { proof, rows };
  }

  const affected = new Set();
  for (const r of rows) {
    if (r.seq > prevProof.asOf) affected.add(r.category);
  }
  for (let i = 0; i < prevLeaves.length; i++) {
    if (rows[i].status !== prevLeaves[i].status) affected.add(rows[i].category);
  }

  const recomputed = aggregateCategories(rows, affected);
  const categories = {};
  const reused = [];
  for (const [name, agg] of Object.entries(prevProof.categories || {})) {
    if (!affected.has(name)) {
      categories[name] = agg; // reuse: prefix rows were hash-verified above
      reused.push(name);
    }
  }
  for (const [name, agg] of Object.entries(recomputed)) categories[name] = agg;
  const sorted = {};
  for (const k of Object.keys(categories).sort()) sorted[k] = categories[k];

  const proof = assembleProof({
    inputPath,
    content,
    effAsOf,
    totalLines,
    rows,
    categories: sorted,
    incrementalMeta: {
      fallback: false,
      base: prevProof.asOf,
      affectedCategories: [...affected].sort(),
      reusedCategories: reused.sort(),
    },
  });
  return { proof, rows };
}

// Deterministic output document (per-category sum/count).
function outputDocument(proof) {
  const categories = {};
  for (const [k, v] of Object.entries(proof.categories)) {
    categories[k] = { sum: v.sum, count: v.count };
  }
  return {
    asOf: proof.asOf,
    expression: proof.expression,
    categories,
    rootHash: proof.rootHash,
  };
}

function renderOutput(proof) {
  return JSON.stringify(outputDocument(proof), null, 2) + '\n';
}

function renderProof(proof) {
  return JSON.stringify(proof, null, 2) + '\n';
}

// Independent recomputation check. Throws AuditError('E_PROOF', ...) on any mismatch.
function verifyProof(inputContent, outputBytes, proof) {
  const problems = [];
  if (proof.version !== VERSION) problems.push(`unsupported proof version ${proof.version}`);
  if (sha256tag(inputContent) !== proof.inputHash) {
    problems.push('inputHash mismatch (input changed after proof was built: stale proof)');
  }
  const { rows, effAsOf } = parseEntries(inputContent, proof.asOf);
  resolveStatuses(rows);

  if (effAsOf !== proof.asOf) problems.push(`asOf mismatch: expected ${proof.asOf}, got ${effAsOf}`);
  if (expressionFor(proof.asOf) !== proof.expression) {
    problems.push('expression mismatch');
  }
  const leaves = leavesOf(rows);
  if (canonicalize(leaves) !== canonicalize(proof.leaves)) {
    problems.push('leaf hashes/statuses mismatch (an input row was modified)');
  }
  const categories = aggregateCategories(rows, null);
  if (canonicalize(categories) !== canonicalize(proof.categories)) {
    problems.push('category aggregates / aggregation paths mismatch');
  }
  if (computeRootHash(categories) !== proof.rootHash) {
    problems.push('rootHash mismatch');
  }
  if (sha256tag(outputBytes) !== proof.outputHash) {
    problems.push('outputHash mismatch (output file was modified)');
  }
  if (problems.length) {
    throw new AuditError('E_PROOF', problems.join('; '));
  }
  return true;
}

module.exports = {
  VERSION,
  NULL_CATEGORY,
  EXIT,
  AuditError,
  sha256tag,
  canonicalize,
  normalizeCategory,
  parseEntries,
  resolveStatuses,
  aggregateCategories,
  expressionFor,
  computeRootHash,
  buildFull,
  buildIncremental,
  outputDocument,
  renderOutput,
  renderProof,
  verifyProof,
};
