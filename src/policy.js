export const LEVELS = { org: 0, role: 1, individual: 2 };

export class GateError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'GateError';
    this.exitCode = exitCode;
  }
}

export const EXIT_UNKNOWN_CLASSIFICATION = 28;
export const EXIT_VIEW_HASH_MISSING_INPUT = 29;
export const EXIT_REGULATORY_FIELD_DELETED = 30;

export function classificationOf(policy, field) {
  const meta = policy.fields?.[field];
  return meta && typeof meta.classification === 'string' ? meta.classification : null;
}

export function classificationMeta(policy, field) {
  const cls = classificationOf(policy, field);
  return cls ? policy.classifications?.[cls] ?? null : null;
}

export function isRegulatory(policy, field) {
  return classificationMeta(policy, field)?.forced === true;
}

export function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object') throw new GateError('policy is not an object', 1);
  if (!policy.classifications || typeof policy.classifications !== 'object') {
    throw new GateError('policy.classifications missing', 1);
  }
  for (const [field, meta] of Object.entries(policy.fields ?? {})) {
    const cls = meta?.classification;
    if (!cls || !policy.classifications[cls]) {
      throw new GateError(`unknown classification '${cls}' for field '${field}'`, EXIT_UNKNOWN_CLASSIFICATION);
    }
  }
}

export function validateReportFields(policy, reportId, fields) {
  for (const field of Object.keys(fields)) {
    const cls = classificationOf(policy, field);
    if (!cls || !policy.classifications[cls]) {
      throw new GateError(
        `unknown classification for field '${field}' in report '${reportId}'`,
        EXIT_UNKNOWN_CLASSIFICATION,
      );
    }
  }
}

export function inheritanceChain(policy, audienceId) {
  const principal = policy.principals?.[audienceId];
  if (!principal) throw new GateError(`unknown audience '${audienceId}'`, 1);
  const chain = [{ level: principal.kind, id: audienceId }];
  if (principal.kind === 'individual') {
    chain.push({ level: 'role', id: principal.role });
    const role = policy.principals?.[principal.role];
    if (role?.org) chain.push({ level: 'org', id: role.org });
  } else if (principal.kind === 'role') {
    if (principal.org) chain.push({ level: 'org', id: principal.org });
  }
  return chain;
}

// Returns the inheritance path (audience -> ... -> grant source) that authorizes
// `field` for `audienceId`, or null when no sufficient grant exists. A grant is
// sufficient only when its level is at least as specific as the classification's
// minLevel (classification labels can force escalation, e.g. recipe requires an
// individual-level grant). Forced (regulatory) classifications are always
// authorized.
export function authorizationPath(policy, audienceId, field) {
  const meta = classificationMeta(policy, field);
  if (!meta) return null;
  if (meta.forced === true) return [`classification:${classificationOf(policy, field)}(forced)`];
  const minLevel = meta.minLevel ?? 'org';
  const chain = inheritanceChain(policy, audienceId);
  const walked = [];
  for (const node of chain) {
    walked.push(`${node.level}:${node.id}`);
    const granted = policy.grants?.[node.level]?.[node.id] ?? [];
    if (granted.includes(field) && LEVELS[node.level] >= LEVELS[minLevel]) {
      return walked;
    }
  }
  return null;
}
