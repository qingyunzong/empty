import { sha256, stableStringify } from './json.js';
import { authorizationPath, classificationMeta } from './policy.js';
import { isRevoked } from './redactions.js';

// Decides how one field of one report appears to one audience.
// Returns { kind: 'value' | 'null' | 'absent', value?, path? }.
export function visibleEntry(policy, redactions, audienceId, field, value) {
  if (isRevoked(redactions, audienceId, field)) return { kind: 'absent' };
  const meta = classificationMeta(policy, field);
  if (meta?.forced === true) return { kind: 'value', value, path: [`classification:forced`] };
  const path = authorizationPath(policy, audienceId, field);
  if (path) return { kind: 'value', value, path };
  if (meta?.boundary === 'null') return { kind: 'null' };
  return { kind: 'absent' };
}

export function computeView(policy, redactions, audienceId, reportFields) {
  const fields = {};
  const auth = {};
  for (const [field, value] of Object.entries(reportFields)) {
    const entry = visibleEntry(policy, redactions, audienceId, field, value);
    if (entry.kind === 'value') {
      fields[field] = value;
      if (entry.path) auth[field] = entry.path;
    } else if (entry.kind === 'null') {
      fields[field] = null;
    }
  }
  return { fields, auth };
}

// Joint view shared to several audiences (e.g. supplier + hq): conflicting
// visibility resolves to the intersection, except regulatory (forced) fields
// which stay visible.
export function computeJointView(policy, redactions, audienceIds, reportFields) {
  const perAudience = audienceIds.map((audienceId) => {
    const entries = {};
    for (const [field, value] of Object.entries(reportFields)) {
      entries[field] = visibleEntry(policy, redactions, audienceId, field, value);
    }
    return entries;
  });
  const fields = {};
  for (const [field, value] of Object.entries(reportFields)) {
    if (classificationMeta(policy, field)?.forced === true) {
      fields[field] = value;
      continue;
    }
    const kinds = perAudience.map((entries) => entries[field].kind);
    if (kinds.every((kind) => kind === 'value')) fields[field] = value;
    else if (kinds.every((kind) => kind === 'null')) fields[field] = null;
  }
  return { fields };
}

export function hashView(reportId, audience, fields) {
  return sha256(stableStringify({ reportId, audience, fields }));
}

export function hashReportFields(fields) {
  return sha256(stableStringify(fields));
}

export function viewFileName(reportId, audience, hash) {
  return `${reportId}.${audience}.${hash.slice(0, 12)}.view.json`;
}

// A view file stays verifiable even after it is marked expired, because the
// hash covers only {reportId, audience, fields}.
export function verifyViewFile(viewFile) {
  if (!viewFile || typeof viewFile !== 'object') return false;
  const { reportId, audience, fields, hash } = viewFile;
  if (typeof reportId !== 'string' || typeof audience !== 'string') return false;
  if (typeof hash !== 'string' || !fields || typeof fields !== 'object') return false;
  return hashView(reportId, audience, fields) === hash;
}
