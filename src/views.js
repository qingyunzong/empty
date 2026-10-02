'use strict';

const { isRegulatory, hasLabel } = require('./policy');
const { authorizeField } = require('./authorize');
const { isRevoked } = require('./redactions');

// Compute one principal's view of a report.
// - revoked fields are omitted entirely (new views must not contain them)
// - denied pii-labelled fields are kept as null (personal-info boundary)
// - other denied fields are omitted
function computeView(policy, report, principal, revoked) {
  const fields = {};
  const omitted = [];
  const nulled = [];
  const details = {};
  for (const [field, value] of Object.entries(report.fields || {})) {
    if (isRevoked(revoked, principal, field)) {
      omitted.push(field);
      details[field] = { field, revoked: true, visible: false, path: [] };
      continue;
    }
    const auth = authorizeField(policy, principal, field);
    details[field] = auth;
    if (auth.visible) {
      fields[field] = value;
    } else if (hasLabel(policy, field, 'pii')) {
      fields[field] = null;
      nulled.push(field);
    } else {
      omitted.push(field);
    }
  }
  return {
    view: principal,
    report: report.id,
    fields,
    omitted: omitted.sort(),
    nulled: nulled.sort(),
    details,
  };
}

// Shared view: supplier and HQ views conflict -> intersection,
// except regulatory fields which are force-visible.
function computeSharedView(policy, report, viewA, viewB, nameA, nameB) {
  const valued = (v) =>
    new Set(Object.keys(v.fields).filter((f) => v.fields[f] !== null && v.fields[f] !== undefined));
  const a = valued(viewA);
  const b = valued(viewB);
  const fields = {};
  const details = {};
  for (const field of [...a].filter((f) => b.has(f)).sort()) {
    fields[field] = report.fields[field];
    details[field] = {
      field,
      visible: true,
      shared: true,
      regulatory: false,
      path: [`intersection:${nameA}+${nameB}`],
    };
  }
  for (const field of Object.keys(report.fields || {})) {
    if (isRegulatory(policy, field) && !(field in fields)) {
      fields[field] = report.fields[field];
      details[field] = {
        field,
        visible: true,
        shared: true,
        regulatory: true,
        path: ['regulatory-override'],
      };
    } else if (field in fields && isRegulatory(policy, field)) {
      details[field].regulatory = true;
    }
  }
  return {
    view: 'shared',
    report: report.id,
    members: [nameA, nameB],
    fields,
    omitted: [],
    nulled: [],
    details,
  };
}

module.exports = { computeView, computeSharedView };
