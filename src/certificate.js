'use strict';

// UNSAT certificates: minimal conflicting order subset + resource bottleneck.
//
// A certificate claims:
//   1. the listed order subset cannot all be completed (infeasible),
//   2. removing any single order from the subset makes it feasible (minimal),
//   3. the bottleneck names a resource whose capacity is short by one unit
//      (kit qty +1, one more identical tech, or a missing skill) which would
//      make the subset feasible.
// Every claim is independently re-checkable with verifyCertificate().
// UNKNOWN (solver node limit) is never treated as infeasible: if any check
// cannot be decided, the certificate is flagged `unverified` instead.

const { createHash } = require('node:crypto');
const { solve, validate, PlannerError } = require('./planner');

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function certificateHash(cert) {
  return sha256(canonicalize({
    type: cert.type,
    orders: cert.orders,
    bottleneck: cert.bottleneck,
  }));
}

// Returns true / false / 'unknown' (node limit hit -> must not prove UNSAT).
function feasibleAll(instance, nodeLimit) {
  const result = solve(instance, { requireAll: true, findFirst: true, nodeLimit });
  if (result.status === 'UNKNOWN') return 'unknown';
  return result.status === 'OPTIMAL';
}

function subsetInstance(inst, orderIds, mods = {}) {
  const ids = new Set(orderIds);
  return {
    orders: inst.orders.filter((o) => ids.has(o.id)),
    techs: mods.extraTech ? [...inst.techs, mods.extraTech] : inst.techs,
    kits: inst.kits.map((k) => (mods.bumpKit === k.id ? { ...k, qty: k.qty + 1 } : k)),
  };
}

function cloneTech(tech) {
  return {
    ...tech,
    id: `${tech.id}#clone`,
    skills: [...tech.skills],
    shifts: tech.shifts.map((s) => [...s]),
  };
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function buildCertificate(instance, options = {}) {
  const nodeLimit = options.nodeLimit === undefined ? 1000000 : options.nodeLimit;
  const inst = validate(instance);
  let unverified = false;

  const full = feasibleAll(inst, nodeLimit);
  if (full === true) {
    throw new PlannerError('ERR_NOT_UNSAT', 'instance is feasible; no UNSAT certificate applies');
  }
  if (full === 'unknown') unverified = true;

  // Deletion-based minimal unsatisfiable subset: an order stays removed only
  // if the remainder is still infeasible.
  let subset = inst.orders.map((o) => o.id);
  for (const id of [...subset]) {
    if (subset.length === 1) break;
    const trial = subset.filter((x) => x !== id);
    const verdict = feasibleAll(subsetInstance(inst, trial), nodeLimit);
    if (verdict === false) subset = trial;
    else if (verdict === 'unknown') unverified = true;
  }
  subset = [...subset].sort();

  // Bottleneck isolation: the first single-resource +1 fix that restores
  // feasibility of the minimal subset.
  let bottleneck = null;
  const subsetOrders = inst.orders.filter((o) => subset.includes(o.id));
  const missingSkill = subsetOrders.find(
    (o) => !inst.techs.some((t) => t.skills.includes(o.skill)),
  );
  if (missingSkill) {
    bottleneck = { kind: 'skill', skill: missingSkill.skill, have: 0, need: 1 };
  } else {
    for (const kit of [...inst.kits].sort(byId)) {
      const verdict = feasibleAll(subsetInstance(inst, subset, { bumpKit: kit.id }), nodeLimit);
      if (verdict === true) {
        bottleneck = { kind: 'kit', id: kit.id, have: kit.qty, need: kit.qty + 1 };
        break;
      }
      if (verdict === 'unknown') unverified = true;
    }
    if (!bottleneck) {
      for (const tech of [...inst.techs].sort(byId)) {
        const verdict = feasibleAll(subsetInstance(inst, subset, { extraTech: cloneTech(tech) }), nodeLimit);
        if (verdict === true) {
          bottleneck = { kind: 'tech', id: tech.id, have: 1, need: 2 };
          break;
        }
        if (verdict === 'unknown') unverified = true;
      }
    }
    if (!bottleneck) bottleneck = { kind: 'unknown' };
  }

  const cert = { type: 'UNSAT', orders: subset, bottleneck };
  if (unverified) cert.unverified = true;
  cert.hash = certificateHash(cert);
  return cert;
}

function verifyCertificate(instance, cert, options = {}) {
  const nodeLimit = options.nodeLimit === undefined ? 1000000 : options.nodeLimit;
  const checks = [];
  let inst;
  try {
    inst = validate(instance);
  } catch (err) {
    return { ok: false, checks: [{ name: 'instance-valid', ok: false, detail: err.code }] };
  }

  const known = new Set(inst.orders.map((o) => o.id));
  const ordersKnown = Array.isArray(cert.orders)
    && cert.orders.length > 0
    && cert.orders.every((id) => known.has(id));
  checks.push({ name: 'orders-known', ok: ordersKnown });
  checks.push({ name: 'hash', ok: cert.hash === certificateHash(cert) });

  if (ordersKnown) {
    const verdict = feasibleAll(subsetInstance(inst, cert.orders), nodeLimit);
    checks.push({ name: 'subset-infeasible', ok: verdict === false, detail: String(verdict) });

    let minimal = true;
    for (const id of cert.orders) {
      const rest = cert.orders.filter((x) => x !== id);
      const v = rest.length === 0 ? true : feasibleAll(subsetInstance(inst, rest), nodeLimit);
      if (v !== true) {
        minimal = false;
        break;
      }
    }
    checks.push({ name: 'minimal', ok: minimal });

    const bottleneck = cert.bottleneck || {};
    if (bottleneck.kind === 'kit') {
      const kit = inst.kits.find((k) => k.id === bottleneck.id);
      const qtyOk = Boolean(kit) && kit.qty === bottleneck.have && bottleneck.need === bottleneck.have + 1;
      const verdict = qtyOk
        ? feasibleAll(subsetInstance(inst, cert.orders, { bumpKit: bottleneck.id }), nodeLimit)
        : 'skipped';
      checks.push({
        name: 'bottleneck',
        ok: qtyOk && verdict === true,
        detail: `kit ${bottleneck.id} qty ${bottleneck.have}->${bottleneck.need} restores feasibility: ${verdict}`,
      });
    } else if (bottleneck.kind === 'tech') {
      const tech = inst.techs.find((t) => t.id === bottleneck.id);
      let ok = Boolean(tech);
      if (ok) {
        ok = feasibleAll(
          subsetInstance(inst, cert.orders, { extraTech: cloneTech(tech) }),
          nodeLimit,
        ) === true;
      }
      checks.push({ name: 'bottleneck', ok, detail: `one more tech like ${bottleneck.id} restores feasibility` });
    } else if (bottleneck.kind === 'skill') {
      const ok = cert.orders.some((id) => {
        const order = inst.orders.find((o) => o.id === id);
        return order
          && order.skill === bottleneck.skill
          && !inst.techs.some((t) => t.skills.includes(order.skill));
      });
      checks.push({ name: 'bottleneck', ok, detail: `no tech has skill ${bottleneck.skill}` });
    } else {
      checks.push({
        name: 'bottleneck',
        ok: bottleneck.kind === 'unknown',
        detail: 'no single-resource bottleneck isolated',
      });
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}

// Solve and, when the instance proves UNSAT (and no locks are active), attach
// a minimal conflict certificate.
function solveWithCertificate(instance, options = {}) {
  const result = solve(instance, options);
  const hasLocks = options.locks && Object.keys(options.locks).length > 0;
  if (result.status === 'UNSAT' && !hasLocks) {
    result.certificate = buildCertificate(instance, options.certificateOptions);
  }
  return result;
}

module.exports = {
  buildCertificate,
  verifyCertificate,
  solveWithCertificate,
  certificateHash,
  canonicalize,
};
