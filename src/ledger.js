'use strict';

const crypto = require('node:crypto');
const { CheckError, EVIDENCE, RULE, CLAIM, typeCheckCanonical } = require('./term');

class LedgerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LedgerError';
  }
}

const GENESIS = '0'.repeat(64);

function sha256hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function hmacSha256(key, text) {
  return crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex');
}

function certPayload(commit) {
  return [commit.parent, commit.scopeHash, commit.id, commit.type, commit.term].join('\n');
}

// Hash of all alias bindings visible from this scope (root to leaf).
function scopeHash(scope) {
  const chain = [];
  for (let s = scope; s; s = s.parent) chain.unshift(s);
  const bindings = {};
  for (const s of chain) {
    for (const [name, alias] of s.aliases) bindings[name] = alias.value.canon;
  }
  return sha256hex(JSON.stringify(bindings));
}

class Ledger {
  constructor(key) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new LedgerError('an HMAC key string is required');
    }
    this.key = key;
    this.commits = [];
    this.symbols = new Map();
    this.revoked = new Set();
    this.history = [];
    this.redoStack = [];
  }

  commit(id, type, canon, deps, scopeHashValue) {
    if (this.symbols.has(id)) throw new LedgerError(`duplicate declaration of "${id}"`);
    const parent = this.commits.length === 0
      ? GENESIS
      : this.commits[this.commits.length - 1].cert;
    const commit = { id, type, term: canon, parent, scopeHash: scopeHashValue, cert: '' };
    commit.cert = hmacSha256(this.key, certPayload(commit));
    this.commits.push(commit);
    this.symbols.set(id, { type, canon, deps: new Set(deps) });
    return commit;
  }

  revoke(name) {
    const sym = this.symbols.get(name);
    if (!sym) throw new LedgerError(`cannot revoke unknown evidence "${name}"`);
    if (sym.type !== EVIDENCE) {
      throw new LedgerError(`only evidence can be revoked, "${name}" is a ${sym.type}`);
    }
    this.revoked.add(name);
    this.history.push({ op: 'revoke', name });
    this.redoStack = [];
  }

  undo() {
    const op = this.history.pop();
    if (!op) throw new LedgerError('nothing to undo');
    this.redoStack.push(op);
    this.recomputeRevoked();
  }

  redo() {
    const op = this.redoStack.pop();
    if (!op) throw new LedgerError('nothing to redo');
    this.history.push(op);
    this.recomputeRevoked();
  }

  recomputeRevoked() {
    this.revoked = new Set();
    for (const op of this.history) {
      if (op.op === 'revoke') this.revoked.add(op.name);
    }
  }

  verdict() {
    const claims = {};
    let ok = true;
    for (const [id, sym] of this.symbols) {
      if (sym.type !== CLAIM) continue;
      const revokedDependencies = [...sym.deps].filter((d) => this.revoked.has(d)).sort();
      const valid = revokedDependencies.length === 0;
      if (!valid) ok = false;
      claims[id] = {
        valid,
        dependencies: [...sym.deps].sort(),
        revokedDependencies,
      };
    }
    return {
      ok,
      revoked: [...this.revoked].sort(),
      claims,
      commits: this.commits,
    };
  }
}

// Recursively verify parent certificates, types and HMAC signatures.
function verifyChain(commits, key) {
  if (!Array.isArray(commits)) throw new LedgerError('ledger commits must be an array');
  const symbols = new Map();
  function verifyAt(index) {
    if (index < 0) return GENESIS;
    const parentCert = verifyAt(index - 1);
    const c = commits[index];
    if (!c || typeof c !== 'object') {
      throw new LedgerError(`commit #${index + 1} is malformed`);
    }
    for (const field of ['id', 'type', 'term', 'parent', 'scopeHash', 'cert']) {
      if (typeof c[field] !== 'string') {
        throw new LedgerError(`commit #${index + 1} is missing field "${field}"`);
      }
    }
    if (c.parent !== parentCert) {
      throw new LedgerError(`commit "${c.id}": parent certificate mismatch`);
    }
    const expected = hmacSha256(key, certPayload(c));
    if (expected !== c.cert) {
      throw new LedgerError(`commit "${c.id}": signature mismatch`);
    }
    if (symbols.has(c.id)) {
      throw new LedgerError(`duplicate declaration of "${c.id}"`);
    }
    let checked;
    if ((c.type === EVIDENCE || c.type === RULE) && c.term === c.id) {
      // Declaration commit: the term is the identifier itself.
      checked = c.type === EVIDENCE
        ? { type: EVIDENCE, deps: new Set([c.id]) }
        : { type: RULE, deps: new Set() };
    } else {
      try {
        checked = typeCheckCanonical(c.term, symbols);
      } catch (err) {
        if (err instanceof CheckError) {
          throw new LedgerError(`commit "${c.id}": ${err.message}`);
        }
        throw err;
      }
    }
    if (checked.type !== c.type) {
      throw new LedgerError(
        `commit "${c.id}": declared type ${c.type} does not match term type ${checked.type}`,
      );
    }
    symbols.set(c.id, { type: checked.type, deps: checked.deps });
    return c.cert;
  }
  verifyAt(commits.length - 1);
  return symbols;
}

module.exports = {
  LedgerError, Ledger, verifyChain, scopeHash, hmacSha256, sha256hex, GENESIS,
};
