import { createHash } from 'node:crypto';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function hashValue(value) {
  return sha256(canonical(value));
}

// Certificate binds: input command log hash, graph version, query hash and
// the hash of every emitted result path's node list.
export function issueCertificate({ querySource, graph, results }) {
  // Deep-copy everything: the certificate must be immutable even if the
  // graph keeps mutating (undo/redo) after issuance.
  const paths = results.map((r) => [...r.ids]);
  const commands = graph.history.map((tx) => tx.map((cmd) => ({ ...cmd })));
  const body = {
    kind: 'lineage-certificate',
    format: 1,
    query: querySource,
    queryHash: hashValue(querySource),
    commands,
    commandsHash: hashValue(commands),
    graphVersion: graph.version,
    results: results.map((r) => ({ type: r.kind, nodes: [...r.ids] })),
    pathHashes: paths.map((p) => hashValue(p)),
  };
  return { ...body, certHash: hashValue(body) };
}

export function verifyCertificate(cert) {
  const errors = [];
  if (!cert || typeof cert !== 'object') {
    return { ok: false, errors: ['certificate is not a JSON object'] };
  }
  const required = ['kind', 'format', 'query', 'queryHash', 'commands', 'commandsHash',
    'graphVersion', 'results', 'pathHashes', 'certHash'];
  for (const key of required) {
    if (!(key in cert)) errors.push(`missing field '${key}'`);
  }
  if (errors.length) return { ok: false, errors };
  if (cert.kind !== 'lineage-certificate') errors.push(`bad kind '${cert.kind}'`);

  const { certHash, ...body } = cert;
  if (hashValue(body) !== certHash) errors.push('certHash mismatch (certificate body tampered)');
  if (hashValue(cert.query) !== cert.queryHash) errors.push('queryHash mismatch');
  if (hashValue(cert.commands) !== cert.commandsHash) errors.push('commandsHash mismatch');
  if (!Array.isArray(cert.results) || !Array.isArray(cert.pathHashes) ||
      cert.results.length !== cert.pathHashes.length) {
    errors.push('results/pathHashes shape mismatch');
  } else {
    cert.results.forEach((r, i) => {
      if (hashValue(r.nodes) !== cert.pathHashes[i]) {
        errors.push(`path ${i} node hash mismatch (path tampered)`);
      }
    });
  }
  return { ok: errors.length === 0, errors };
}
