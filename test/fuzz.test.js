import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { naiveDerive, normalizeAlarms, normalizeNaive } from './reference.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES = ['temperature', 'pressure', 'vibration'];

function randomFact(rand, id) {
  return {
    id,
    type: TYPES[Math.floor(rand() * TYPES.length)],
    value: Math.floor(rand() * 120),
  };
}

function randomCondition(rand, alarmNames) {
  if (alarmNames.length > 0 && rand() < 0.4) {
    return { alarm: alarmNames[Math.floor(rand() * alarmNames.length)] };
  }
  const type = TYPES[Math.floor(rand() * TYPES.length)];
  const threshold = Math.floor(rand() * 100);
  const op = ['$gte', '$gt', '$lte', '$lt'][Math.floor(rand() * 4)];
  return { fact: { type, value: { [op]: threshold } } };
}

function randomRule(rand, id, alarmNames) {
  const condCount = 1 + Math.floor(rand() * 2);
  const when = [];
  for (let i = 0; i < condCount; i++) when.push(randomCondition(rand, alarmNames));
  return { id, when, derive: { alarm: `alarm-${Math.floor(rand() * 4)}` } };
}

function replayState(commands, initialRules) {
  // Rebuild the naive inputs by simulating the command log.
  const facts = [];
  const rules = [...initialRules];
  const history = [];
  for (const command of commands) {
    if (command.cmd === 'undo') {
      const snap = history.pop();
      if (snap) {
        facts.length = 0;
        facts.push(...snap.facts);
        rules.length = 0;
        rules.push(...snap.rules);
      }
      continue;
    }
    history.push({ facts: [...facts], rules: [...rules] });
    if (command.cmd === 'append') facts.push(command.fact);
    else if (command.cmd === 'retract') facts.splice(facts.findIndex((f) => f.id === command.id), 1);
    else if (command.cmd === 'addRule') rules.push(command.rule);
    else if (command.cmd === 'removeRule') rules.splice(rules.findIndex((r) => r.id === command.id), 1);
  }
  return { facts, rules };
}

test('engine matches naive fixpoint reference on randomized command streams', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rand = mulberry32(seed);
    const initialRules = [];
    const ruleCount = 1 + Math.floor(rand() * 4);
    const alarmPool = [];
    for (let i = 0; i < ruleCount; i++) {
      const rule = randomRule(rand, `r${i}`, alarmPool);
      initialRules.push(rule);
      alarmPool.push(rule.derive.alarm);
    }

    const engine = new Engine({ rules: initialRules });
    const commands = [];
    const liveFacts = new Set();
    let factCounter = 0;
    let ruleCounter = ruleCount;
    const liveRules = new Set(initialRules.map((r) => r.id));
    let stepsSinceUndoable = 0;

    const stepCount = 25;
    for (let step = 0; step < stepCount; step++) {
      const pick = rand();
      let command;
      if (pick < 0.35) {
        const fact = randomFact(rand, `e${factCounter++}`);
        command = { cmd: 'append', fact };
        liveFacts.add(fact.id);
      } else if (pick < 0.55 && liveFacts.size > 0) {
        const id = [...liveFacts][Math.floor(rand() * liveFacts.size)];
        command = { cmd: 'retract', id };
        liveFacts.delete(id);
      } else if (pick < 0.7) {
        const rule = randomRule(rand, `r${ruleCounter++}`, [...alarmPool]);
        command = { cmd: 'addRule', rule };
        liveRules.add(rule.id);
        alarmPool.push(rule.derive.alarm);
      } else if (pick < 0.8 && liveRules.size > 1) {
        const id = [...liveRules][Math.floor(rand() * liveRules.size)];
        command = { cmd: 'removeRule', id };
        liveRules.delete(id);
      } else if (pick < 0.9 && stepsSinceUndoable > 0) {
        command = { cmd: 'undo' };
      } else {
        const fact = randomFact(rand, `e${factCounter++}`);
        command = { cmd: 'append', fact };
        liveFacts.add(fact.id);
      }

      // Keep the simulated undo history in sync with engine semantics:
      // undo pops one mutation; failed undos never happen here by construction.
      if (command.cmd === 'undo') {
        stepsSinceUndoable--;
        // Approximate live-set bookkeeping after undo is unnecessary:
        // we only need valid pre-undo commands, and undo itself is always valid
        // when stepsSinceUndoable > 0. Post-undo live sets are recomputed below.
      } else {
        stepsSinceUndoable++;
      }
      commands.push(command);
      const state = engine.run(command);

      // Recompute live sets from the replayed log for future command generation.
      const replayed = replayState(commands, initialRules);
      liveFacts.clear();
      for (const f of replayed.facts) liveFacts.add(f.id);
      liveRules.clear();
      for (const r of replayed.rules) liveRules.add(r.id);

      const expected = normalizeNaive(naiveDerive(replayed.facts, replayed.rules));
      const actual = normalizeAlarms(state.alarms);
      assert.deepEqual(
        actual,
        expected,
        `seed ${seed} step ${step} (${JSON.stringify(command)}) diverged`,
      );
      assert.deepEqual(
        state.facts.map((f) => f.id),
        replayed.facts.map((f) => f.id),
        `seed ${seed} step ${step} fact order diverged`,
      );
    }
  }
});
