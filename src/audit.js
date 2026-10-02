import { replay } from './scheduler.js';

// Re-runs the event log and independently shadows every grant/renew/takeover
// decision to verify the safety invariants. Optionally cross-checks the final
// replayed state against a persisted lease store.
export function audit(events, storeState = null) {
  const scheduler = replay(events);
  const violations = [];
  let checks = 0;

  const ownerOf = new Map(); // task -> { agv, expiry }
  const fencingOf = new Map(); // task -> epoch
  const memberStatus = new Map(); // agv -> status

  for (const d of scheduler.decisions) {
    if (d.event === 'join' || d.event === 'release') memberStatus.set(d.agv, 'active');
    else if (d.event === 'leave') {
      memberStatus.set(d.agv, 'left');
      for (const [task, o] of ownerOf) if (o.agv === d.agv) ownerOf.delete(task);
    } else if (d.event === 'quarantine') memberStatus.set(d.agv, 'quarantined');

    if (d.result === 'granted' || d.result === 'takeover' || d.result === 'renewed') {
      checks += 1;
      const cur = ownerOf.get(d.task);
      if (cur && cur.agv !== d.agv && d.time !== null && d.time <= cur.expiry) {
        violations.push({
          invariant: 'no-double-ownership', task: d.task, holder: cur.agv,
          intruder: d.agv, time: d.time, holderExpiry: cur.expiry,
        });
      }
      const f = fencingOf.get(d.task) ?? 0;
      if (d.result === 'renewed' ? d.epoch < f : d.epoch <= f) {
        violations.push({ invariant: 'fencing-monotonic', task: d.task, epoch: d.epoch, fencing: f });
      }
      if (memberStatus.get(d.agv) !== 'active') {
        violations.push({ invariant: 'member-active', task: d.task, agv: d.agv });
      }
      fencingOf.set(d.task, Math.max(f, d.epoch ?? 0));
      ownerOf.set(d.task, { agv: d.agv, expiry: d.leaseExpiry ?? 0 });
    }
    if (d.result === 'contested' || d.result === 'completed') ownerOf.delete(d.task);
  }

  if (storeState) {
    const snap = scheduler.snapshot();
    for (const t of snap.tasks) {
      const lease = storeState.leases[t.task];
      if (!lease) continue;
      checks += 1;
      if (t.status !== 'claimed' || t.owner !== lease.owner || t.fencingEpoch !== lease.epoch) {
        violations.push({
          invariant: 'store-matches-replay', task: t.task,
          store: { owner: lease.owner, epoch: lease.epoch },
          replay: { status: t.status, owner: t.owner, epoch: t.fencingEpoch },
        });
      }
    }
    for (const [task, lease] of Object.entries(storeState.leases)) {
      if ((storeState.fencing[task] ?? 0) < lease.epoch) {
        violations.push({ invariant: 'fencing-monotonic', task, epoch: lease.epoch });
      }
    }
  }

  return { ok: violations.length === 0, violations, checks, scheduler };
}
