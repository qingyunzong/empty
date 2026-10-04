'use strict';

const { sha256hex, canonicalize } = require('./graph.js');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function edgeHash(version, from, to) {
  return sha256hex('edge|' + version + '|' + from + '|' + to);
}

function reachChainRoot(version, s, t, path) {
  let h = sha256hex('reach|' + version + '|' + s + '|' + t);
  for (let i = 0; i + 1 < path.length; i += 1) {
    h = sha256hex(h + '|' + edgeHash(version, path[i], path[i + 1]));
  }
  return h;
}

function setHash(version, reachableSet) {
  return sha256hex('set|' + version + '|' + reachableSet.join('|'));
}

function boundaryHash(version, boundary) {
  const items = boundary.map((e) => e.from + '->' + e.to).sort();
  return sha256hex('boundary|' + version + '|' + items.join('|'));
}

function proofId(version, kind, s, t, payloadHash) {
  return sha256hex('proof-id|' + version + '|' + kind + '|' + s + '|' + t + '|' + payloadHash);
}

function certHash(certWithoutHash) {
  return sha256hex('cert-v1|' + canonicalize(certWithoutHash));
}

function finalizeCert(certWithoutHash) {
  return { ...certWithoutHash, cert_hash: certHash(certWithoutHash) };
}

function checkIntegrity(proof) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return false;
  if (typeof proof.cert_hash !== 'string') return false;
  const { cert_hash: claimed, ...rest } = proof;
  return claimed === certHash(rest);
}

function makeReachCert(version, s, t, path, now, ttlMs) {
  const edgeHashes = [];
  for (let i = 0; i + 1 < path.length; i += 1) {
    edgeHashes.push(edgeHash(version, path[i], path[i + 1]));
  }
  const chainRoot = reachChainRoot(version, s, t, path);
  return finalizeCert({
    proof_id: proofId(version, 'reach', s, t, chainRoot),
    kind: 'reach',
    version,
    s,
    t,
    created_at: now,
    expires_at: now + (ttlMs ?? DEFAULT_TTL_MS),
    path,
    edge_hashes: edgeHashes,
    chain_root: chainRoot,
  });
}

function makeNonreachCert(version, s, t, reachableSet, boundary, now, ttlMs) {
  const sortedSet = [...reachableSet].sort();
  const sortedBoundary = [...boundary]
    .map((e) => ({ from: e.from, to: e.to }))
    .sort((a, b) => (a.from + '->' + a.to).localeCompare(b.from + '->' + b.to));
  const payload = setHash(version, sortedSet) + '|' + boundaryHash(version, sortedBoundary);
  return finalizeCert({
    proof_id: proofId(version, 'nonreach', s, t, payload),
    kind: 'nonreach',
    version,
    s,
    t,
    created_at: now,
    expires_at: now + (ttlMs ?? DEFAULT_TTL_MS),
    reachable_set: sortedSet,
    boundary: sortedBoundary,
    set_hash: setHash(version, sortedSet),
    boundary_hash: boundaryHash(version, sortedBoundary),
  });
}

module.exports = {
  DEFAULT_TTL_MS,
  edgeHash,
  reachChainRoot,
  setHash,
  boundaryHash,
  proofId,
  certHash,
  checkIntegrity,
  makeReachCert,
  makeNonreachCert,
};
