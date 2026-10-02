'use strict';

// Stateful verification session: revocation of evidence with undo/redo.
// Revoking an evidence invalidates every claim whose transitive dependency
// closure contains it. Any new operation clears the redo stack.

const { verifyDocument } = require('./cert');

class Session {
  constructor(doc, key) {
    this.doc = doc;
    this.key = key;
    this.revoked = new Set();
    this.history = [];
    this.redoStack = [];
  }

  evidenceNames() {
    return this.doc.commits.filter((c) => c.kind === 'evidence').map((c) => c.id);
  }

  revoke(name) {
    if (!this.evidenceNames().includes(name)) {
      throw new Error(`cannot revoke '${name}': not a declared evidence`);
    }
    this.applyOp({ op: 'revoke', name });
    this.history.push({ op: 'revoke', name });
    this.redoStack = [];
  }

  applyOp(operation) {
    if (operation.op === 'revoke') this.revoked.add(operation.name);
    else throw new Error(`unknown operation ${operation.op}`);
  }

  revertOp(operation) {
    if (operation.op === 'revoke') this.revoked.delete(operation.name);
    else throw new Error(`unknown operation ${operation.op}`);
  }

  undo() {
    const operation = this.history.pop();
    if (!operation) throw new Error('nothing to undo');
    this.revertOp(operation);
    this.redoStack.push(operation);
  }

  redo() {
    const operation = this.redoStack.pop();
    if (!operation) throw new Error('nothing to redo');
    this.applyOp(operation);
    this.history.push(operation);
  }

  // Full recursive verification: certificates, parent links, static types,
  // then claim validity under the current revocation set.
  verdict() {
    const commits = verifyDocument(this.doc, this.key);
    const claims = {};
    let valid = true;
    for (const commit of commits) {
      if (commit.kind !== 'claim') continue;
      const missingEvidence = commit.deps.filter((dep) => this.revoked.has(dep));
      const claimValid = missingEvidence.length === 0;
      claims[commit.id] = {
        valid: claimValid,
        deps: commit.deps.slice(),
        revokedDeps: missingEvidence,
      };
      if (!claimValid) valid = false;
    }
    return { valid, revoked: [...this.revoked].sort(), claims };
  }
}

module.exports = { Session };
