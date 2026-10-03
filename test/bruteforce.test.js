// Cross-checks the scheduler against an independent brute-force enumeration
// of the optimal (maximum-cardinality) feasible set for n <= 8.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, replay, checkSchedule } from '../src/index.js';

// Deterministic PRNG (mulberry32).
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(rand) {
  const n = 1 + Math.floor(rand() * 8); // 1..8 instructions
  const slots = n > 6 ? 1 + Math.floor(rand() * 3) : 1 + Math.floor(rand() * 4);
  const capacityPerSlot = 1 + Math.floor(rand() * 2);
  const institutions = ['A', 'B', 'C'].slice(0, 1 + Math.floor(rand() * 3));
  const quotas = {};
  for (const inst of institutions) {
    if (rand() < 0.7) quotas[inst] = 1 + Math.floor(rand() * 3);
  }
  const instructions = [];
  for (let i = 0; i < n; i++) {
    const id = `i${String(i).padStart(2, '0')}`;
    const arrivalSlot = Math.floor(rand() * (slots + 1));
    const deadlineSlot = Math.max(arrivalSlot, 1 + Math.floor(rand() * slots));
    const dependencies = [];
    for (let j = 0; j < i; j++) {
      if (rand() < 0.25) dependencies.push(`i${String(j).padStart(2, '0')}`);
    }
    instructions.push({
      id,
      institution: institutions[Math.floor(rand() * institutions.length)],
      amount: 1 + Math.floor(rand() * 100),
      priority: 1 + Math.floor(rand() * 3),
      arrivalSlot,
      deadlineSlot,
      ...(dependencies.length > 0 ? { dependencies } : {}),
    });
  }
  return { config: { slots, capacityPerSlot, quotas }, instructions };
}

// Independent brute force: every instruction maps to a slot in 1..S or stays
// unscheduled (0). Returns the maximum feasible confirmed count.
function bruteForceOptimalCount(input) {
  const { config, instructions } = input;
  const n = instructions.length;
  const choice = new Array(n).fill(0);
  let best = 0;

  const feasible = () => {
    const slotLoad = new Array(config.slots + 1).fill(0);
    const instUsage = new Map();
    for (let i = 0; i < n; i++) {
      const s = choice[i];
      if (s === 0) continue;
      const instr = instructions[i];
      if (s < instr.arrivalSlot || s > instr.deadlineSlot) return false;
      slotLoad[s] += 1;
      if (slotLoad[s] > config.capacityPerSlot) return false;
      const used = (instUsage.get(instr.institution) ?? 0) + 1;
      const quota = Object.hasOwn(config.quotas, instr.institution)
        ? config.quotas[instr.institution]
        : Infinity;
      if (used > quota) return false;
      instUsage.set(instr.institution, used);
    }
    for (let i = 0; i < n; i++) {
      if (choice[i] === 0) continue;
      for (const dep of instructions[i].dependencies ?? []) {
        const j = instructions.findIndex((x) => x.id === dep);
        if (j === -1 || choice[j] === 0 || choice[j] >= choice[i]) return false;
      }
    }
    return true;
  };

  const walk = (i, count) => {
    if (count + (n - i) <= best) return;
    if (i === n) {
      if (feasible() && count > best) best = count;
      return;
    }
    for (let s = 1; s <= config.slots; s++) {
      choice[i] = s;
      walk(i + 1, count + 1);
    }
    choice[i] = 0;
    walk(i + 1, count);
  };
  walk(0, 0);
  return best;
}

test('scheduler matches brute-force optimal feasible set for n <= 8', () => {
  const rand = prng(20261003);
  const CASES = 150;
  for (let k = 0; k < CASES; k++) {
    const input = generate(rand);
    const out = run(input);

    // 1. The produced schedule is feasible (independent checker).
    const assignments = new Map(
      out.schedule.filter((s) => s.status === 'confirmed').map((s) => [s.id, s.slot]),
    );
    const violations = checkSchedule(
      { ...input.config, quotas: new Map(Object.entries(input.config.quotas)) },
      input.instructions,
      assignments,
    );
    assert.deepEqual(violations, [], `case ${k}: infeasible schedule: ${violations.join('; ')}`);

    // 2. Confirmed count equals the brute-force optimum.
    const optimal = bruteForceOptimalCount(input);
    assert.equal(
      assignments.size,
      optimal,
      `case ${k}: confirmed ${assignments.size} != optimal ${optimal}`,
    );

    // 3. The certificate log replays to the same confirmed set.
    const r = replay(out.certificates);
    assert.equal(r.valid, true, `case ${k}: replay failed at ${r.failedAt}`);
    assert.deepEqual([...r.confirmed.entries()].sort(), [...assignments.entries()].sort());

    // 4. Every unscheduled instruction carries an error code.
    for (const s of out.schedule) {
      if (s.status === 'unscheduled') {
        assert.ok(
          out.errors.some((e) => e.instructionId === s.id),
          `case ${k}: ${s.id} unscheduled without error`,
        );
      }
    }
  }
});
