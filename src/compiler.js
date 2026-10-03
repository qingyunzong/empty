'use strict';

const OPCODES = Object.freeze({
  COMMIT: 0x01,
  MASK: 0x02,
  ROLLBACK: 0x03,
  CONFLICT_CHECK: 0x04,
});

const OP_TO_CODE = Object.freeze({
  commit: OPCODES.COMMIT,
  mask: OPCODES.MASK,
  rollback: OPCODES.ROLLBACK,
});

class CompileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompileError';
  }
}

function idOf(ref) {
  return `${ref.node}@${ref.clock}`;
}

function compile(tokens) {
  const events = tokens.filter((t) => t.kind === 'event');
  const notes = tokens.filter((t) => t.kind === 'note');

  const byId = new Map();
  events.forEach((ev, i) => {
    const id = idOf(ev);
    const prev = byId.get(id);
    if (prev) {
      throw new CompileError(
        `duplicate event ${id}: node "${ev.node}" reuses logical clock ${ev.clock} ` +
          `(lines ${prev.line} and ${ev.line}); each event must be unique`,
      );
    }
    ev.seq = i;
    byId.set(id, ev);
  });

  const edges = [];
  const byNode = new Map();
  for (const ev of events) {
    if (!byNode.has(ev.node)) byNode.set(ev.node, []);
    byNode.get(ev.node).push(ev);
  }
  for (const list of byNode.values()) {
    list.sort((a, b) => a.clock - b.clock);
    for (let i = 1; i < list.length; i++) {
      edges.push({
        from: idOf(list[i - 1]),
        to: idOf(list[i]),
        reason: `same-node clock order on "${list[i].node}" (${list[i - 1].clock} < ${list[i].clock})`,
      });
    }
  }
  for (const ev of events) {
    for (const dep of ev.after) {
      const depId = idOf(dep);
      if (!byId.has(depId)) {
        throw new CompileError(
          `unknown causal dependency ${depId} declared by ${idOf(ev)} on line ${ev.line}`,
        );
      }
      edges.push({ from: depId, to: idOf(ev), reason: 'declared "after" dependency' });
    }
  }

  const code = events.map((ev) => ({
    op: OP_TO_CODE[ev.op],
    id: idOf(ev),
    node: ev.node,
    clock: ev.clock,
    key: ev.key,
    value: ev.value,
    seq: ev.seq,
  }));

  const commitCountByKey = new Map();
  for (const ins of code) {
    if (ins.op === OPCODES.COMMIT) {
      commitCountByKey.set(ins.key, (commitCountByKey.get(ins.key) || 0) + 1);
    }
  }
  for (const [key, count] of commitCountByKey) {
    if (count > 1) code.push({ op: OPCODES.CONFLICT_CHECK, key });
  }

  return { code, edges, notes };
}

module.exports = { compile, OPCODES, CompileError, idOf };
