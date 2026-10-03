// Independent invariant audit over a state directory.
// Checks (over the journal, after recovery+validation):
//   single-active-lease      : a new holder is never granted while the
//                              previous holder's lease is still live
//   epoch-monotonic          : grant epochs never regress per task
//   no-claim-after-isolation : no accepted claim from a left/quarantined member

import { Store } from './persist.js';

export function audit(dir) {
  const store = Store.init(dir);
  const scheduler = store.load(); // recover + validate (throws PersistenceError)
  const ops = store.readJournal();
  const violations = [];

  const perTask = new Map();
  const memberStatus = new Map();
  for (const op of ops) {
    const ev = op.ev ?? {};
    if (ev.type === 'join') memberStatus.set(ev.agv, 'active');
    else if (ev.type === 'leave') memberStatus.set(ev.agv, 'left');
    else if (ev.type === 'quarantine') memberStatus.set(ev.agv, 'quarantined');
    if (ev.type === 'claim' && (memberStatus.get(ev.agv) ?? 'active') !== 'active') {
      violations.push({ type: 'claim-after-isolation', agv: ev.agv, task: ev.task, seq: op.seq });
    }
    const rec = op.lease;
    if (!rec) continue;
    let cur = perTask.get(rec.task) ?? { active: false, holder: null, expiry: 0, maxEpoch: 0 };
    if (rec.status === 'active') {
      if (cur.active && cur.holder !== rec.holder && (rec.ts ?? 0) < cur.expiry) {
        violations.push({
          type: 'double-ownership',
          task: rec.task,
          holders: [cur.holder, rec.holder],
          previousExpiry: cur.expiry,
          ts: rec.ts ?? 0,
          seq: op.seq,
        });
      }
      if (rec.epoch < cur.maxEpoch) {
        violations.push({ type: 'epoch-regression', task: rec.task, epoch: rec.epoch, maxEpoch: cur.maxEpoch, seq: op.seq });
      }
      cur = { active: true, holder: rec.holder, expiry: rec.expiry, maxEpoch: Math.max(cur.maxEpoch, rec.epoch) };
    } else {
      cur.active = false;
      cur.holder = rec.status === 'completed' ? rec.holder : null;
      cur.maxEpoch = Math.max(cur.maxEpoch, rec.epoch);
    }
    perTask.set(rec.task, cur);
  }

  const has = (type) => violations.some((v) => v.type === type);
  const report = [
    { check: 'single-active-lease', ok: !has('double-ownership') },
    { check: 'epoch-monotonic', ok: !has('epoch-regression') },
    { check: 'no-claim-after-isolation', ok: !has('claim-after-isolation') },
  ];
  return { ok: violations.length === 0, violations, report, summary: scheduler.summary() };
}
