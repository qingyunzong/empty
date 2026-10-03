import { stableStringify, sha256hex } from './canon.js';

const GENESIS = '0'.repeat(64);

// Hash-chained audit log. auditRoot = sha256(prevRoot || ':' || canonical(entry)).
export class AuditLog {
  constructor() {
    this.entries = [];
    this.root = GENESIS;
  }

  append(entry) {
    const canonical = stableStringify(entry);
    this.root = sha256hex(this.root + ':' + canonical);
    this.entries.push({ ...entry, hash: this.root });
    return this.root;
  }

  get auditRoot() {
    return this.root;
  }
}
