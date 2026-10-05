import { replayEvents, statesEqual } from './replay.js';
import { crossingActions, crossingWorld, deadlockActions, deadlockWorld } from './scenarios.js';
import { Simulator } from './simulator.js';
import type { SimEvent } from './simulator.js';

function formatEvent(e: SimEvent): string {
  const head = `#${String(e.seq).padStart(3, '0')} [t=${String(e.tick).padStart(2, '0')}] ${e.type}`;
  switch (e.type) {
    case 'action_started':
    case 'action_completed':
      return `${head} arm=${e.arm} action=${e.action}`;
    case 'action_failed':
      return `${head} arm=${e.arm} action=${e.action} reason="${e.reason}"`;
    case 'acquired':
      return `${head} arm=${e.arm} segment=${e.segment}`;
    case 'released':
      return `${head} arm=${e.arm} segment=${e.segment} cause=${e.cause}`;
    case 'picked':
    case 'placed':
      return `${head} arm=${e.arm} item=${e.item} segment=${e.segment} cause=${e.cause}`;
    case 'blocked':
      return `${head} arm=${e.arm} segment=${e.segment} holders=[${e.holders.join(',')}]`;
    case 'unblocked':
      return `${head} arm=${e.arm} segment=${e.segment}`;
    case 'deadlock':
      return `${head} cycle=${e.cycle.join(' -> ')}`;
    case 'snapshot':
      return `${head} label=${e.label}`;
  }
}

console.log('=== Scenario 1: two arms swap items across shared segment S (mutex) ===');
const config = crossingWorld();
const sim = new Simulator(config, {
  validateEachEvent: true,
  onEvent: (e, s) => {
    // arbitrary event snapshots: every 5th event
    if (e.type !== 'snapshot' && e.seq % 5 === 2) s.snapshot(`snap@${e.seq}`);
  },
});
for (const action of crossingActions()) sim.submit(action);
sim.run();
for (const e of sim.events) console.log(formatEvent(e));

console.log(`\nsnapshots saved: ${[...sim.snapshots.keys()].join(', ')}`);
const replay = replayEvents(config, sim.events);
console.log(`replay: ${sim.events.length} events, violations: ${replay.violations.length}`);
console.log(`replay final state matches live: ${statesEqual(replay.state, sim.state)}`);
let snapshotsMatch = true;
for (const [label, snap] of sim.snapshots) {
  const replayed = replay.snapshots.get(label);
  const ok = replayed !== undefined && statesEqual(replayed, snap.state);
  if (!ok) snapshotsMatch = false;
  console.log(`snapshot ${label} @ event #${snap.atSeq}: replay match = ${ok}`);
}

console.log('\n=== Scenario 2: circular wait between two arms ===');
const sim2 = new Simulator(deadlockWorld(), { validateEachEvent: true });
for (const action of deadlockActions()) sim2.submit(action);
sim2.run();
for (const e of sim2.events) console.log(formatEvent(e));
const deadlock = sim2.events.find((e) => e.type === 'deadlock');
if (deadlock && deadlock.type === 'deadlock') {
  console.log('\nwait-for graph (DOT):');
  console.log(deadlock.dot);
}
const replay2 = replayEvents(deadlockWorld(), sim2.events);
console.log(`replay: ${sim2.events.length} events, violations: ${replay2.violations.length}`);
console.log(`replay final state matches live: ${statesEqual(replay2.state, sim2.state)}`);

if (replay.violations.length === 0 && replay2.violations.length === 0 && snapshotsMatch) {
  console.log('\nDEMO OK');
} else {
  console.error('\nDEMO FAILED');
}
