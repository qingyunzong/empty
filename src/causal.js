// Causal lane-occupancy verification for concurrent shuttles.
//
// Happens-before is built from:
//   - explicit causal edges: event.after = [ids]
//   - per-shuttle program order (a shuttle's events are totally ordered)
//
// An enter on a lane is admitted only when every other enter on that lane is
// causally ordered with it and, if ordered before it, has a matching exit
// that also happens-before it. Concurrent or unreleased occupants keep the
// move pending with a resolvable condition (waitFor). Lanes whose state is
// unknown or undeclared never block.

export function verifyEvents({ lanes = [], events = [] }) {
  const laneState = new Map(lanes.map((l) => [l.id, l.state ?? 'unknown']));
  const preds = new Map(events.map((e) => [e.id, new Set(e.after ?? [])]));

  const byShuttle = new Map();
  for (const e of events) {
    if (!byShuttle.has(e.shuttle)) byShuttle.set(e.shuttle, []);
    byShuttle.get(e.shuttle).push(e);
  }
  for (const list of byShuttle.values()) {
    for (let i = 1; i < list.length; i++) {
      preds.get(list[i].id).add(list[i - 1].id);
    }
  }

  const memo = new Map();
  function happensBefore(a, b) {
    if (a === b) return false;
    const key = `${a} ${b}`;
    if (memo.has(key)) return memo.get(key);
    const seen = new Set();
    const stack = [b];
    let found = false;
    while (stack.length > 0 && !found) {
      const cur = stack.pop();
      for (const p of preds.get(cur) ?? []) {
        if (p === a) {
          found = true;
          break;
        }
        if (!seen.has(p)) {
          seen.add(p);
          stack.push(p);
        }
      }
    }
    memo.set(key, found);
    return found;
  }

  const enters = events.filter((e) => e.op === 'enter');
  const exits = events.filter((e) => e.op === 'exit');
  const decisions = [];

  for (const e of events) {
    if (e.op !== 'enter') continue;
    const waitFor = [];
    let hasConcurrent = false;
    let hasUnreleased = false;

    for (const other of enters) {
      if (other.id === e.id || other.lane !== e.lane) continue;
      if (happensBefore(other.id, e.id)) {
        const released = exits.some((x) => x.of === other.id && happensBefore(x.id, e.id));
        if (!released) {
          waitFor.push(other.id);
          hasUnreleased = true;
        }
      } else if (!happensBefore(e.id, other.id)) {
        waitFor.push(other.id);
        hasConcurrent = true;
      }
    }
    waitFor.sort();

    const state = laneState.get(e.lane);
    if (state === 'occupied') {
      decisions.push({
        type: 'decision',
        id: e.id,
        lane: e.lane,
        verdict: 'pending',
        waitFor,
        reason: 'lane-occupied-external',
      });
    } else if (waitFor.length > 0) {
      decisions.push({
        type: 'decision',
        id: e.id,
        lane: e.lane,
        verdict: 'pending',
        waitFor,
        reason: hasConcurrent ? 'concurrent-occupant' : 'occupant-unreleased',
      });
    } else {
      decisions.push({ type: 'decision', id: e.id, lane: e.lane, verdict: 'admitted' });
    }
  }

  return decisions;
}
