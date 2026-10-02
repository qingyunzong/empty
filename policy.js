'use strict';

// Decides whether `token` ({subject, action, amount, self}) is permitted at
// `position` in the action sequence.
//
// Semantics:
// - permissions are inherited through the role hierarchy (subjectRoles is the
//   transitive closure computed in spec.js);
// - deny wins over allow;
// - a revocation {rule, at} deactivates the rule for positions >= at only
//   (revocation is future-effective, never retroactive).
function isPermitted(spec, position, token) {
  const granted = spec.subjectRoles[token.subject];
  if (!granted) return false;
  let allowed = false;
  for (const rule of spec.rules) {
    const at = spec.revokedAt.get(rule.id);
    if (at !== undefined && position >= at) continue;
    if (!granted.has(rule.role)) continue;
    if (rule.action !== token.action) continue;
    if (rule.self !== undefined && rule.self !== token.self) continue;
    if (rule.amountGt !== undefined && !(token.amount > rule.amountGt)) continue;
    if (rule.effect === 'deny') return false;
    allowed = true;
  }
  return allowed;
}

module.exports = { isPermitted };
