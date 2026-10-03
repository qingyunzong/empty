// Finite-domain propagation over the genealogy problem.
//
// Domains: for every (batch, candidate parent) pair the input quantity is an
// integer in [lb, ub]. Propagation tightens those bounds using three rules:
//   - quarantine closure: a quarantined lot may not be used directly or
//     indirectly; a batch that cannot meet its required input from clean
//     parents is itself blocked, and the blockage propagates downstream;
//   - expiry order: a parent expiring before the batch cannot be used;
//   - mass balance / supply: sum of inputs = output + loss, and no parent
//     lot may be consumed beyond its available quantity.
// A contradiction is returned as a conflict proof naming the batches and
// constraints involved, with the full derivation chain.
export function propagate(store) {
  const required = new Map();
  const available = new Map();
  const expiryMs = new Map();
  for (const [id, m] of store.materials) {
    available.set(id, m.quantity);
    expiryMs.set(id, m.expiryMs);
  }
  for (const [id, b] of store.batches) {
    required.set(id, b.output + b.loss);
    available.set(id, b.output);
    expiryMs.set(id, b.expiryMs);
  }

  const base = { required, available, expiryMs };

  // Constraint: batches on the same line must not overlap in time.
  const byLine = new Map();
  for (const b of store.batches.values()) {
    if (!byLine.has(b.line)) byLine.set(b.line, []);
    byLine.get(b.line).push(b);
  }
  for (const [line, list] of byLine) {
    const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      if (curr.startMs < prev.endMs) {
        return {
          ...base,
          ok: false,
          blocked: new Map(),
          domains: new Map(),
          conflict: {
            constraints: ['line-no-overlap'],
            batches: [prev.id, curr.id],
            chain: [
              { batch: prev.id, line, start: prev.start, end: prev.end },
              { batch: curr.id, line, start: curr.start, end: curr.end },
            ],
          },
        };
      }
    }
  }

  // Quarantine / producibility closure. `blocked` maps an id to the reason
  // it cannot be used or produced cleanly.
  const blocked = new Map();
  for (const [id, m] of store.materials) {
    if (m.status === 'quarantined') blocked.set(id, { rule: 'quarantined' });
  }
  for (const [id, b] of store.batches) {
    if (b.status === 'quarantined' && !blocked.has(id)) {
      blocked.set(id, { rule: 'quarantined' });
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, b] of store.batches) {
      if (blocked.has(id)) continue;
      const need = required.get(id);
      let cleanSupply = 0;
      const blockedParents = [];
      const expiryBlocked = [];
      for (const p of b.candidates) {
        if (blocked.has(p)) {
          blockedParents.push(p);
        } else if (expiryMs.get(p) < expiryMs.get(id)) {
          expiryBlocked.push(p);
        } else {
          cleanSupply += Math.min(available.get(p), need);
        }
      }
      if (cleanSupply < need) {
        blocked.set(id, {
          rule: 'insufficient-clean-supply',
          needed: need,
          cleanSupply,
          blockedParents,
          expiryBlocked,
        });
        changed = true;
      }
    }
  }

  const blockedBatches = [...store.batches.keys()].filter((id) => blocked.has(id));
  if (blockedBatches.length > 0) {
    const seen = new Set();
    const chain = [];
    const constraints = new Set(['mass-balance']);
    const walk = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      const reason = blocked.get(id);
      if (reason.rule === 'quarantined') {
        constraints.add('quarantine-closure');
        chain.push({ batch: id, rule: 'quarantined' });
        return;
      }
      for (const p of reason.blockedParents) walk(p);
      if (reason.blockedParents.length > 0) constraints.add('quarantine-closure');
      if (reason.expiryBlocked.length > 0) constraints.add('expiry-order');
      chain.push({
        batch: id,
        rule: reason.rule,
        needed: reason.needed,
        cleanSupply: reason.cleanSupply,
        blockedParents: reason.blockedParents,
        expiryBlocked: reason.expiryBlocked,
      });
    };
    // Walk every blocked batch so the proof covers the full chain from the
    // quarantined source through every downstream layer it contaminates.
    for (const id of blockedBatches) walk(id);
    return {
      ...base,
      ok: false,
      blocked,
      domains: new Map(),
      conflict: { constraints: [...constraints], batches: [...seen], chain },
    };
  }

  // Finite domains: quantity bounds per (batch, candidate parent).
  const domains = new Map();
  for (const [id, b] of store.batches) {
    const need = required.get(id);
    const dom = new Map();
    for (const p of b.candidates) {
      const usable = !blocked.has(p) && expiryMs.get(p) >= expiryMs.get(id);
      dom.set(p, { lb: 0, ub: usable ? Math.min(available.get(p), need) : 0 });
    }
    let sumUb = 0;
    for (const e of dom.values()) sumUb += e.ub;
    for (const e of dom.values()) {
      e.lb = Math.max(0, need - (sumUb - e.ub));
    }
    domains.set(id, dom);
  }

  // Supply consistency: forced consumption must not exceed availability.
  const forcedUse = new Map();
  for (const dom of domains.values()) {
    for (const [p, e] of dom) {
      forcedUse.set(p, (forcedUse.get(p) ?? 0) + e.lb);
    }
  }
  for (const [p, use] of forcedUse) {
    if (use > (available.get(p) ?? 0)) {
      const consumers = [...domains.entries()]
        .filter(([, dom]) => (dom.get(p)?.lb ?? 0) > 0)
        .map(([id]) => id);
      return {
        ...base,
        ok: false,
        blocked,
        domains,
        conflict: {
          constraints: ['supply-limit', 'mass-balance'],
          batches: [p, ...consumers],
          chain: [{ batch: p, available: available.get(p) ?? 0, forcedDemand: use, consumers }],
        },
      };
    }
  }

  return { ...base, ok: true, blocked, domains, conflict: null };
}
