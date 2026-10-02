'use strict';

const { ACTIONS } = require('./model');

const BIT = { read: 1, modify: 2, mark_false_positive: 4 };
const SAFETY_TAG = 'safety-public';
const SHUTDOWN_TYPE = 'shutdown';

function eventTags(policy, event) {
  const device = policy.devices[event.device];
  return device ? device.tags : [];
}

// The safety-public tag makes shutdown events publicly readable and can break
// an explicit read-deny; the break is always recorded via breakReason/broken.
function isSafetyPublicRead(event, tags, action) {
  return action === 'read' && event.type === SHUTDOWN_TYPE && tags.includes(SAFETY_TAG);
}

function applicableRevocations(policy, tenant, at, skipRevocations) {
  const byGrant = new Map();
  for (const r of policy.revocations) {
    if (skipRevocations.has(r.id)) continue;
    if (r.ts > at) continue;
    if (r.tenant != null && r.tenant !== tenant) continue;
    if (!byGrant.has(r.grant)) byGrant.set(r.grant, r);
  }
  return byGrant;
}

// Core single-decision evaluation (indexed). No counterexample computation.
function evaluate(policy, tenant, event, action, at, skip = {}) {
  const skipRevocations = skip.revocations || new Set();
  const skipDenies = skip.denies || new Set();
  const ancestors = policy.ancestors[tenant];
  if (!ancestors) throw new Error(`unknown tenant: ${tenant}`);
  const tags = eventTags(policy, event);
  const revokedByGrant = applicableRevocations(policy, tenant, at, skipRevocations);

  const allows = [];
  const denies = [];
  const pushUnique = (list, entry) => {
    if (!list.some((e) => e.id === entry.id)) list.push(entry);
  };

  for (const tag of tags) {
    for (const g of policy.index.grantsByTag.get(tag) || []) {
      if (!g.actions.includes(action)) continue;
      if (!ancestors.includes(g.tenant)) continue;
      if (revokedByGrant.has(g.id)) continue;
      pushUnique(allows, { kind: 'grant', id: g.id });
    }
    for (const d of policy.index.deniesByTag.get(tag) || []) {
      if (!d.actions.includes(action)) continue;
      if (!ancestors.includes(d.tenant)) continue;
      if (skipDenies.has(d.id)) continue;
      pushUnique(denies, { kind: 'deny', id: d.id });
    }
  }
  for (const x of policy.index.exceptionsByEvent.get(event.id) || []) {
    if (x.action !== action) continue;
    if (!ancestors.includes(x.tenant)) continue;
    if (x.effect === 'allow') {
      pushUnique(allows, { kind: 'exception', id: x.id });
    } else if (!skipDenies.has(x.id)) {
      pushUnique(denies, { kind: 'exception', id: x.id });
    }
  }

  const safety = isSafetyPublicRead(event, tags, action);
  let allow;
  const broken = [];
  let breakReason = null;
  if (denies.length > 0) {
    if (safety) {
      allow = true;
      for (const d of denies) broken.push(d.id);
      breakReason = `safety-public shutdown read breaks deny: ${broken.join(', ')}`;
    } else {
      allow = false;
    }
  } else if (allows.length > 0) {
    allow = true;
  } else if (safety) {
    allow = true;
    breakReason = 'safety-public shutdown event is publicly readable';
  } else {
    allow = false;
  }
  return { allow, allows, denies, broken, breakReason };
}

// Minimal counterexample for a denied decision: a single change that would
// flip the outcome (remove one revocation / remove one deny), or the minimal
// grant that is missing.
function counterexample(policy, tenant, event, action, at) {
  for (const r of policy.revocations) {
    if (r.ts > at) continue;
    if (r.tenant != null && r.tenant !== tenant) continue;
    const retry = evaluate(policy, tenant, event, action, at, { revocations: new Set([r.id]) });
    if (retry.allow) {
      return {
        kind: 'extra-revocation',
        revocation: r.id,
        description: `removing revocation "${r.id}" (of grant "${r.grant}") would allow ${action}`,
      };
    }
  }
  const base = evaluate(policy, tenant, event, action, at);
  for (const d of base.denies) {
    const retry = evaluate(policy, tenant, event, action, at, { denies: new Set([d.id]) });
    if (retry.allow) {
      return {
        kind: 'extra-deny',
        deny: d.id,
        description: `removing deny rule "${d.id}" would allow ${action}`,
      };
    }
  }
  const tags = eventTags(policy, event);
  const tag = tags.length > 0 ? tags[0] : null;
  return {
    kind: 'missing-grant',
    grant: { tenant, tag, action },
    description: `missing grant allowing "${action}" for tenant "${tenant}" on tag "${tag}"`,
  };
}

function decide(policy, tenant, event, action, at) {
  const result = evaluate(policy, tenant, event, action, at);
  const out = {
    tenant,
    event: event.id,
    action,
    at,
    allow: result.allow,
    allows: result.allows,
    denies: result.denies,
    broken: result.broken,
    breakReason: result.breakReason,
    counterexample: null,
  };
  if (!result.allow) out.counterexample = counterexample(policy, tenant, event, action, at);
  return out;
}

function visibilityBitmap(policy, tenant, event, at) {
  let bitmap = 0;
  const allowed = [];
  const denied = [];
  for (const action of ACTIONS) {
    const d = decide(policy, tenant, event, action, at);
    if (d.allow) {
      bitmap |= BIT[action];
      allowed.push(action);
    } else {
      denied.push(action);
    }
  }
  return { bitmap, allowed, denied };
}

// Reference implementation: deliberately naive, no indexes, plain loops.
// Used by acceptance test D to cross-check the main evaluator.
function decideReference(policy, tenant, event, action, at) {
  const ancestors = [];
  let cur = tenant;
  while (cur != null) {
    ancestors.push(cur);
    cur = policy.tenants[cur].parent === undefined ? null : policy.tenants[cur].parent;
  }
  const device = policy.devices[event.device];
  const tags = device ? device.tags : [];

  let allowed = false;
  let denied = false;

  for (const g of policy.grants) {
    if (!ancestors.includes(g.tenant)) continue;
    if (g.tag === undefined || !tags.includes(g.tag)) continue;
    if (!g.actions.includes(action)) continue;
    let revoked = false;
    for (const r of policy.revocations) {
      if (r.grant !== g.id) continue;
      if (r.ts > at) continue;
      if (r.tenant != null && r.tenant !== tenant) continue;
      revoked = true;
      break;
    }
    if (!revoked) allowed = true;
  }
  for (const d of policy.denies) {
    if (!ancestors.includes(d.tenant)) continue;
    if (!tags.includes(d.tag)) continue;
    if (!d.actions.includes(action)) continue;
    denied = true;
  }
  for (const x of policy.exceptions) {
    if (x.event !== event.id) continue;
    if (x.action !== action) continue;
    if (!ancestors.includes(x.tenant)) continue;
    if (x.effect === 'allow') allowed = true;
    else denied = true;
  }

  const safety = action === 'read' && event.type === 'shutdown' && tags.includes('safety-public');
  if (denied) return safety;
  if (allowed) return true;
  return safety;
}

function referenceBitmap(policy, tenant, event, at) {
  let bitmap = 0;
  for (const action of ACTIONS) {
    if (decideReference(policy, tenant, event, action, at)) bitmap |= BIT[action];
  }
  return bitmap;
}

module.exports = {
  BIT,
  SAFETY_TAG,
  SHUTDOWN_TYPE,
  eventTags,
  evaluate,
  decide,
  visibilityBitmap,
  decideReference,
  referenceBitmap,
};
