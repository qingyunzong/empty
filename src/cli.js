// Demo CLI: runs the acceptance scenarios and prints JSON results.
// Usage: node src/cli.js

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from './log.js';
import { truncateAt } from './fault.js';
import { verify } from './verifier.js';

const cmd = (name) => ({ type: 'cmd', name });
const ack = (sensor, value) => ({ type: 'ack', sensor, value });

function show(title, value) {
  console.log(`=== ${title} ===`);
  console.log(JSON.stringify(value, null, 2));
  console.log();
}

// 1. Heat without confirmed pressure, then open the exhaust valve.
const badHistory = [cmd('close_door'), cmd('lock_door'), cmd('heat_on'), cmd('open_vent')];
show('heat without pressure, then open_vent', verify(badHistory));

// 2. Unknown ack keeps pressure UNKNOWN; open_vent still rejected.
const unknownAck = [
  cmd('close_door'),
  cmd('lock_door'),
  cmd('heat_on'),
  ack('co2', 'HIGH'),
  cmd('open_vent'),
];
show('unknown ack stays UNKNOWN', verify(unknownAck));

// 3. Fault point 1: crash after data, before commit -> batch discarded.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclave-demo-'));
  const log = CommandLog.open(dir);
  log.append('close_door');
  log.append('lock_door');
  log.commit();
  log.append('heat_on');
  log.ack('pressure', 'HIGH');
  log.commit();
  truncateAt(path.join(dir, 'seg-1.log'), fs.readFileSync(path.join(dir, 'seg-1.log'), 'utf8').indexOf('@COMMIT'));
  truncateAt(
    path.join(dir, 'manifest.log'),
    fs.readFileSync(path.join(dir, 'manifest.log'), 'utf8').indexOf('@MANIFEST 1'),
  );
  const rec = CommandLog.recover(dir);
  show('fault point 1: data without commit -> discarded', {
    events: rec.events,
    discarded: rec.discarded,
    corrupt: rec.corrupt,
    replay: verify(rec.events).safeState,
  });
}

// 4. Fault point 2: crash after commit, before manifest -> batch visible.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclave-demo-'));
  const log = CommandLog.open(dir);
  log.append('close_door');
  log.append('lock_door');
  log.commit();
  log.append('heat_on');
  log.ack('pressure', 'HIGH');
  log.commit();
  truncateAt(
    path.join(dir, 'manifest.log'),
    fs.readFileSync(path.join(dir, 'manifest.log'), 'utf8').indexOf('@MANIFEST 1'),
  );
  const rec = CommandLog.recover(dir);
  show('fault point 2: commit without manifest -> visible', {
    events: rec.events,
    discarded: rec.discarded,
    corrupt: rec.corrupt,
    replay: verify(rec.events).safeState,
  });
}

// 5. Corruption of a manifested segment -> ERR_CORRUPT names the segment.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclave-demo-'));
  const log = CommandLog.open(dir);
  log.append('close_door');
  log.commit();
  truncateAt(path.join(dir, 'seg-0.log'), 12);
  const rec = CommandLog.recover(dir);
  show('truncated manifested segment -> ERR_CORRUPT', {
    events: rec.events,
    corrupt: rec.corrupt,
  });
}
