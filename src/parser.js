export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

const REQUIRED_FIELDS = ['node', 'clock', 'seq', 'op', 'key'];
const KNOWN_OPS = new Set(['commit', 'mask', 'rollback']);

// Turns EVENT tokens into validated event records:
//   { id, node, clock, seq, op, key, value, line }
// Rejects missing clocks and duplicate (node, clock) / (node, seq) pairs so
// that each event can take effect exactly once.
export function parse(tokens) {
  const events = [];
  const notes = [];
  const seenClocks = new Set(); // "node@clock"
  const seenSeqs = new Set(); //   "node#seq"

  for (const token of tokens) {
    if (token.type === 'NOTE') {
      notes.push({ text: token.text, line: token.line });
      continue;
    }
    const fields = token.fields;
    for (const name of REQUIRED_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(fields, name)) {
        throw new ParseError(`line ${token.line}: missing ${name}`);
      }
    }
    const clock = Number(fields.clock);
    if (!Number.isInteger(clock) || clock < 0) {
      throw new ParseError(`line ${token.line}: clock must be a non-negative integer, got "${fields.clock}"`);
    }
    const seq = Number(fields.seq);
    if (!Number.isInteger(seq) || seq < 0) {
      throw new ParseError(`line ${token.line}: seq must be a non-negative integer, got "${fields.seq}"`);
    }
    if (!KNOWN_OPS.has(fields.op)) {
      throw new ParseError(`line ${token.line}: unknown op "${fields.op}" (expected commit|mask|rollback)`);
    }
    if (fields.op === 'commit' && !Object.prototype.hasOwnProperty.call(fields, 'value')) {
      throw new ParseError(`line ${token.line}: commit requires a value`);
    }

    const clockKey = `${fields.node}@${clock}`;
    if (seenClocks.has(clockKey)) {
      throw new ParseError(`line ${token.line}: duplicate event: node "${fields.node}" already has clock ${clock}`);
    }
    const seqKey = `${fields.node}#${seq}`;
    if (seenSeqs.has(seqKey)) {
      throw new ParseError(`line ${token.line}: duplicate event: node "${fields.node}" already has seq ${seq}`);
    }
    seenClocks.add(clockKey);
    seenSeqs.add(seqKey);

    events.push({
      id: `${fields.node}#${seq}@${clock}`,
      node: fields.node,
      clock,
      seq,
      op: fields.op,
      key: fields.key,
      value: Object.prototype.hasOwnProperty.call(fields, 'value') ? fields.value : null,
      line: token.line,
    });
  }
  return { events, notes };
}
