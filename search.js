'use strict';

const crypto = require('node:crypto');
const { isPermitted } = require('./policy');

function keyOf(subject, amount) {
  return subject + '|' + amount;
}

// Canonical token order: subject alphabetical, then action alphabetical,
// then amount ascending. Sequences are ordered lexicographically by token.
function compareTokens(a, b) {
  if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1;
  if (a.action !== b.action) return a.action < b.action ? -1 : 1;
  return a.amount - b.amount;
}

function canonicalTokens(spec) {
  const tokens = [];
  for (const subject of spec.subjects) {
    for (const action of spec.actions) {
      for (const amount of spec.amounts) {
        tokens.push({ subject, action, amount });
      }
    }
  }
  return tokens.sort(compareTokens);
}

function prepareContext(spec) {
  return {
    tokens: canonicalTokens(spec),
    clerks: spec.subjects.filter((s) => spec.subjectRoles[s].has(spec.invariant.role)),
    bigAmounts: spec.amounts.filter((a) => a > spec.threshold),
  };
}

// Simulates a concrete trace: every action must be permitted at its position
// (self = the subject previously submitted the same amount). Returns the
// invariant violation as soon as it occurs.
function checkTrace(spec, sequence) {
  const submitted = new Map();
  for (let pos = 0; pos < sequence.length; pos++) {
    const token = sequence[pos];
    const key = keyOf(token.subject, token.amount);
    const self = token.action === spec.invariant.second && submitted.has(key);
    if (!isPermitted(spec, pos, { ...token, self })) {
      return { valid: false, position: pos, violation: null };
    }
    let violation = null;
    if (
      self &&
      spec.subjectRoles[token.subject].has(spec.invariant.role) &&
      token.amount > spec.threshold
    ) {
      violation = {
        subject: token.subject,
        amount: token.amount,
        submitIndex: submitted.get(key),
        approveIndex: pos,
      };
    }
    if (token.action === spec.invariant.first && !submitted.has(key)) {
      submitted.set(key, pos);
    }
    if (violation) return { valid: true, violation };
  }
  return { valid: true, violation: null };
}

// Can positions [pos, length) still be filled so that a violation occurs
// (or remains, if violationFound)? Exact with respect to the violation
// condition; the fillability check uses the most permissive self context.
function completionExists(spec, ctx, length, pos, submitted, violationFound) {
  for (let p = pos; p < length; p++) {
    const fillable = ctx.tokens.some(
      (t) =>
        isPermitted(spec, p, { ...t, self: false }) ||
        isPermitted(spec, p, { ...t, self: true })
    );
    if (!fillable) return false;
  }
  if (violationFound) return true;
  const { first, second } = spec.invariant;
  for (const subject of ctx.clerks) {
    for (const amount of ctx.bigAmounts) {
      const key = keyOf(subject, amount);
      if (submitted.has(key)) {
        for (let j = pos; j < length; j++) {
          if (isPermitted(spec, j, { subject, action: second, amount, self: true })) return true;
        }
      }
      for (let i = pos; i < length; i++) {
        if (!isPermitted(spec, i, { subject, action: first, amount, self: false })) continue;
        for (let j = i + 1; j < length; j++) {
          if (isPermitted(spec, j, { subject, action: second, amount, self: true })) return true;
        }
      }
    }
  }
  return false;
}

// Lexicographically smallest violating sequence of exactly `length` actions,
// built greedily token by token in canonical order.
function searchLength(spec, ctx, length) {
  const { first, second } = spec.invariant;
  const sequence = [];
  const submitted = new Map();
  let violation = null;
  for (let pos = 0; pos < length; pos++) {
    let advanced = false;
    for (const token of ctx.tokens) {
      const key = keyOf(token.subject, token.amount);
      const self = token.action === second && submitted.has(key);
      if (!isPermitted(spec, pos, { ...token, self })) continue;
      const added = token.action === first && !submitted.has(key);
      if (added) submitted.set(key, pos);
      let nextViolation = violation;
      if (
        !nextViolation &&
        self &&
        spec.subjectRoles[token.subject].has(spec.invariant.role) &&
        token.amount > spec.threshold
      ) {
        nextViolation = {
          subject: token.subject,
          amount: token.amount,
          submitIndex: submitted.get(key),
          approveIndex: pos,
        };
      }
      if (completionExists(spec, ctx, length, pos + 1, submitted, nextViolation !== null)) {
        sequence.push(token);
        violation = nextViolation;
        advanced = true;
        break;
      }
      if (added) submitted.delete(key);
    }
    if (!advanced) return null;
  }
  return violation ? { sequence, violation } : null;
}

// Minimal counterexample: fewest actions first, then lexicographically
// smallest canonical sequence. Returns null when no violation exists within
// spec.maxLength actions.
function findCounterexample(spec) {
  const ctx = prepareContext(spec);
  if (ctx.clerks.length === 0 || ctx.bigAmounts.length === 0) return null;
  for (let length = 2; length <= spec.maxLength; length++) {
    const found = searchLength(spec, ctx, length);
    if (found) {
      const sequence = found.sequence.map((t) => ({ ...t }));
      const check = checkTrace(spec, sequence);
      if (!check.valid || !check.violation) {
        throw new Error('internal error: search produced an invalid witness');
      }
      return { length, sequence, violation: check.violation };
    }
  }
  return null;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

// Certificate of infeasibility: the full permission matrix over every
// position x (subject, action, amount) x self-context, hashed together with
// the normalized spec.
function buildCertificate(spec) {
  const tokens = canonicalTokens(spec);
  const matrix = [];
  for (let pos = 0; pos < spec.maxLength; pos++) {
    for (const token of tokens) {
      for (const self of [false, true]) {
        matrix.push([
          pos,
          token.subject,
          token.action,
          token.amount,
          self,
          isPermitted(spec, pos, { ...token, self }) ? 1 : 0,
        ]);
      }
    }
  }
  const payload = JSON.stringify(
    canonicalize({ purpose: 'settlement-invariant-proof', spec: spec.canonical, matrix })
  );
  return {
    algorithm: 'sha256',
    hash: crypto.createHash('sha256').update(payload).digest('hex'),
    combinations: tokens.length,
    selfContexts: 2,
    positions: spec.maxLength,
    evaluations: matrix.length,
    subjects: spec.subjects,
    actions: spec.actions,
    amounts: spec.amounts,
  };
}

function analyze(spec) {
  const counterexample = findCounterexample(spec);
  if (counterexample) {
    return {
      result: 'counterexample',
      length: counterexample.length,
      sequence: counterexample.sequence,
      violation: counterexample.violation,
    };
  }
  return { result: 'proof', certificate: buildCertificate(spec) };
}

module.exports = {
  canonicalTokens,
  compareTokens,
  checkTrace,
  findCounterexample,
  buildCertificate,
  analyze,
};
