import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { EngineError } from '../src/errors.js';

const chainRules = [
  {
    id: 'r1',
    when: [{ fact: { type: 'temperature', value: { $gte: 90 } } }],
    derive: { alarm: 'hot' },
  },
  {
    id: 'r2',
    when: [{ alarm: 'hot' }, { fact: { type: 'pressure', value: { $gte: 50 } } }],
    derive: { alarm: 'critical' },
  },
  {
    id: 'r3',
    when: [{ alarm: 'critical' }, { fact: { type: 'vibration', value: { $gte: 5 } } }],
    derive: { alarm: 'shutdown' },
  },
];

const chainFacts = [
  { id: 'e1', type: 'temperature', value: 95 },
  { id: 'e2', type: 'pressure', value: 60 },
  { id: 'e3', type: 'vibration', value: 7 },
];

function engineWith(rules, facts) {
  const engine = new Engine({ rules });
  for (const fact of facts) engine.run({ cmd: 'append', fact });
  return engine;
}

function alarmMap(state) {
  return Object.fromEntries(state.alarms.map((a) => [a.alarm, a.proofs]));
}

test('three-level rule chain derives transitively with full proof certificates', () => {
  const state = engineWith(chainRules, chainFacts).getState();
  const alarms = alarmMap(state);
  assert.deepEqual(Object.keys(alarms).sort(), ['critical', 'hot', 'shutdown']);
  assert.deepEqual(alarms.hot, [{ rule: 'r1', facts: ['e1'] }]);
  assert.deepEqual(alarms.critical, [{ rule: 'r2', facts: ['e1', 'e2'] }]);
  assert.deepEqual(alarms.shutdown, [{ rule: 'r3', facts: ['e1', 'e2', 'e3'] }]);
  assert.deepEqual(state.dependencies, { r1: [], r2: ['r1'], r3: ['r2'] });
});

test('incremental deletion only removes alarms that lost every proof', () => {
  const engine = engineWith(chainRules, chainFacts);
  let state = engine.run({ cmd: 'retract', id: 'e2' });
  assert.deepEqual(Object.keys(alarmMap(state)), ['hot']);
  state = engine.run({ cmd: 'retract', id: 'e1' });
  assert.deepEqual(state.alarms, []);
  state = engine.run({ cmd: 'retract', id: 'e3' });
  assert.deepEqual(state.alarms, []);
});

test('new rules replay historical facts deterministically', () => {
  const engine = new Engine();
  for (const fact of chainFacts) engine.run({ cmd: 'append', fact });
  assert.deepEqual(engine.getState().alarms, []);
  for (const rule of chainRules) engine.run({ cmd: 'addRule', rule });
  const late = engine.getState();
  const early = engineWith(chainRules, chainFacts).getState();
  assert.deepEqual(late.alarms, early.alarms);
});

test('rule correction (removeRule + addRule) re-derives alarms', () => {
  const engine = engineWith(chainRules, chainFacts);
  engine.run({ cmd: 'removeRule', id: 'r1' });
  assert.deepEqual(engine.getState().alarms, []);
  engine.run({
    cmd: 'addRule',
    rule: {
      id: 'r1',
      when: [{ fact: { type: 'temperature', value: { $gte: 99 } } }],
      derive: { alarm: 'hot' },
    },
  });
  assert.deepEqual(engine.getState().alarms, []);
  engine.run({ cmd: 'append', fact: { id: 'e4', type: 'temperature', value: 100 } });
  const alarms = alarmMap(engine.getState());
  assert.deepEqual(alarms.hot, [{ rule: 'r1', facts: ['e4'] }]);
});

test('alternative proofs: alarm survives when one justification is retracted', () => {
  const rules = [
    {
      id: 'r1',
      when: [{ fact: { type: 'temperature', value: { $gte: 90 } } }],
      derive: { alarm: 'hot' },
    },
    {
      id: 'r2',
      when: [{ fact: { type: 'pressure', value: { $gte: 80 } } }],
      derive: { alarm: 'hot' },
    },
  ];
  const engine = engineWith(rules, [
    { id: 'e1', type: 'temperature', value: 95 },
    { id: 'e2', type: 'pressure', value: 90 },
  ]);
  let alarms = alarmMap(engine.getState());
  assert.deepEqual(alarms.hot, [
    { rule: 'r1', facts: ['e1'] },
    { rule: 'r2', facts: ['e2'] },
  ]);
  engine.run({ cmd: 'retract', id: 'e1' });
  alarms = alarmMap(engine.getState());
  assert.deepEqual(alarms.hot, [{ rule: 'r2', facts: ['e2'] }]);
  engine.run({ cmd: 'undo' });
  alarms = alarmMap(engine.getState());
  assert.equal(alarms.hot.length, 2);
});

test('certificate lists all minimal proofs and only minimal proofs', () => {
  const rules = [
    {
      id: 'r1',
      when: [{ fact: { type: 'temperature', value: { $gte: 90 } } }],
      derive: { alarm: 'alert' },
    },
    {
      id: 'r2',
      when: [
        { fact: { type: 'temperature', value: { $gte: 90 } } },
        { fact: { type: 'pressure', value: { $gte: 50 } } },
      ],
      derive: { alarm: 'alert' },
    },
  ];
  const engine = engineWith(rules, [
    { id: 'e1', type: 'temperature', value: 95 },
    { id: 'e2', type: 'pressure', value: 60 },
  ]);
  const alarms = alarmMap(engine.getState());
  // {e1,e2} via r2 is not minimal because {e1} via r1 subsumes it.
  assert.deepEqual(alarms.alert, [{ rule: 'r1', facts: ['e1'] }]);
});

test('tied conclusions are ordered by rule id then event sequence', () => {
  const rules = [
    { id: 'rb', when: [{ fact: { type: 'vibration', value: { $gte: 5 } } }], derive: { alarm: 'zzz' } },
    { id: 'ra', when: [{ fact: { type: 'temperature', value: { $gte: 90 } } }], derive: { alarm: 'aaa' } },
    { id: 'rc', when: [{ fact: { type: 'pressure', value: { $gte: 50 } } }], derive: { alarm: 'mmm' } },
  ];
  const engine = engineWith(rules, [
    { id: 'e1', type: 'pressure', value: 60 },
    { id: 'e2', type: 'temperature', value: 95 },
    { id: 'e3', type: 'vibration', value: 7 },
  ]);
  assert.deepEqual(
    engine.getState().alarms.map((a) => a.alarm),
    ['aaa', 'zzz', 'mmm'],
  );
});

test('undo restores facts, rules and derived alarms step by step', () => {
  const engine = new Engine({ rules: chainRules });
  engine.run({ cmd: 'append', fact: chainFacts[0] });
  engine.run({ cmd: 'append', fact: chainFacts[1] });
  engine.run({ cmd: 'append', fact: chainFacts[2] });
  assert.equal(engine.getState().alarms.length, 3);
  engine.run({ cmd: 'undo' });
  assert.deepEqual(
    engine.getState().alarms.map((a) => a.alarm),
    ['hot', 'critical'],
  );
  engine.run({ cmd: 'undo' });
  engine.run({ cmd: 'undo' });
  assert.deepEqual(engine.getState().alarms, []);
  assert.deepEqual(engine.getState().facts, []);
  engine.run({ cmd: 'removeRule', id: 'r3' });
  assert.deepEqual(engine.getState().rules.map((r) => r.id), ['r1', 'r2']);
  engine.run({ cmd: 'undo' });
  assert.deepEqual(engine.getState().rules.map((r) => r.id), ['r1', 'r2', 'r3']);
});

test('cyclic rule dependencies settle at the least fixpoint', () => {
  const engine = new Engine({
    rules: [
      { id: 'r1', when: [{ alarm: 'b' }], derive: { alarm: 'a' } },
      { id: 'r2', when: [{ alarm: 'a' }], derive: { alarm: 'b' } },
    ],
  });
  assert.deepEqual(engine.getState().alarms, []);
});

function expectCode(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof EngineError, `expected EngineError, got ${err}`);
    assert.equal(err.code, code, err.message);
    return true;
  });
}

test('structured errors: bad rules, unknown fields, duplicate ids', () => {
  const engine = new Engine({ rules: chainRules });
  engine.run({ cmd: 'append', fact: { id: 'e1', type: 'temperature', value: 95 } });

  // duplicate ids
  expectCode(
    () => engine.run({ cmd: 'append', fact: { id: 'e1', type: 'pressure', value: 1 } }),
    'DUPLICATE_ID',
  );
  expectCode(() => engine.run({ cmd: 'addRule', rule: chainRules[0] }), 'DUPLICATE_ID');
  expectCode(() => new Engine({ rules: [chainRules[0], chainRules[0]] }), 'DUPLICATE_ID');

  // unknown fields
  expectCode(
    () => engine.run({ cmd: 'addRule', rule: { ...chainRules[0], id: 'rx', bogus: 1 } }),
    'UNKNOWN_FIELD',
  );
  expectCode(
    () =>
      engine.run({
        cmd: 'addRule',
        rule: { id: 'rx', when: [{ fact: { type: 't' }, future: 1 }], derive: { alarm: 'a' } },
      }),
    'UNKNOWN_FIELD',
  );
  expectCode(
    () => engine.run({ cmd: 'append', fact: { id: 'e9', type: 'x' }, extra: true }),
    'UNKNOWN_FIELD',
  );
  expectCode(
    () =>
      engine.run({
        cmd: 'addRule',
        rule: { id: 'rx', when: [{ fact: { type: 't' } }], derive: { alarm: 'a', level: 3 } },
      }),
    'UNKNOWN_FIELD',
  );

  // bad rules / conditions
  expectCode(
    () => engine.run({ cmd: 'addRule', rule: { id: 'rx', when: [], derive: { alarm: 'a' } } }),
    'INVALID_RULE',
  );
  expectCode(
    () => engine.run({ cmd: 'addRule', rule: { when: [{ fact: {} }], derive: { alarm: 'a' } } }),
    'INVALID_RULE',
  );
  expectCode(
    () =>
      engine.run({
        cmd: 'addRule',
        rule: { id: 'rx', when: [{ fact: { type: 't' }, alarm: 'a' }], derive: { alarm: 'b' } },
      }),
    'INVALID_CONDITION',
  );
  expectCode(
    () => engine.run({ cmd: 'addRule', rule: { id: 'rx', when: [{}], derive: { alarm: 'b' } } }),
    'INVALID_CONDITION',
  );
  expectCode(
    () =>
      engine.run({
        cmd: 'addRule',
        rule: { id: 'rx', when: [{ fact: { value: { $gteq: 1 } } }], derive: { alarm: 'b' } },
      }),
    'UNKNOWN_OPERATOR',
  );
  expectCode(
    () =>
      engine.run({
        cmd: 'addRule',
        rule: { id: 'rx', when: [{ fact: { value: { $in: 5 } } }], derive: { alarm: 'b' } },
      }),
    'INVALID_CONDITION',
  );

  // unknown targets
  expectCode(() => engine.run({ cmd: 'retract', id: 'nope' }), 'UNKNOWN_FACT');
  expectCode(() => engine.run({ cmd: 'removeRule', id: 'nope' }), 'UNKNOWN_RULE');

  // bad commands
  expectCode(() => engine.run({ cmd: 'explode' }), 'INVALID_COMMAND');
  expectCode(() => engine.run('append'), 'INVALID_COMMAND');
  expectCode(() => engine.run({ cmd: 'retract' }), 'INVALID_COMMAND');

  // undo with empty history
  expectCode(() => new Engine().run({ cmd: 'undo' }), 'EMPTY_HISTORY');

  // failed commands must not corrupt state or undo history
  const before = engine.getState();
  expectCode(() => engine.run({ cmd: 'retract', id: 'nope' }), 'UNKNOWN_FACT');
  assert.deepEqual(engine.getState(), before);
  engine.run({ cmd: 'undo' });
  assert.deepEqual(engine.getState().facts, []);
});
