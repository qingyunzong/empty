import { inValidTime } from './algebra.js';

// Incremental per-account index: one version chain per root id,
// versions appended in txSeq order. asOf lookups binary-search the
// chain heads instead of scanning the whole event log.
export class AccountIndex {
  constructor() {
    this.chains = new Map(); // root -> Event[] (txSeq ascending, append order)
  }

  add(event) {
    const chain = this.chains.get(event.root);
    if (chain) chain.push(event);
    else this.chains.set(event.root, [event]);
  }

  // Latest version of a chain recorded at or before txSeq (binary search).
  headAt(root, txSeq) {
    const chain = this.chains.get(root);
    if (!chain) return null;
    let lo = 0;
    let hi = chain.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (chain[mid].txSeq <= txSeq) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans < 0 ? null : chain[ans];
  }

  visibleAt(validMs, txSeq) {
    const out = [];
    for (const root of this.chains.keys()) {
      const head = this.headAt(root, txSeq);
      if (head && !head.tombstone && inValidTime(head, validMs)) out.push(head);
    }
    return out;
  }
}
