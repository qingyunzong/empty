'use strict';
// Deterministic generator for fixtures/requests.jsonl (50 requests).
const fs = require('fs');
const path = require('path');

const subjects = ['alice', 'bob', 'carol', 'dave'];
const devices = ['press-1', 'press-2', 'oven-1', 'mixer-1'];
const actions = ['open_mold', 'heat_up', 'reset_estop'];
const times = [
  '2026-09-10T10:00:00Z',
  '2026-09-25T10:00:00Z',
  '2026-10-01T03:00:00Z',
  '2026-10-02T12:00:00Z',
];

const combos = [];
// Hand-picked combos covering every acceptance-relevant path.
combos.push(
  ['alice', 'press-1', 'open_mold', '2026-09-10T10:00:00Z'],
  ['alice', 'press-1', 'open_mold', '2026-10-02T12:00:00Z'],
  ['bob', 'mixer-1', 'open_mold', '2026-09-25T10:00:00Z'],
  ['carol', 'oven-1', 'heat_up', '2026-10-02T12:00:00Z'],
  ['alice', 'press-1', 'heat_up', '2026-10-01T03:00:00Z'],
  ['carol', 'press-1', 'reset_estop', '2026-09-10T10:00:00Z'],
  ['carol', 'press-1', 'reset_estop', '2026-09-25T10:00:00Z'],
  ['alice', 'press-2', 'open_mold', '2026-09-10T10:00:00Z'],
  ['bob', 'press-1', 'open_mold', '2026-09-10T10:00:00Z'],
  ['carol', 'press-1', 'open_mold', '2026-09-10T10:00:00Z'],
  ['dave', 'press-1', 'heat_up', '2026-10-02T12:00:00Z'],
  ['bob', 'mixer-1', 'heat_up', '2026-09-25T10:00:00Z']
);
let i = 0;
while (combos.length < 50) {
  combos.push([
    subjects[i % 4],
    devices[Math.floor(i / 4) % 4],
    actions[Math.floor(i / 16) % 3],
    times[Math.floor(i / 3) % 4],
  ]);
  i++;
}

const lines = combos.map(([subject, device, action, time], idx) =>
  JSON.stringify({ id: `req-${String(idx + 1).padStart(3, '0')}`, subject, device, action, time })
);
fs.writeFileSync(path.join(__dirname, '..', 'fixtures', 'requests.jsonl'), lines.join('\n') + '\n');
console.log(`wrote ${lines.length} requests`);
