import { UnknownMemberError, ConflictError } from './errors.js';
import { validateEvent, canonicalOrder, canonicalJSON, isDataKind } from './event.js';
import { clockLeq, clockMerge } from './clock.js';

function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

// Deterministic full replay of an event SET. The result is a pure function of the
// set: delivery order, wall-clock timestamps and duplicate copies never change it.
//
// Membership & fencing rules:
//   - a `join` introduces (member, epoch); epochs must be contiguous from 1;
//   - a `leave` closes an existing (member, epoch);
//   - any non-join event whose member never joins -> UnknownMemberError (exit 4);
//   - a data event (member m, epoch e) is REJECTED (fenced) when:
//       * no accepted join exists for (m, e)                     -> "epoch-not-joined"
//       * a join for m at epoch e' > e is in its causal past     -> "fenced-by-higher-epoch"
//       * a leave for m at epoch e'' >= e is in its causal past  -> "fenced-after-leave"
//     Old events (concurrent with or before the leave/rejoin) stay in history.
//
// Valve state: accepted data events are applied in canonical order (causal order,
// concurrency broken by (epoch, id) ascending). A concurrent tombstone (unbypass)
// vs resurrection (bypass) at the same logical moment is therefore decided by
// member epoch, then causality, then id - never by timestamp, never randomly.
export function replay(events) {
  const byId = new Map();
  for (const raw of events) {
    const e = validateEvent(raw);
    const prev = byId.get(e.id);
    if (prev) {
      if (canonicalJSON(prev) !== canonicalJSON(e)) throw new ConflictError(e.id);
      continue;
    }
    byId.set(e.id, e);
  }
  const all = [...byId.values()];

  const membersWithJoin = new Set(all.filter((e) => e.kind === 'join').map((e) => e.member));
  for (const e of all) {
    if (e.kind !== 'join' && !membersWithJoin.has(e.member)) {
      throw new UnknownMemberError(e.member, e.id);
    }
  }

  const rejected = [];
  const accepted = [];
  const joinsByMember = new Map(); // member -> Map(epoch -> event)
  const leavesByMember = new Map(); // member -> [event]

  for (const [member, joins] of groupBy(all.filter((e) => e.kind === 'join'), (e) => e.member)) {
    const byEpoch = groupBy(joins, (e) => e.epoch);
    const acceptedEpochs = new Map();
    let expected = 1;
    for (const epoch of [...byEpoch.keys()].sort((a, b) => a - b)) {
      const candidates = byEpoch.get(epoch).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (epoch === expected) {
        acceptedEpochs.set(epoch, candidates[0]);
        accepted.push(candidates[0]);
        for (const dup of candidates.slice(1)) rejected.push({ event: dup, reason: 'duplicate-join-epoch' });
        expected += 1;
      } else {
        for (const c of candidates) rejected.push({ event: c, reason: 'non-contiguous-join-epoch' });
      }
    }
    joinsByMember.set(member, acceptedEpochs);
    leavesByMember.set(member, []);
  }

  for (const e of all.filter((x) => x.kind === 'leave')) {
    const joins = joinsByMember.get(e.member);
    if (joins && joins.has(e.epoch)) {
      leavesByMember.get(e.member).push(e);
      accepted.push(e);
    } else {
      rejected.push({ event: e, reason: 'leave-without-join' });
    }
  }

  const acceptedData = [];
  for (const e of all.filter((x) => isDataKind(x.kind))) {
    const joins = joinsByMember.get(e.member);
    if (!joins || !joins.has(e.epoch)) {
      rejected.push({ event: e, reason: 'epoch-not-joined' });
      continue;
    }
    let reason = null;
    for (const [epoch, j] of joins) {
      if (epoch > e.epoch && clockLeq(j.clock, e.clock)) {
        reason = 'fenced-by-higher-epoch';
        break;
      }
    }
    if (!reason) {
      for (const l of leavesByMember.get(e.member)) {
        if (l.epoch >= e.epoch && clockLeq(l.clock, e.clock)) {
          reason = 'fenced-after-leave';
          break;
        }
      }
    }
    if (reason) rejected.push({ event: e, reason });
    else acceptedData.push(e);
  }
  accepted.push(...acceptedData);

  const valves = {};
  for (const e of canonicalOrder(acceptedData)) {
    const v = valves[e.valve] ?? { interlocked: false, bypassed: false, lastEvent: null };
    switch (e.kind) {
      case 'interlock':
        v.interlocked = true;
        break;
      case 'bypass':
        v.bypassed = true;
        break;
      case 'unbypass':
        v.bypassed = false;
        break;
      case 'reset':
        v.interlocked = false;
        v.bypassed = false;
        break;
    }
    v.lastEvent = e.id;
    valves[e.valve] = v;
  }
  for (const v of Object.values(valves)) {
    v.status = v.bypassed ? 'BYPASSED' : v.interlocked ? 'INTERLOCKED' : 'NORMAL';
  }

  const members = {};
  for (const [member, joins] of joinsByMember) {
    const epochs = [...joins.keys()].sort((a, b) => a - b);
    const currentEpoch = epochs.length > 0 ? epochs[epochs.length - 1] : null;
    const leftEpochs = leavesByMember.get(member).map((l) => l.epoch).sort((a, b) => a - b);
    members[member] = {
      epochs,
      currentEpoch,
      leftEpochs,
      active: currentEpoch !== null && !leftEpochs.includes(currentEpoch),
    };
  }

  let clock = {};
  for (const e of all) clock = clockMerge(clock, e.clock);

  return { valves, members, accepted, rejected, clock, total: all.length };
}
