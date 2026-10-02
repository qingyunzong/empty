'use strict';

const fs = require('node:fs');
const { CodedError } = require('./errors');

function loadPolicy(path) {
  const policy = JSON.parse(fs.readFileSync(path, 'utf8'));
  validatePolicy(policy);
  return policy;
}

function allSubjects(policy) {
  return [...policy.tenants, ...policy.groups].map((e) => e.id);
}

function parentMap(policy) {
  const map = new Map();
  for (const e of [...policy.tenants, ...policy.groups]) map.set(e.id, e.parents || []);
  return map;
}

function validatePolicy(policy) {
  policy.tenants = policy.tenants || [];
  policy.groups = policy.groups || [];
  policy.tags = policy.tags || [];
  policy.devices = policy.devices || [];
  policy.rules = policy.rules || [];
  const tagSet = new Set(policy.tags);
  for (const d of policy.devices) {
    for (const t of d.tags || []) {
      if (!tagSet.has(t)) throw new CodedError(9, `unknown tag '${t}' on device '${d.id}'`);
    }
  }
  for (const r of policy.rules) {
    if (r.tag && !tagSet.has(r.tag)) throw new CodedError(9, `unknown tag '${r.tag}' in rule '${r.id}'`);
  }
  // Eagerly validate the inheritance graph so cycles fail before any query.
  for (const id of allSubjects(policy)) subjectClosure(policy, id);
}

// Returns [self, ...ancestors]. Throws CodedError(4) on inheritance cycles.
function subjectClosure(policy, subjectId) {
  const parents = parentMap(policy);
  const out = [];
  const state = new Map(); // 1 = visiting, 2 = done
  const visit = (id) => {
    const st = state.get(id);
    if (st === 1) throw new CodedError(4, `tenant/group inheritance cycle detected at '${id}'`);
    if (st === 2) return;
    state.set(id, 1);
    out.push(id);
    for (const p of parents.get(id) || []) visit(p);
    state.set(id, 2);
  };
  visit(subjectId);
  return out;
}

module.exports = { loadPolicy, validatePolicy, subjectClosure, parentMap, allSubjects };
