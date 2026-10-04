'use strict';
const { Terminal } = require('../lib/terminal');
const { encodeFrame } = require('../lib/frame');
const { GENESIS } = require('../lib/log');

let counter = 0;
function nextOpId() {
  return (++counter).toString(16).padStart(32, '0');
}

// Builds frames whose prevHash forms a chain in the given op order, using an
// in-memory terminal as the reference serializer. Per-actor seq is assigned
// automatically unless overridden. Frames the reference rejects (e.g. expired
// leases) are still returned: they never enter the chain, so headHash is
// unaffected and chaining continues.
function chainFrames(ops) {
  const ref = new Terminal(null);
  const seqs = new Map();
  return ops.map((op) => {
    const actor = op.actor || 'A';
    const seq = op.seq !== undefined ? op.seq : (seqs.get(actor) || 0) + 1;
    seqs.set(actor, seq);
    const frame = {
      opId: nextOpId(),
      actor,
      seq,
      ack: 0,
      leaseUntil: 1e9,
      cmd: 'set',
      args: { key: 'k', value: 1 },
      ...op,
      prevHash: ref.log.headHash,
    };
    const events = ref.submit(frame);
    if (!events.some((e) => e.status === 'applied' || e.status === 'rejected')) {
      throw new Error('reference serializer stuck on op: ' + JSON.stringify(events));
    }
    return frame;
  });
}

function hashes(term) {
  return term.log.entries.map((e) => e.hash);
}

module.exports = { chainFrames, hashes, nextOpId, encodeFrame, GENESIS };
