'use strict';

const { hasLabel } = require('./policy');
const { isRevoked } = require('./redactions');

// Verify every output field of a view has an authorization path.
function auditView(policy, viewResult) {
  const fields = [];
  const violations = [];
  for (const [name, value] of Object.entries(viewResult.fields)) {
    const auth = viewResult.details[name] || { field: name, path: [] };
    if (value === null) {
      fields.push({ name, redacted: true, reason: 'pii-boundary' });
      continue;
    }
    const hasPath =
      auth.regulatory === true ||
      auth.shared === true ||
      (auth.allowed === true && auth.clearance >= auth.classification);
    fields.push({
      name,
      path: auth.path || [],
      clearance: auth.clearance,
      classification: auth.classification,
      regulatory: auth.regulatory === true,
    });
    if (!hasPath) {
      violations.push({ name, reason: 'no-authorization-path' });
    }
  }
  return {
    type: 'view-audit',
    view: viewResult.view,
    report: viewResult.report,
    ok: violations.length === 0,
    fields,
    violations,
  };
}

// Counterexample: the minimal field set whose (mis)authorization would make
// the given principal's view leak `label`-tagged data (e.g. recipe).
// distance = missing grants (0/1) + clearance levels short; 0 means leaking now.
function counterexample(policy, report, principal, viewResult, label, revoked) {
  const candidates = [];
  for (const field of Object.keys(report.fields || {})) {
    if (!hasLabel(policy, field, label)) continue;
    if (isRevoked(revoked, principal, field)) {
      candidates.push({ field, blocked: 'revoked', distance: null, leaking: false });
      continue;
    }
    const auth = viewResult.details[field];
    const value = viewResult.fields[field];
    const leaking = value !== undefined && value !== null;
    let distance;
    if (leaking) {
      distance = 0;
    } else {
      const grantGap = auth.allowed ? 0 : 1;
      const clearanceGap = Math.max(0, (auth.classification ?? 0) - auth.clearance);
      distance = grantGap + clearanceGap;
    }
    candidates.push({ field, distance, leaking });
  }
  const actionable = candidates.filter((c) => c.distance !== null);
  actionable.sort((x, y) => x.distance - y.distance || x.field.localeCompare(y.field));
  const best = actionable[0] || null;
  return {
    type: 'counterexample',
    view: principal,
    report: report.id,
    label,
    minimalFieldSet: best ? [best.field] : [],
    distance: best ? best.distance : null,
    leaking: actionable.some((c) => c.leaking),
    candidates,
  };
}

module.exports = { auditView, counterexample };
