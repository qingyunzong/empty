'use strict';

const { sealed } = require('./errors');

// Sealed days are immutable. A late ledger entry for a sealed day is rejected
// with SEALED unless it forms a valid `supersedes` link: it must reference an
// existing entry id in the same account+day that has not been superseded yet.
class SealRegistry {
  constructor() {
    this.sealedDays = new Set(); // "accountId|day"
    this.entries = new Map();    // id -> entry (known ledger entries)
    this.supersededBy = new Map(); // old id -> new id
  }

  key(accountId, day) { return `${accountId}|${day}`; }

  seal(accountId, day) {
    this.sealedDays.add(this.key(accountId, day));
  }

  isSealed(accountId, day) {
    return this.sealedDays.has(this.key(accountId, day));
  }

  register(entry) {
    this.entries.set(entry.id, entry);
  }

  // Throws SEALED or returns { superseded } describing the accepted chain link.
  admitLate(entry) {
    const { accountId, day } = entry;
    if (!this.isSealed(accountId, day)) return { superseded: null };
    if (typeof entry.supersedes !== 'string') {
      throw sealed(`day ${day} for account ${accountId} is sealed; late entry ${entry.id} rejected`, {
        accountId, day, id: entry.id,
      });
    }
    const target = this.entries.get(entry.supersedes);
    if (!target) {
      throw sealed(`supersedes target ${entry.supersedes} not found`, { id: entry.id });
    }
    if (target.accountId !== accountId || target.day !== day) {
      throw sealed(`supersedes target ${target.id} is in a different account/day`, {
        id: entry.id, target: target.id,
      });
    }
    if (this.supersededBy.has(target.id)) {
      throw sealed(`entry ${target.id} already superseded by ${this.supersededBy.get(target.id)}`, {
        id: entry.id, target: target.id,
      });
    }
    this.supersededBy.set(target.id, entry.id);
    this.entries.set(entry.id, entry);
    return { superseded: target };
  }
}

module.exports = { SealRegistry };
