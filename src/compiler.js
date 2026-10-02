// Arbitration rule (happens-before):
//   a -> b  iff  a.clock < b.clock
// Same-node events are totally ordered by their clocks (duplicates were
// rejected at parse time). Events with equal clocks on different nodes have
// no causal relation: they are concurrent. Concurrent commits to the same
// key with different values are a conflict and are never silently resolved;
// concurrent writes to different keys are ordered deterministically by key
// name (lexicographic), then node, then seq.

function compareEvents(a, b) {
  if (a.clock !== b.clock) return a.clock - b.clock;
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  if (a.node !== b.node) return a.node < b.node ? -1 : 1;
  return a.seq - b.seq;
}

// Transitive reduction of the happens-before relation, for --explain.
// With Lamport-style clocks an edge a->b is redundant when some c satisfies
// a.clock < c.clock < b.clock, so the reduced edges connect adjacent clock
// values only.
export function causalEdges(events) {
  const clocks = [...new Set(events.map((e) => e.clock))].sort((x, y) => x - y);
  const edges = [];
  for (let i = 0; i + 1 < clocks.length; i += 1) {
    const from = events.filter((e) => e.clock === clocks[i]);
    const to = events.filter((e) => e.clock === clocks[i + 1]);
    for (const a of from) {
      for (const b of to) {
        edges.push({ from: a.id, to: b.id, reason: `clock ${a.clock} < ${b.clock}` });
      }
    }
  }
  return edges;
}

// Detect conflicts inside one concurrent (equal-clock) group: commits to the
// same key carrying different values. Same-value duplicates are benign.
function findConflict(group) {
  const byKey = new Map();
  for (const event of group) {
    if (event.op !== 'commit') continue;
    if (!byKey.has(event.key)) byKey.set(event.key, []);
    byKey.get(event.key).push(event);
  }
  for (const [key, commits] of byKey) {
    const values = new Set(commits.map((e) => e.value));
    if (values.size > 1) {
      return {
        kind: 'conflict',
        key,
        clock: commits[0].clock,
        events: commits.map((e) => ({ id: e.id, node: e.node, value: e.value, line: e.line })),
        reason:
          `concurrent commits to key "${key}" at clock ${commits[0].clock} ` +
          `with different values (${[...values].join(', ')}); no causal order exists, refusing to pick one`,
      };
    }
  }
  return null;
}

// Compiles validated events into bytecode for the replay VM.
// Opcodes: COMMIT {key,value} | MASK {key} | ROLLBACK {key} | CONFLICT {certificate}
// The CONFLICT instruction is emitted at the position of the first
// conflicting concurrent group; everything before it is the committed prefix.
export function compile(events) {
  const ordered = [...events].sort(compareEvents);
  const bytecode = [];
  let conflict = null;

  let i = 0;
  while (i < ordered.length) {
    let j = i;
    while (j < ordered.length && ordered[j].clock === ordered[i].clock) j += 1;
    const group = ordered.slice(i, j);

    if (conflict === null) {
      conflict = findConflict(group);
      if (conflict !== null) {
        bytecode.push({ op: 'CONFLICT', certificate: conflict });
        break; // replay halts here; conflicting and later events never enter state
      }
    }

    for (const event of group) {
      if (event.op === 'commit') {
        bytecode.push({ op: 'COMMIT', key: event.key, value: event.value, event: event.id });
      } else if (event.op === 'mask') {
        bytecode.push({ op: 'MASK', key: event.key, event: event.id });
      } else {
        bytecode.push({ op: 'ROLLBACK', key: event.key, event: event.id });
      }
    }
    i = j;
  }

  return { bytecode, order: ordered.map((e) => e.id), edges: causalEdges(events), conflict };
}
