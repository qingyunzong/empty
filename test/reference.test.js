import test from 'node:test';
import assert from 'node:assert/strict';
import { AlarmEngine } from '../src/engine.js';
import { referenceSnapshot } from '../src/reference.js';

function mulberry32(seed) {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES = ['temperature', 'pressure', 'vibration'];
const OPS = ['<', '<=', '>', '>=', '==', '!='];

test('reference agrees with engine on the three-level chain scenario', () => {
  const rules = [
    { id: 'r1', alarm: 'hot', when: [{ type: 'temperature', op: '>=', value: 90 }] },
    { id: 'r2', alarm: 'hot-pressurized', when: [{ alarm: 'hot' }, { type: 'pressure', op: '>=', value: 100 }] },
    { id: 'r3', alarm: 'critical', when: [{ alarm: 'hot-pressurized' }, { type: 'vibration', op: '>=', value: 5 }] },
  ];
  const events = [
    { id: 'e1', seq: 1, type: 'temperature', value: 95 },
    { id: 'e2', seq: 2, type: 'pressure', value: 120 },
    { id: 'e3', seq: 3, type: 'vibration', value: 7 },
  ];
  const engine = new AlarmEngine();
  engine.loadRules(rules);
  for (const ev of events) engine.applyOp({ op: 'append', event: ev });
  assert.deepEqual(engine.snapshot(), referenceSnapshot(events, rules));

  engine.applyOp({ op: 'retract', id: 'e1' });
  assert.deepEqual(engine.snapshot(), referenceSnapshot(events.slice(1), rules));
});

test('random small instances match the naive fixpoint reference after every command', () => {
  for (let trial = 0; trial < 12; trial += 1) {
    const rand = mulberry32(1000 + trial);
    const engine = new AlarmEngine();
    const events = [];
    const rules = [];
    const mirrorHistory = [];
    const alarmLevel = new Map();
    let nextEvent = 0;
    let nextRule = 0;
    let nextAlarm = 0;

    const pick = (arr) => arr[Math.floor(rand() * arr.length)];

    const randomRule = () => {
      const id = `r${nextRule++}`;
      const alarm = rand() < 0.5 || nextAlarm === 0 ? `a${nextAlarm++}` : `a${Math.floor(rand() * nextAlarm)}`;
      if (!alarmLevel.has(alarm)) alarmLevel.set(alarm, alarmLevel.size);
      const level = alarmLevel.get(alarm);
      const condCount = 1 + Math.floor(rand() * 2);
      const when = [];
      for (let k = 0; k < condCount; k += 1) {
        const candidates = [...alarmLevel.entries()].filter(([, l]) => l < level).map(([n]) => n);
        if (candidates.length > 0 && rand() < 0.4) {
          when.push({ alarm: pick(candidates) });
        } else if (rand() < 0.25) {
          when.push({ type: pick(TYPES) });
        } else {
          when.push({ type: pick(TYPES), op: pick(OPS), value: Math.floor(rand() * 100) });
        }
      }
      return { id, alarm, when };
    };

    const check = (label) => {
      assert.deepEqual(
        engine.snapshot(),
        referenceSnapshot(events, rules),
        `trial ${trial}: ${label}`,
      );
    };

    for (let step = 0; step < 40; step += 1) {
      const roll = rand();
      if (roll < 0.35) {
        const ev = {
          id: `e${nextEvent}`,
          seq: nextEvent,
          type: pick(TYPES),
          value: Math.floor(rand() * 100),
        };
        nextEvent += 1;
        engine.applyOp({ op: 'append', event: ev });
        events.push(ev);
        mirrorHistory.push(() => events.splice(events.findIndex((e) => e.id === ev.id), 1));
        check(`append ${ev.id}`);
      } else if (roll < 0.55 && events.length > 0) {
        const ev = pick(events);
        engine.applyOp({ op: 'retract', id: ev.id });
        events.splice(events.indexOf(ev), 1);
        mirrorHistory.push(() => events.push(ev));
        check(`retract ${ev.id}`);
      } else if (roll < 0.75) {
        const rule = randomRule();
        engine.applyOp({ op: 'addRule', rule });
        rules.push(rule);
        mirrorHistory.push(() => rules.splice(rules.findIndex((r) => r.id === rule.id), 1));
        check(`addRule ${rule.id}`);
      } else if (roll < 0.9 && rules.length > 0) {
        const rule = pick(rules);
        engine.applyOp({ op: 'removeRule', id: rule.id });
        rules.splice(rules.indexOf(rule), 1);
        mirrorHistory.push(() => rules.push(rule));
        check(`removeRule ${rule.id}`);
      } else if (mirrorHistory.length > 0) {
        engine.applyOp({ op: 'undo' });
        mirrorHistory.pop()();
        check('undo');
      }
    }
    check('final');
  }
});
