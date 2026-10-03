'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RuleBase, RuleError } = require('../src/engine');
const { parse } = require('../src/regex');
const automata = require('../src/automata');
const backtrack = require('../src/backtrack');

// ---------------------------------------------------------------------------
// Acceptance 1: equivalent rewrites leave the equivalence witness empty and
// the snapshot hash unchanged.
// ---------------------------------------------------------------------------

test('acceptance 1: equivalent rule-set rewrites keep witness empty and hash stable', () => {
  const pairs = [
    // [rules before, rules after] — same languages, same alphabet
    [
      [['r1', 'red', 'A(B|C)'], ['y1', 'yellow', '(S*)*']],
      [['x1', 'red', 'AB|AC'], ['x2', 'yellow', 'S*']],
    ],
    [
      [['r1', 'red', 'A+'], ['r2', 'red', 'BA']],
      [['r1', 'red', 'AA*'], ['r2', 'red', 'BA']],
    ],
    [
      [['r1', 'red', '(AB)*AB']],
      [['r1', 'red', 'AB(AB)*']],
    ],
    [
      [['r1', 'red', 'A'], ['r2', 'red', 'A'], ['y1', 'yellow', 'B?']],
      [['r1', 'red', 'A'], ['y1', 'yellow', 'B?']],
    ],
  ];
  for (const [before, after] of pairs) {
    const a = new RuleBase();
    for (const [id, level, pattern] of before) a.add(id, level, pattern);
    const b = new RuleBase();
    for (const [id, level, pattern] of after) b.add(id, level, pattern);
    const eq = a.equivalentTo(b);
    assert.equal(eq.equal, true, `expected equivalent: ${JSON.stringify([before, after])}`);
    assert.equal(eq.witness, null);
    assert.equal(a.snapshotHash(), b.snapshotHash());
  }
});

test('acceptance 1: rewrite via del+add inside one log restores the same hash', () => {
  const base = new RuleBase();
  base.add('r1', 'red', 'A(B|C)');
  base.add('y1', 'yellow', 'S');
  const before = base.snapshotHash();
  base.del('r1');
  base.add('r1', 'red', 'AB|AC');
  assert.equal(base.snapshotHash(), before);
});

test('acceptance 1: non-equivalent sets yield a shortest distinguishing witness', () => {
  const a = new RuleBase();
  a.add('r1', 'red', 'AB');
  const b = new RuleBase();
  b.add('r1', 'red', 'BA');
  const eq = a.equivalentTo(b);
  assert.equal(eq.equal, false);
  assert.equal(eq.level, 'red');
  assert.equal(eq.witness, 'AB'); // shortest string matched by exactly one side

  const c = new RuleBase();
  c.add('y1', 'yellow', 'S*');
  const d = new RuleBase();
  d.add('y1', 'yellow', 'S+');
  const eq2 = c.equivalentTo(d);
  assert.equal(eq2.equal, false);
  assert.equal(eq2.level, 'yellow');
  assert.equal(eq2.witness, ''); // S* matches the empty plan, S+ does not
});

// ---------------------------------------------------------------------------
// Acceptance 2: red matches take priority over yellow; witness is a shortest
// counterexample.
// ---------------------------------------------------------------------------

test('acceptance 2: red hit wins over yellow and reports the shortest counterexample', () => {
  const base = new RuleBase();
  base.add('y1', 'yellow', 'A');
  base.add('r1', 'red', 'AB');
  const res = base.classify('AB');
  assert.equal(res.status, 'reject');
  assert.deepEqual(res.matchedRuleIds, ['r1']);
  assert.equal(res.witness, 'AB');
});

test('acceptance 2: witness is the shortest red-matching substring', () => {
  const base = new RuleBase();
  base.add('r1', 'red', 'BABA');
  base.add('r2', 'red', 'AB');
  base.add('y1', 'yellow', 'B');
  const res = base.classify('BABAB');
  assert.equal(res.status, 'reject');
  assert.deepEqual(res.matchedRuleIds, ['r1', 'r2']);
  assert.equal(res.witness, 'AB');

  // yellow is shorter, red still wins
  const base2 = new RuleBase();
  base2.add('y1', 'yellow', 'B');
  base2.add('r1', 'red', 'ABA');
  const res2 = base2.classify('ABA');
  assert.equal(res2.status, 'reject');
  assert.equal(res2.witness, 'ABA');
});

test('acceptance 2: confirm and feasible statuses', () => {
  const base = new RuleBase();
  base.add('y1', 'yellow', 'SA');
  base.add('r1', 'red', 'FF');
  const confirm = base.classify('SSA');
  assert.equal(confirm.status, 'confirm');
  assert.deepEqual(confirm.matchedRuleIds, ['y1']);
  assert.equal(confirm.witness, 'SA');
  const ok = base.classify('SAS');
  assert.equal(ok.status, 'feasible');
  assert.deepEqual(ok.matchedRuleIds, []);
  assert.equal(ok.witness, null);
});

// ---------------------------------------------------------------------------
// Acceptance 3: interleaved add/del/undo/redo matches a full-log replay.
// Failed operations must not pollute existing layers.
// ---------------------------------------------------------------------------

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

// Reference model: undo/redo via a layer pointer, state rebuilt by replaying
// the effective log (layers[0..pointer)) into a fresh RuleBase.
class ReplayModel {
  constructor() {
    this.layers = [];
    this.pointer = 0;
  }
  _truncate() {
    this.layers.length = this.pointer;
  }
  add(id, level, pattern) {
    this._truncate();
    this.layers.push({ op: 'add', id, level, pattern });
    this.pointer++;
  }
  del(id) {
    this._truncate();
    this.layers.push({ op: 'del', id });
    this.pointer++;
  }
  undo(k) {
    this.pointer -= k;
  }
  redo(k) {
    this.pointer += k;
  }
  replay() {
    const base = new RuleBase();
    const patterns = new Map();
    for (let i = 0; i < this.pointer; i++) {
      const layer = this.layers[i];
      if (layer.op === 'add') {
        base.add(layer.id, layer.level, layer.pattern);
        patterns.set(layer.id, layer.pattern);
      } else {
        base.del(layer.id);
        patterns.delete(layer.id);
      }
    }
    return { base, patterns };
  }
}

test('acceptance 3: interleaved undo/redo equals full-log replay', () => {
  const rand = mulberry32(20261003);
  const patterns = ['A', 'B', 'AB', 'A|B', '(AB)*', 'A+', 'A?B', '(A|B)+', 'S', 'SA*B', ''];
  const ids = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5'];
  const plans = ['', 'A', 'AB', 'SAB', 'BAAB', 'SS', 'ABABA'];

  const engine = new RuleBase();
  const model = new ReplayModel();

  const compare = (step) => {
    const { base: replayed } = model.replay();
    assert.equal(
      engine.snapshotHash(),
      replayed.snapshotHash(),
      `hash mismatch at step ${step}`,
    );
    for (const plan of plans) {
      assert.deepEqual(engine.classify(plan), replayed.classify(plan), `classify(${plan}) at step ${step}`);
    }
  };

  const liveIds = () => [...engine.rules.keys()];

  for (let step = 0; step < 300; step++) {
    const roll = rand();
    const idsNow = liveIds();
    if (roll < 0.35 || idsNow.length === 0) {
      const free = ids.filter((id) => !engine.rules.has(id));
      if (free.length === 0) continue;
      const id = free[Math.floor(rand() * free.length)];
      const level = rand() < 0.5 ? 'red' : 'yellow';
      const pattern = patterns[Math.floor(rand() * patterns.length)];
      engine.add(id, level, pattern);
      model.add(id, level, pattern);
    } else if (roll < 0.6) {
      const id = idsNow[Math.floor(rand() * idsNow.length)];
      engine.del(id);
      model.del(id);
    } else if (roll < 0.8 && engine.layers.length > 0) {
      const k = 1 + Math.floor(rand() * engine.layers.length);
      engine.undo(k);
      model.undo(k);
    } else if (engine.redoStack.length > 0) {
      const k = 1 + Math.floor(rand() * engine.redoStack.length);
      engine.redo(k);
      model.redo(k);
    } else {
      continue;
    }
    if (step % 7 === 0) compare(step);
  }
  compare('final');
});

test('acceptance 3: failed operations do not pollute existing layers', () => {
  const base = new RuleBase();
  base.add('r1', 'red', 'AB');
  base.add('y1', 'yellow', 'S');
  const h0 = base.snapshotHash();
  const depth = base.layers.length;

  assert.throws(() => base.add('r2', 'red', 'A(B'), (e) => e.name === 'RegexSyntaxError');
  assert.throws(() => base.del('ghost'), (e) => e instanceof RuleError && e.code === 'UNKNOWN_ID');
  assert.throws(() => base.add('r1', 'red', 'C'), (e) => e instanceof RuleError && e.code === 'DUP_ID');
  assert.throws(() => base.undo(99), (e) => e instanceof RuleError && e.code === 'UNDO_RANGE');
  assert.throws(() => base.redo(1), (e) => e instanceof RuleError && e.code === 'REDO_RANGE');

  assert.equal(base.snapshotHash(), h0);
  assert.equal(base.layers.length, depth);
  assert.equal(base.redoStack.length, 0);

  // undo/redo still behave exactly as if the failures never happened
  base.undo(1);
  const onlyRed = new RuleBase();
  onlyRed.add('r1', 'red', 'AB');
  assert.equal(base.snapshotHash(), onlyRed.snapshotHash());
  base.redo(1);
  assert.equal(base.snapshotHash(), h0);
});

// ---------------------------------------------------------------------------
// Acceptance 4: exhaustive enumeration of all plans up to length 8 checked
// against an independent backtracking matcher.
// ---------------------------------------------------------------------------

function* enumerate(alphabet, maxLen) {
  yield '';
  const prefixes = [''];
  for (let len = 1; len <= maxLen; len++) {
    const next = [];
    for (const p of prefixes) {
      for (const ch of alphabet) {
        const s = p + ch;
        next.push(s);
        yield s;
      }
    }
    prefixes.length = 0;
    prefixes.push(...next);
  }
}

test('acceptance 4: DFA matcher agrees with backtracking matcher on all strings up to length 8', () => {
  const alphabet = ['A', 'B'];
  const patterns = [
    'A', 'B', 'AB', 'BA', 'A|B', '(A|B)*', 'A+', 'A*B', '(AB)+', 'A?B?',
    '(A|B)*A(A|B)', 'AAB|BA', '', '(A|B)(A|B)(A|B)', '((A)*)*',
  ];
  const strings = [...enumerate(alphabet, 8)];
  assert.equal(strings.length, 511);
  for (const pattern of patterns) {
    const ast = parse(pattern);
    const full = automata.compileFull([ast], alphabet);
    const contains = automata.compileContains([ast], alphabet);
    for (const s of strings) {
      assert.equal(
        automata.acceptsString(full, s),
        backtrack.fullMatch(ast, s),
        `full match mismatch: pattern=${JSON.stringify(pattern)} s=${JSON.stringify(s)}`,
      );
      assert.equal(
        automata.acceptsString(contains, s),
        backtrack.containsMatch(ast, s),
        `contains mismatch: pattern=${JSON.stringify(pattern)} s=${JSON.stringify(s)}`,
      );
    }
  }
});

test('acceptance 4: classification agrees with backtracking reference on all strings up to length 8', () => {
  const alphabet = ['A', 'B'];
  const base = new RuleBase();
  base.add('r1', 'red', 'AB');
  base.add('r2', 'red', '(BA)+');
  base.add('y1', 'yellow', 'AA');
  base.add('y2', 'yellow', 'B?A(B|A)');
  const ruleAsts = [...base.rules.entries()].map(([id, r]) => [id, r.level, parse(r.pattern)]);

  const reference = (plan) => {
    const red = [];
    const yellow = [];
    for (const [id, level, ast] of ruleAsts) {
      if (backtrack.containsMatch(ast, plan)) (level === 'red' ? red : yellow).push(id);
    }
    const decisive = (red.length ? red : yellow).sort();
    let witness = null;
    if (decisive.length) {
      const asts = ruleAsts.filter(([id]) => decisive.includes(id)).map(([, , ast]) => ast);
      outer: for (let len = 0; len <= plan.length; len++) {
        for (let i = 0; i + len <= plan.length; i++) {
          const slice = plan.slice(i, i + len);
          if (asts.some((ast) => backtrack.fullMatch(ast, slice))) {
            witness = slice; // first hit at this length scans left to right
            // keep the lexicographically smallest at this length
            for (let j = i + 1; j + len <= plan.length; j++) {
              const other = plan.slice(j, j + len);
              if (other < witness && asts.some((ast) => backtrack.fullMatch(ast, other))) {
                witness = other;
              }
            }
            break outer;
          }
        }
      }
    }
    return {
      status: red.length ? 'reject' : yellow.length ? 'confirm' : 'feasible',
      matchedRuleIds: decisive,
      witness,
    };
  };

  for (const s of enumerate(alphabet, 8)) {
    assert.deepEqual(base.classify(s), reference(s), `classify(${JSON.stringify(s)})`);
  }
});
