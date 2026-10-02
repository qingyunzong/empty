import test from 'node:test';
import assert from 'node:assert/strict';
import { AlarmEngine } from '../src/engine.js';

const event = (id, seq, type, value) => ({ id, seq, type, value });
const append = (ev) => ({ op: 'append', event: ev });
const retract = (id) => ({ op: 'retract', id });
const addRule = (rule) => ({ op: 'addRule', rule });
const removeRule = (id) => ({ op: 'removeRule', id });
const undo = () => ({ op: 'undo' });

const CHAIN_RULES = [
  { id: 'r1', alarm: 'hot', when: [{ type: 'temperature', op: '>=', value: 90 }] },
  {
    id: 'r2',
    alarm: 'hot-pressurized',
    when: [{ alarm: 'hot' }, { type: 'pressure', op: '>=', value: 100 }],
  },
  {
    id: 'r3',
    alarm: 'critical',
    when: [{ alarm: 'hot-pressurized' }, { type: 'vibration', op: '>=', value: 5 }],
  },
];

function alarmNames(engine) {
  return engine.snapshot().map((entry) => entry.alarm);
}

function alarmProofs(engine, name) {
  const entry = engine.snapshot().find((item) => item.alarm === name);
  return entry ? entry.proofs : [];
}

test('three-level rule chain derives transitively and deletes incrementally', () => {
  const engine = new AlarmEngine();
  engine.loadRules(CHAIN_RULES);

  let result = engine.applyOp(append(event('e1', 1, 'temperature', 95)));
  assert.deepEqual(result.added, ['hot']);
  assert.deepEqual(alarmNames(engine), ['hot']);

  result = engine.applyOp(append(event('e2', 2, 'pressure', 120)));
  assert.deepEqual(result.added, ['hot-pressurized']);

  result = engine.applyOp(append(event('e3', 3, 'vibration', 7)));
  assert.deepEqual(result.added, ['critical']);
  assert.deepEqual(alarmNames(engine), ['critical', 'hot', 'hot-pressurized']);

  const critical = alarmProofs(engine, 'critical');
  assert.equal(critical.length, 1);
  assert.deepEqual(critical[0], {
    rule: 'r3',
    facts: ['e3'],
    alarms: [
      {
        alarm: 'hot-pressurized',
        proof: {
          rule: 'r2',
          facts: ['e2'],
          alarms: [
            { alarm: 'hot', proof: { rule: 'r1', facts: ['e1'], alarms: [] } },
          ],
        },
      },
    ],
  });

  result = engine.applyOp(retract('e1'));
  assert.deepEqual(result.removed, ['critical', 'hot', 'hot-pressurized']);
  assert.deepEqual(alarmNames(engine), []);
});

test('alternative proofs: alarm survives while any minimal proof remains', () => {
  const engine = new AlarmEngine();
  engine.loadRules([
    { id: 'r1', alarm: 'hot', when: [{ type: 'temperature', op: '>=', value: 90 }] },
  ]);

  engine.applyOp(append(event('e1', 1, 'temperature', 95)));
  engine.applyOp(append(event('e2', 2, 'temperature', 96)));

  let proofs = alarmProofs(engine, 'hot');
  assert.equal(proofs.length, 2);
  assert.deepEqual(proofs.map((p) => p.facts), [['e1'], ['e2']]);

  const result = engine.applyOp(retract('e1'));
  assert.deepEqual(result.removed, []);
  proofs = alarmProofs(engine, 'hot');
  assert.equal(proofs.length, 1);
  assert.deepEqual(proofs[0].facts, ['e2']);

  const gone = engine.applyOp(retract('e2'));
  assert.deepEqual(gone.removed, ['hot']);
  assert.deepEqual(alarmNames(engine), []);
});

test('certificate lists all minimal proofs and drops non-minimal ones', () => {
  const engine = new AlarmEngine();
  engine.loadRules([
    {
      id: 'r1',
      alarm: 'combo',
      when: [{ type: 'temperature', op: '>=', value: 90 }, { type: 'pressure' }],
    },
    {
      id: 'r2',
      alarm: 'combo',
      when: [{ type: 'temperature', op: '>=', value: 95 }, { type: 'vibration' }],
    },
  ]);
  engine.applyOp(append(event('t1', 1, 'temperature', 96)));
  engine.applyOp(append(event('p1', 2, 'pressure', 50)));
  engine.applyOp(append(event('v1', 3, 'vibration', 9)));

  const proofs = alarmProofs(engine, 'combo');
  assert.deepEqual(
    proofs.map((p) => ({ rule: p.rule, facts: p.facts })),
    [
      { rule: 'r1', facts: ['t1', 'p1'] },
      { rule: 'r2', facts: ['t1', 'v1'] },
    ],
  );

  engine.applyOp(
    addRule({ id: 'r3', alarm: 'combo', when: [{ type: 'temperature', op: '>=', value: 95 }] }),
  );
  const minimal = alarmProofs(engine, 'combo');
  assert.deepEqual(
    minimal.map((p) => ({ rule: p.rule, facts: p.facts })),
    [{ rule: 'r3', facts: ['t1'] }],
  );
});

test('new rule replays historical facts deterministically', () => {
  const run = () => {
    const engine = new AlarmEngine();
    engine.applyOp(append(event('e1', 1, 'temperature', 95)));
    engine.applyOp(append(event('e2', 2, 'pressure', 120)));
    engine.applyOp(append(event('e3', 3, 'vibration', 7)));
    for (const rule of CHAIN_RULES) engine.applyOp(addRule(rule));
    return engine.snapshot();
  };
  const first = run();
  const second = run();
  assert.deepEqual(alarmNames({ snapshot: () => first }), ['critical', 'hot', 'hot-pressurized']);
  assert.deepEqual(first, second);
});

test('removeRule invalidates dependent alarms; rule correction re-derives', () => {
  const engine = new AlarmEngine();
  engine.loadRules(CHAIN_RULES);
  engine.applyOp(append(event('e1', 1, 'temperature', 95)));
  engine.applyOp(append(event('e2', 2, 'pressure', 120)));
  engine.applyOp(append(event('e3', 3, 'vibration', 7)));
  assert.deepEqual(alarmNames(engine), ['critical', 'hot', 'hot-pressurized']);

  let result = engine.applyOp(removeRule('r1'));
  assert.deepEqual(result.removed, ['critical', 'hot', 'hot-pressurized']);
  assert.deepEqual(alarmNames(engine), []);

  result = engine.applyOp(
    addRule({ id: 'r1', alarm: 'hot', when: [{ type: 'temperature', op: '>=', value: 96 }] }),
  );
  assert.deepEqual(result.added, []);
  assert.deepEqual(alarmNames(engine), []);

  engine.applyOp(append(event('e4', 4, 'temperature', 97)));
  assert.deepEqual(alarmNames(engine), ['critical', 'hot', 'hot-pressurized']);
});

test('undo reverts append, retract, addRule and removeRule', () => {
  const engine = new AlarmEngine();
  engine.loadRules([
    { id: 'r1', alarm: 'hot', when: [{ type: 'temperature', op: '>=', value: 90 }] },
  ]);

  engine.applyOp(append(event('e1', 1, 'temperature', 95)));
  assert.deepEqual(alarmNames(engine), ['hot']);
  engine.applyOp(undo());
  assert.deepEqual(alarmNames(engine), []);
  engine.applyOp(append(event('e1', 1, 'temperature', 95)));
  assert.deepEqual(alarmNames(engine), ['hot']);

  engine.applyOp(retract('e1'));
  assert.deepEqual(alarmNames(engine), []);
  engine.applyOp(undo());
  assert.deepEqual(alarmNames(engine), ['hot']);

  engine.applyOp(addRule({ id: 'r2', alarm: 'warm', when: [{ type: 'temperature' }] }));
  assert.deepEqual(alarmNames(engine), ['hot', 'warm']);
  engine.applyOp(undo());
  assert.deepEqual(alarmNames(engine), ['hot']);

  engine.applyOp(removeRule('r1'));
  assert.deepEqual(alarmNames(engine), []);
  engine.applyOp(undo());
  assert.deepEqual(alarmNames(engine), ['hot']);
});

test('structured errors: bad rules, unknown fields, duplicates, cycles', () => {
  const engine = new AlarmEngine();

  assert.throws(
    () => engine.loadRules([{ id: 'r1', alarm: 'a', when: [], extra: 1 }]),
    (error) => error.code === 'UNKNOWN_FIELD' && error.details.field === 'extra',
  );
  assert.throws(
    () => engine.loadRules([{ id: 'r1', alarm: 'a' }]),
    (error) => error.code === 'MISSING_FIELD' && error.details.field === 'when',
  );
  assert.throws(
    () => engine.loadRules([{ id: 'r1', alarm: 'a', when: [{ type: 't', op: '~', value: 1 }] }]),
    (error) => error.code === 'INVALID_VALUE',
  );
  assert.throws(
    () =>
      engine.loadRules([
        { id: 'r1', alarm: 'a', when: [{ type: 't' }] },
        { id: 'r1', alarm: 'b', when: [{ type: 't' }] },
      ]),
    (error) => error.code === 'DUPLICATE_ID',
  );

  assert.throws(
    () => engine.applyOp(append({ id: 'e1', seq: 1, type: 'temperature', value: 1, bogus: true })),
    (error) => error.code === 'UNKNOWN_FIELD' && error.details.field === 'bogus',
  );
  assert.throws(
    () => engine.applyOp({ op: 'explode' }),
    (error) => error.code === 'UNKNOWN_OP',
  );

  engine.applyOp(append(event('e1', 1, 'temperature', 95)));
  assert.throws(
    () => engine.applyOp(append(event('e1', 2, 'temperature', 96))),
    (error) => error.code === 'DUPLICATE_ID',
  );
  assert.throws(
    () => engine.applyOp(append(event('e2', 1, 'temperature', 96))),
    (error) => error.code === 'DUPLICATE_SEQ',
  );
  assert.throws(
    () => engine.applyOp(retract('nope')),
    (error) => error.code === 'UNKNOWN_EVENT',
  );
  assert.throws(
    () => engine.applyOp(removeRule('nope')),
    (error) => error.code === 'UNKNOWN_RULE',
  );

  engine.applyOp(addRule({ id: 'r1', alarm: 'a', when: [{ type: 'temperature' }] }));
  assert.throws(
    () => engine.applyOp(addRule({ id: 'r1', alarm: 'b', when: [{ type: 'temperature' }] })),
    (error) => error.code === 'DUPLICATE_ID',
  );
  engine.applyOp(addRule({ id: 'r2', alarm: 'b', when: [{ alarm: 'a' }] }));
  assert.throws(
    () => engine.applyOp(addRule({ id: 'r3', alarm: 'a', when: [{ alarm: 'b' }] })),
    (error) => error.code === 'RULE_CYCLE',
  );
  assert.throws(
    () => engine.applyOp(addRule({ id: 'r4', alarm: 'c', when: [{ alarm: 'c' }] })),
    (error) => error.code === 'RULE_CYCLE',
  );

  const empty = new AlarmEngine();
  assert.throws(
    () => empty.applyOp(undo()),
    (error) => error.code === 'NOTHING_TO_UNDO',
  );
});

test('failed commands do not pollute undo history', () => {
  const engine = new AlarmEngine();
  engine.loadRules([
    { id: 'r1', alarm: 'hot', when: [{ type: 'temperature', op: '>=', value: 90 }] },
  ]);
  engine.applyOp(append(event('e1', 1, 'temperature', 95)));
  assert.throws(() => engine.applyOp(retract('ghost')));
  engine.applyOp(undo());
  assert.deepEqual(alarmNames(engine), []);
  assert.equal(engine.events.size, 0);
});
