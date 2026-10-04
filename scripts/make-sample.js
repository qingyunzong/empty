'use strict';

// Generates examples/frames.hex: a realistic offline sync capture with
// fragmentation, duplicate retransmissions and out-of-order delivery.
const fs = require('fs');
const path = require('path');
const { makeEvent, toHexLines, shuffled, eventId } = require('../test/helpers');

const pack1 = makeEvent({ batch: 'B2026-10', item: 'SKU-001', seq: 1, lamport: 1, kind: 'PACK', qty: 48 });
const rework1 = makeEvent({ batch: 'B2026-10', item: 'SKU-001', seq: 2, lamport: 2, kind: 'REWORK', qty: 3 });
const fixPack = makeEvent({
  batch: 'B2026-10', item: 'SKU-001', seq: 3, lamport: 3, kind: 'CORRECT',
  ref: eventId(pack1), qty: 50, reason: 'vision-recount',
});
const pack2 = makeEvent({ batch: 'B2026-10', item: 'SKU-002', seq: 1, lamport: 4, kind: 'PACK', qty: 30 });
const scrap2 = makeEvent({ batch: 'B2026-10', item: 'SKU-002', seq: 2, lamport: 5, kind: 'SCRAP', qty: 30, reason: 'seal-defect' });
const auditFix = makeEvent({
  batch: 'B2026-10', item: 'SKU-002', seq: 3, lamport: 6, kind: 'CORRECT',
  ref: eventId(scrap2), qty: 29, reason: 'audit',
});

const events = [pack1, rework1, fixPack, pack2, scrap2, auditFix];
const lines = shuffled(toHexLines(events, { maxPayload: 48, duplicates: true }));
const out = path.join(__dirname, '..', 'examples', 'frames.hex');
fs.writeFileSync(out, '# packline-trace sample capture (hex frames, one per line)\n' + lines.join('\n') + '\n');
console.log(`wrote ${out} (${lines.length} frames, ${events.length} events)`);
