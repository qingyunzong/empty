import { solve, Scheduler } from './src/index.js';

const CFG = { peak: 9, capacity: 5, deltaMax: 80, grid: 1 };

const batches = [
  { id: 'a1', alloy: 'A', band: [780, 860], mass: 2, curve: [{ t: 0, temp: 20 }, { t: 1, temp: 820, phase: 'hold' }, { t: 2, temp: 820, phase: 'hold' }, { t: 3, temp: 300 }], power: [{ t: 0, power: 5 }, { t: 1, power: 4 }, { t: 2, power: 2 }, { t: 3, power: 1 }] },
  { id: 'a2', alloy: 'A', band: [800, 880], mass: 3, curve: [{ t: 0, temp: 20 }, { t: 1, temp: 840, phase: 'hold' }, { t: 2, temp: 840, phase: 'hold' }, { t: 3, temp: 400 }], power: [{ t: 0, power: 4 }, { t: 1, power: 4 }, { t: 2, power: 2 }, { t: 3, power: 1 }] },
  { id: 'a3', alloy: 'A', band: [750, 830], mass: 2, curve: [{ t: 0, temp: 20 }, { t: 1, temp: 800, phase: 'hold' }, { t: 2, temp: 800, phase: 'hold' }, { t: 3, temp: 250 }], power: [{ t: 0, power: 5 }, { t: 1, power: 3 }, { t: 2, power: 2 }, { t: 3, power: 1 }] },
  { id: 'b1', alloy: 'B', band: [600, 700], mass: 3, curve: [{ t: 0, temp: 20 }, { t: 1, temp: 650, phase: 'hold' }, { t: 2, temp: 650, phase: 'hold' }, { t: 3, temp: 200 }], power: [{ t: 0, power: 4 }, { t: 1, power: 3 }, { t: 2, power: 2 }, { t: 3, power: 1 }] },
  { id: 'b2', alloy: 'B', band: [620, 720], mass: 2, curve: [{ t: 0, temp: 20 }, { t: 1, temp: 680, phase: 'hold' }, { t: 2, temp: 680, phase: 'hold' }, { t: 3, temp: 300 }], power: [{ t: 0, power: 3 }, { t: 1, power: 3 }, { t: 2, power: 2 }, { t: 3, power: 1 }] },
  { id: 'b3', alloy: 'B', band: [580, 690], mass: 2, curve: [{ t: 0, temp: 20 }, { t: 1, temp: 620, phase: 'hold' }, { t: 2, temp: 620, phase: 'hold' }, { t: 3, temp: 250 }], power: [{ t: 0, power: 4 }, { t: 1, power: 3 }, { t: 2, power: 3 }, { t: 3, power: 1 }] },
];

console.log('=== 1) 6 批离线编排 (peak=9, capacity=5, deltaMax=80) ===');
const res = solve(batches, CFG);
console.log(`status=${res.status} objective=${JSON.stringify(res.objective)} ties=${res.schedules.length} tiesComplete=${res.tiesComplete} nodes=${res.nodes}`);
for (const [i, s] of res.schedules.entries()) {
  console.log(`  方案${i + 1}: ` + s.runs.map((r) => `炉次[${r.batchIds.join('+')}] t=${r.start}..${r.end}`).join(' | '));
}

console.log('\n=== 2) UNSAT 证书（bad 单批功率 10 > peak 9）===');
const bad = { id: 'bad', alloy: 'A', band: [800, 860], mass: 1, curve: [{ t: 0, temp: 20 }, { t: 1, temp: 830 }], power: [{ t: 0, power: 10 }, { t: 1, power: 10 }] };
const unsat = solve([batches[0], bad], CFG);
console.log(`status=${unsat.status}`);
console.log(`certificate=${JSON.stringify(unsat.certificate)}`);

console.log('\n=== 3) 增量重排与撤销 ===');
const sched = new Scheduler(CFG);
for (const b of batches.slice(0, 4)) sched.addBatch(b);
const r1 = sched.resolve();
console.log(`初始: makespan=${r1.objective.makespan} runs=${r1.objective.runCount}`);
sched.editBatch('a3', { band: [870, 950] });
const r2 = sched.resolve();
console.log(`改 a3 温度带 -> [870,950] 后(增量): makespan=${r2.objective.makespan} runs=${r2.objective.runCount}`);
const full = solve(sched.listBatches(), CFG);
console.log(`全量重算对照: makespan=${full.objective.makespan} runs=${full.objective.runCount} 一致=${JSON.stringify(r2) === JSON.stringify(full)}`);
sched.undo();
const r3 = sched.resolve();
console.log(`undo 后: makespan=${r3.objective.makespan} runs=${r3.objective.runCount} 与初始一致=${JSON.stringify(r3) === JSON.stringify(r1)}`);

console.log('\n=== 4) UNKNOWN（节点预算=3）===');
const unk = solve(batches, { ...CFG, nodeLimit: 3 });
console.log(`status=${unk.status} reason=${unk.reason}`);
