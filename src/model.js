'use strict';

class ExitError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.name = 'ExitError';
    this.exitCode = exitCode;
  }
}

const EXIT = { GENERIC: 2, TENANT_CYCLE: 4, OUT_OF_ORDER: 8, UNKNOWN_TAG: 9 };
const ACTIONS = ['read', 'modify', 'mark_false_positive'];

function requireFields(obj, fields, what) {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null) {
      throw new ExitError(EXIT.GENERIC, `${what} is missing required field "${f}"`);
    }
  }
}

function loadPolicy(obj) {
  if (!obj || typeof obj !== 'object') throw new ExitError(EXIT.GENERIC, 'policy must be a JSON object');
  const policy = {
    tenants: obj.tenants || {},
    tags: new Set(obj.tags || []),
    devices: obj.devices || {},
    grants: obj.grants || [],
    denies: obj.denies || [],
    exceptions: obj.exceptions || [],
    revocations: obj.revocations || [],
    ancestors: {},
    index: { grantsByTag: new Map(), deniesByTag: new Map(), exceptionsByEvent: new Map() },
  };

  // Tenant hierarchy + cycle detection (exit 4).
  for (const [name, node] of Object.entries(policy.tenants)) {
    if (!node || typeof node !== 'object') throw new ExitError(EXIT.GENERIC, `tenant "${name}" must be an object`);
  }
  for (const name of Object.keys(policy.tenants)) {
    const chain = [];
    const seen = new Set();
    let cur = name;
    while (cur != null) {
      if (seen.has(cur)) throw new ExitError(EXIT.TENANT_CYCLE, `tenant hierarchy cycle detected at "${cur}"`);
      seen.add(cur);
      chain.push(cur);
      const node = policy.tenants[cur];
      if (!node) throw new ExitError(EXIT.GENERIC, `tenant "${chain[chain.length - 1]}" has unknown parent "${cur}"`);
      cur = node.parent === undefined ? null : node.parent;
    }
    policy.ancestors[name] = chain;
  }

  // Devices: validate tags (exit 9).
  for (const [devName, dev] of Object.entries(policy.devices)) {
    const tags = (dev && dev.tags) || [];
    if (!Array.isArray(tags)) throw new ExitError(EXIT.GENERIC, `device "${devName}" tags must be an array`);
    for (const t of tags) {
      if (!policy.tags.has(t)) throw new ExitError(EXIT.UNKNOWN_TAG, `device "${devName}" references unknown tag "${t}"`);
    }
    policy.devices[devName] = { tags };
  }

  const ruleIds = new Set();
  const checkRule = (rule, kind) => {
    requireFields(rule, ['id', 'tenant'], `${kind} rule`);
    if (ruleIds.has(rule.id)) throw new ExitError(EXIT.GENERIC, `duplicate rule id "${rule.id}"`);
    ruleIds.add(rule.id);
    if (!policy.tenants[rule.tenant]) throw new ExitError(EXIT.GENERIC, `${kind} "${rule.id}" references unknown tenant "${rule.tenant}"`);
    if (!policy.tags.has(rule.tag)) throw new ExitError(EXIT.UNKNOWN_TAG, `${kind} "${rule.id}" references unknown tag "${rule.tag}"`);
    if (!Array.isArray(rule.actions) || rule.actions.length === 0) throw new ExitError(EXIT.GENERIC, `${kind} "${rule.id}" needs a non-empty actions array`);
    for (const a of rule.actions) {
      if (!ACTIONS.includes(a)) throw new ExitError(EXIT.GENERIC, `${kind} "${rule.id}" has unknown action "${a}"`);
    }
  };
  for (const g of policy.grants) checkRule(g, 'grant');
  for (const d of policy.denies) checkRule(d, 'deny');

  for (const x of policy.exceptions) {
    requireFields(x, ['id', 'event', 'tenant', 'action', 'effect'], 'exception rule');
    if (ruleIds.has(x.id)) throw new ExitError(EXIT.GENERIC, `duplicate rule id "${x.id}"`);
    ruleIds.add(x.id);
    if (!policy.tenants[x.tenant]) throw new ExitError(EXIT.GENERIC, `exception "${x.id}" references unknown tenant "${x.tenant}"`);
    if (!ACTIONS.includes(x.action)) throw new ExitError(EXIT.GENERIC, `exception "${x.id}" has unknown action "${x.action}"`);
    if (x.effect !== 'allow' && x.effect !== 'deny') throw new ExitError(EXIT.GENERIC, `exception "${x.id}" effect must be "allow" or "deny"`);
  }

  const grantIds = new Set(policy.grants.map((g) => g.id));
  for (const r of policy.revocations) {
    requireFields(r, ['id', 'grant', 'ts'], 'revocation');
    if (ruleIds.has(r.id)) throw new ExitError(EXIT.GENERIC, `duplicate rule id "${r.id}"`);
    ruleIds.add(r.id);
    if (!grantIds.has(r.grant)) throw new ExitError(EXIT.GENERIC, `revocation "${r.id}" targets unknown grant "${r.grant}"`);
    if (typeof r.ts !== 'number') throw new ExitError(EXIT.GENERIC, `revocation "${r.id}" needs numeric ts`);
    if (r.tenant != null && !policy.tenants[r.tenant]) throw new ExitError(EXIT.GENERIC, `revocation "${r.id}" references unknown tenant "${r.tenant}"`);
  }

  const put = (map, key, val) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(val);
  };
  for (const g of policy.grants) put(policy.index.grantsByTag, g.tag, g);
  for (const d of policy.denies) put(policy.index.deniesByTag, d.tag, d);
  for (const x of policy.exceptions) put(policy.index.exceptionsByEvent, x.event, x);

  return policy;
}

module.exports = { ExitError, EXIT, ACTIONS, loadPolicy };
