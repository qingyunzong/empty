'use strict';

const { distances, pathTo } = require('./model');

function compareSpec(a, b) {
  return a.wildcards - b.wildcards || a.dist - b.dist;
}

function specOf(rule, roleDist, zoneDist) {
  const rd = rule.role === null ? null : roleDist.has(rule.role) ? roleDist.get(rule.role) : null;
  const zd = rule.zone === null ? null : zoneDist.has(rule.zone) ? zoneDist.get(rule.zone) : null;
  return {
    roleDist: rd,
    zoneDist: zd,
    wildcards: (rule.role === null ? 1 : 0) + (rule.zone === null ? 1 : 0),
    dist: (rd === null ? 0 : rd) + (zd === null ? 0 : zd),
  };
}

function evaluateInternal(policies, request) {
  const subject = policies.subjects[request.subject];
  const device = policies.devices[request.device];
  if (!subject) throw new Error(`unknown subject '${request.subject}'`);
  if (!device) throw new Error(`unknown device '${request.device}'`);

  const roleDist = distances(policies.roleGraph, subject.roles);
  const zoneDist = distances(policies.zoneGraph, [device.zone]);
  const t = Date.parse(request.time);

  const matched = [];
  const inapplicable = [];
  const retroactivelyRevoked = [];

  for (const rule of policies.rules) {
    if (rule.action !== request.action) continue;
    const spec = specOf(rule, roleDist, zoneDist);
    if (rule.role !== null && spec.roleDist === null) {
      inapplicable.push({ rule, why: 'role_mismatch', ...spec });
      continue;
    }
    if (rule.zone !== null && spec.zoneDist === null) {
      inapplicable.push({ rule, why: 'zone_mismatch', ...spec });
      continue;
    }
    if (rule.window !== null) {
      const s = Date.parse(rule.window.start);
      const e = Date.parse(rule.window.end);
      if (!(s <= t && t <= e)) {
        inapplicable.push({ rule, why: 'outside_window', ...spec });
        continue;
      }
    }
    if (rule.revokeAt !== null) {
      if (rule.retroactive) {
        retroactivelyRevoked.push(rule);
        inapplicable.push({ rule, why: 'retroactive_revocation', ...spec });
        continue;
      }
      if (t >= Date.parse(rule.revokeAt)) {
        inapplicable.push({ rule, why: 'revoked', ...spec });
        continue;
      }
    }
    matched.push({ rule, ...spec });
  }

  let decision;
  let reason;
  let decisive = [];
  let overridden = [];
  let conflict = null;

  if (matched.length === 0) {
    decision = 'deny';
    reason = 'no_matching_rule';
  } else {
    matched.sort(compareSpec);
    const best = matched[0];
    decisive = matched.filter((m) => m.wildcards === best.wildcards && m.dist === best.dist);
    overridden = matched.filter((m) => !decisive.includes(m));
    const effects = new Set(decisive.map((d) => d.rule.effect));
    if (effects.size > 1) {
      decision = 'deny';
      reason = 'conflict_default_deny';
      conflict = {
        specificity: { wildcards: best.wildcards, distance: best.dist },
        rules: decisive.map((d) => ({ ruleId: d.rule.id, effect: d.rule.effect })),
        resolution: 'deny',
        policy: 'same-specificity allow/deny conflict defaults to deny',
      };
    } else {
      decision = decisive[0].rule.effect;
      reason = 'rule';
    }
  }

  const rulePath = decisive.map((d) => ({
    ruleId: d.rule.id,
    effect: d.rule.effect,
    rolePath: d.rule.role === null ? null : pathTo(policies.roleGraph, subject.roles, d.rule.role),
    zonePath: d.rule.zone === null ? null : pathTo(policies.zoneGraph, [device.zone], d.rule.zone),
    specificity: { wildcards: d.wildcards, distance: d.dist },
  }));

  const alerts = [];
  if (decision === 'allow' && decisive.length > 0) {
    const best = decisive[0];
    for (const item of inapplicable) {
      if (
        item.why === 'retroactive_revocation' &&
        item.rule.effect === 'deny' &&
        compareSpec(item, best) <= 0
      ) {
        alerts.push(`allow_depends_on_retroactively_revoked_deny:${item.rule.id}`);
      }
    }
  }

  const record = {
    requestId: request.id,
    subject: request.subject,
    device: request.device,
    action: request.action,
    time: request.time,
    decision,
    reason,
    rulePath,
    overridden: overridden.map((o) => ({
      ruleId: o.rule.id,
      effect: o.rule.effect,
      specificity: { wildcards: o.wildcards, distance: o.dist },
      why: 'less_specific',
    })),
    conflict,
    retroactivelyRevoked: retroactivelyRevoked.map((r) => r.id),
    alerts,
    counterexample: null,
  };

  return { record, context: { decisive, inapplicable, matched, subject, device } };
}

function writeAudit(lines, record) {
  const ts = new Date().toISOString();
  const base =
    `request=${record.requestId} subject=${record.subject} device=${record.device} ` +
    `action=${record.action} time=${record.time}`;
  lines.push(
    `${ts} INFO ${base} -> ${record.decision} reason=${record.reason} ` +
      `rules=${record.rulePath.map((r) => r.ruleId).join(',') || '-'} ` +
      `overridden=${record.overridden.map((o) => o.ruleId).join(',') || '-'}`
  );
  if (record.conflict) {
    lines.push(
      `${ts} WARN ${base} CONFLICT certificate: ` +
        record.conflict.rules.map((r) => `${r.ruleId}(${r.effect})`).join(' vs ') +
        ` at specificity wildcards=${record.conflict.specificity.wildcards} ` +
        `distance=${record.conflict.specificity.distance} -> deny`
    );
  }
  if (record.retroactivelyRevoked.length) {
    lines.push(
      `${ts} NOTICE ${base} retroactively revoked rule(s) excluded from evaluation: ` +
        record.retroactivelyRevoked.join(',')
    );
  }
  for (const alert of record.alerts) {
    lines.push(`${ts} ALERT ${base} ${alert}`);
  }
}

function evaluateRequest(policies, request, opts = {}) {
  const { record, context } = evaluateInternal(policies, request);
  if (opts.withCounterexample !== false) {
    const { findCounterexample } = require('./counterexample');
    record.counterexample = findCounterexample(policies, request, record, context);
  }
  if (opts.audit) writeAudit(opts.audit, record);
  return record;
}

module.exports = { evaluateRequest, evaluateInternal, compareSpec };
