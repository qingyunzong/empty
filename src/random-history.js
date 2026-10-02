import { mulberry32 } from './prng.js';

const CMDS = [
  'press_estop',
  'reset',
  'extend_cylinder',
  'retract_cylinder',
  'start_cycle',
];
const ACK = {
  press_estop: 'estop',
  reset: 'reset_ack',
  extend_cylinder: 'cyl_done',
  retract_cylinder: 'cyl_done',
  start_cycle: 'photo',
};
const SRC = {
  estop: 'safety',
  reset_ack: 'plc',
  cyl_done: 'cylinder',
  photo: 'photoeye',
};

// Seeded random history generator used by the multi-threaded consistency test.
// Produces a mix of linearizable and violating histories (all ops complete).
export function randomHistory(seed) {
  const rand = mulberry32(seed);
  const ri = (n) => Math.floor(rand() * n);
  const nOps = 3 + ri(4); // 3..6 ops keeps the exponential reference feasible
  const ops = [];
  const events = [];
  let eid = 0;
  for (let i = 0; i < nOps; i++) {
    const cmd = CMDS[ri(CMDS.length)];
    const start = ri(15);
    const end = start + 2 + ri(6);
    ops.push({ cmd, start, end, args: {} });
    const r = rand();
    if (r < 0.7) {
      // well-formed ack inside the op interval
      events.push({
        id: `e${eid++}`,
        ts: start + 1 + ri(Math.max(1, end - start - 1)),
        src: SRC[ACK[cmd]],
        kind: ACK[cmd],
      });
    } else if (r < 0.85) {
      // ack arrives after the op completed: useless for linearization
      events.push({
        id: `e${eid++}`,
        ts: end + 1 + ri(5),
        src: SRC[ACK[cmd]],
        kind: ACK[cmd],
      });
    } // else: ack missing entirely
    if (rand() < 0.3) {
      const kinds = Object.values(ACK);
      const k = kinds[ri(kinds.length)];
      events.push({ id: `e${eid++}`, ts: ri(20), src: SRC[k], kind: k });
    }
  }
  return { ops, events, seed };
}
