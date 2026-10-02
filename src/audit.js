'use strict';

// Certificate audit: three layers of tamper detection.
//   1. integrity  - recompute the certificate hash (TAMPERED on mismatch)
//   2. replay     - re-derive the decision from the embedded inputs
//                   (REPLAY_MISMATCH if the derivation does not reproduce)
//   3. provenance - cross-check embedded inputs against current lab records
//                   (STATE_DIVERGED if lab state was altered after issuance)

const { evaluate } = require('./certify.js');
const { hashObject, canonical } = require('./hash.js');
const { LabError } = require('./errors.js');

function auditCert(lab, certOrId) {
  let cert = certOrId;
  if (typeof certOrId === 'string') {
    cert = lab.state.certs[certOrId];
    if (!cert) throw new LabError('CERT_NOT_FOUND', `no such certificate: ${certOrId}`);
  }
  if (!cert || typeof cert !== 'object' || !cert.hash || !cert.id || !cert.inputs) {
    throw new LabError('INVALID', 'malformed certificate');
  }
  const { id, hash, ...body } = cert;
  if (hashObject(body) !== hash) {
    return { status: 'TAMPERED', reason: 'HASH_MISMATCH', certId: id };
  }
  if (id !== `CERT-${hash.slice(0, 16)}`) {
    return { status: 'TAMPERED', reason: 'ID_MISMATCH', certId: id };
  }

  const inp = cert.inputs;
  const artifacts = {};
  artifacts[inp.point.id] = { ...inp.point, margin: cert.margin };
  artifacts[inp.uut.id] = inp.uut;
  for (const s of inp.standards) artifacts[s.id] = s;
  const replayLab = {
    state: {
      artifacts,
      links: inp.links.map((l) => ({ ...l })),
      leases: {},
      certs: {},
      measurements: [inp.measurement],
    },
  };
  const r = evaluate(replayLab, cert.pointId, cert.at, { skipCore: true });
  if (r.status !== 'CERT') {
    return { status: 'REPLAY_MISMATCH', reason: `replay decided ${r.status}`, certId: id };
  }
  if (r.cert.combinedUncertainty !== cert.combinedUncertainty) {
    return {
      status: 'REPLAY_MISMATCH',
      reason: 'UNCERTAINTY_MISMATCH',
      expected: cert.combinedUncertainty,
      replayed: r.cert.combinedUncertainty,
      certId: id,
    };
  }
  if (JSON.stringify(r.cert.chain) !== JSON.stringify(cert.chain)) {
    return { status: 'REPLAY_MISMATCH', reason: 'CHAIN_MISMATCH', certId: id };
  }

  const diverged = [];
  for (const a of [inp.point, inp.uut, ...inp.standards]) {
    const cur = lab.state.artifacts[a.id];
    if (!cur || canonical(cur) !== canonical(a)) diverged.push(a.id);
  }
  for (const l of inp.links) {
    if (!lab.state.links.some((x) => x.from === l.from && x.to === l.to)) {
      diverged.push(`link:${l.from}->${l.to}`);
    }
  }
  if (!lab.state.measurements.some((m) => m.id === inp.measurement.id && canonical(m) === canonical(inp.measurement))) {
    diverged.push(`measurement:${inp.measurement.id}`);
  }
  if (diverged.length > 0) return { status: 'STATE_DIVERGED', diverged, certId: id };
  return { status: 'VALID', certId: id };
}

module.exports = { auditCert };
