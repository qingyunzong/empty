'use strict';

// HMAC-SHA256 certificates. Each commit is certified over a canonical
// payload containing its normalized term, the parent certificate and the
// scope hash, forming a hash-linked chain.

const crypto = require('node:crypto');
const { parseExpr } = require('./parser');
const { Scope, typeOfExpr } = require('./semantics');

function hmac(key, message) {
  return crypto.createHmac('sha256', key).update(message).digest('hex');
}

// Canonical payload: fixed key order, no whitespace.
function commitPayload(commit) {
  return JSON.stringify({
    id: commit.id,
    kind: commit.kind,
    type: commit.type,
    term: commit.term,
    deps: commit.deps,
    parent: commit.parent,
    scope: commit.scope,
  });
}

function certify(commits, key) {
  let parent = null;
  return commits.map((commit) => {
    const linked = { ...commit, parent };
    const cert = hmac(key, commitPayload(linked));
    parent = cert;
    return { ...linked, cert };
  });
}

function buildDocument(commits, key) {
  return { version: 1, algorithm: 'HMAC-SHA256', commits: certify(commits, key) };
}

function hexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// Recompute the certificate chain and compare against the stored certs.
function verifyCertificates(commits, key) {
  let parent = null;
  for (const commit of commits) {
    if (commit.parent !== parent) {
      throw new Error(`certificate chain broken at commit '${commit.id}': parent link mismatch`);
    }
    const expected = hmac(key, commitPayload(commit));
    if (!hexEqual(expected, commit.cert)) {
      throw new Error(`invalid certificate signature for commit '${commit.id}'`);
    }
    parent = commit.cert;
  }
}

// Re-check the static type of every commit's normalized term against the
// type environment built from the commits themselves.
function verifyTypes(commits) {
  const scope = new Scope(null, '<verify>');
  for (const commit of commits) {
    if (scope.entries.has(commit.id)) {
      throw new Error(`duplicate commit id '${commit.id}'`);
    }
    if (commit.kind === 'evidence' || commit.kind === 'rule') {
      // Atomic commits: the term must be exactly the declared name.
      if (commit.term !== commit.id) {
        throw new Error(`term mismatch for ${commit.kind} commit '${commit.id}'`);
      }
    } else {
      const expr = parseExpr(commit.term);
      const actual = typeOfExpr(expr, scope);
      if (actual !== commit.type) {
        throw new Error(
          `type mismatch for commit '${commit.id}': declared ${commit.type}, term has type ${actual}`,
        );
      }
    }
    scope.declare(commit.id, {
      kind: commit.kind,
      type: commit.type,
      normalized: commit.term,
      deps: commit.deps,
    });
  }
}

function verifyDocument(doc, key) {
  if (!doc || doc.version !== 1 || !Array.isArray(doc.commits)) {
    throw new Error('malformed certificate document');
  }
  verifyCertificates(doc.commits, key);
  verifyTypes(doc.commits);
  return doc.commits;
}

module.exports = { hmac, commitPayload, certify, buildDocument, verifyDocument };
