// Seeded random history generator (used by the multithreaded agreement test).
import { mulberry32, hashString } from './prng.js';

const CMDS = ['extend', 'retract', 'reset'];
const KINDS = ['estop', 'estop_clear', 'photo', 'photo_clear', 'cyl_done'];
const SRCS = ['plc', 'hmi', 'photo', 'cyl'];

export function randomHistory(seed) {
  const rng = mulberry32(hashString(String(seed)));
  const ri = (n) => Math.floor(rng() * n);
  const pick = (arr) => arr[ri(arr.length)];
  const nOps = 2 + ri(2); // 2..3
  const nEv = 2 + ri(3); // 2..4 (total <= 7 keeps reference enumeration feasible)
  const ops = [];
  for (let i = 0; i < nOps; i++) {
    const start = ri(8);
    ops.push({
      id: `o${i}`,
      cmd: pick(CMDS),
      start,
      end: start + 1 + ri(4),
      args: { expect: rng() < 0.7 ? 'ok' : 'fail' },
    });
  }
  const events = [];
  for (let i = 0; i < nEv; i++) {
    if (rng() < 0.25) {
      events.push({
        id: `e${i}`,
        ts: ri(10),
        src: 'plc',
        kind: 'ack',
        args: { op: `o${ri(nOps)}`, ok: rng() < 0.7 ? 'ok' : 'fail' },
      });
    } else {
      events.push({ id: `e${i}`, ts: ri(10), src: pick(SRCS), kind: pick(KINDS), args: {} });
    }
  }
  return { ops, events, seed };
}
