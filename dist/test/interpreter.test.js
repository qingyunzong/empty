import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScript, BudgetExhausted, ParseError, ScriptError, } from '../src/index.js';
const show = (v) => JSON.parse(JSON.stringify(v));
test('integers, arithmetic, variables', () => {
    const r = runScript('let x = 2 + 3 * 4; let y = (x - 4) / 2; return x * 100 + y;');
    assert.equal(r.value, 1405);
});
test('lists, dicts, indexing, len', () => {
    const r = runScript(`
    let a = [1, 2, 3];
    let d = {"name": "n", "nums": a};
    return len(a) + len(d) + d["nums"][1] + len("hi");
  `);
    assert.equal(r.value, 3 + 2 + 2 + 2);
});
test('dict/list equality and string concat', () => {
    const r = runScript(`
    let ok = [1, {"k": 2}] == [1, {"k": 2}];
    return ok && "ab" + "cd" == "abcd";
  `);
    assert.equal(r.value, true);
});
test('while loop with back-edge counting', () => {
    const r = runScript(`
    let i = 0;
    let sum = 0;
    while (i < 10) {
      sum = sum + i;
      i = i + 1;
    }
    return sum;
  `);
    assert.equal(r.value, 45);
    // Steps: 2 lets + 10*(cond + body) + final cond + 10 back-edges + return.
    assert.ok(r.steps > 30, `expected > 30 steps, got ${r.steps}`);
});
test('if/else and comparisons', () => {
    const r = runScript(`
    let x = 7;
    if (x >= 7 && !(x < 7)) { return "big"; } else { return "small"; }
  `);
    assert.equal(r.value, 'big');
});
test('transactional writes publish on normal exit', () => {
    const host = new Map();
    const r = runScript(`
    set("a", 1 + 1);
    set("b", [1, {"x": true}]);
    return "done";
  `, { host });
    assert.equal(r.value, 'done');
    assert.deepEqual(show(host.get('a')), 2);
    assert.deepEqual(show(host.get('b')), [1, { x: true }]);
    assert.deepEqual(show(r.writes), { a: 2, b: [1, { x: true }] });
});
test('budget exhaustion inside loop leaves host untouched', () => {
    const host = new Map();
    assert.throws(() => runScript(`
      let i = 0;
      while (i < 1000000) {
        set("partial", i);
        i = i + 1;
      }
    `, { host, budget: 500 }), (e) => e instanceof BudgetExhausted);
    assert.equal(host.size, 0, 'no partial writes may leak');
});
test('budget boundary: exact steps succeed, one fewer fails', () => {
    const src = `
    let i = 0;
    let s = 0;
    while (i < 20) { s = s + i; i = i + 1; }
    set("s", s);
    return s;
  `;
    const full = runScript(src, { budget: 1_000_000 });
    const okHost = new Map();
    const ok = runScript(src, { budget: full.steps, host: okHost });
    assert.equal(ok.value, 190);
    assert.equal(okHost.get('s'), 190);
    const shortHost = new Map();
    assert.throws(() => runScript(src, { budget: full.steps - 1, host: shortHost }), BudgetExhausted);
    assert.equal(shortHost.size, 0);
});
test('malicious deep nesting: no partial modification leaks', () => {
    const host = new Map();
    // Deeply nested expression AFTER a set(): budget dies mid-evaluation.
    const deep = '1' + ' + 1'.repeat(5000);
    assert.throws(() => runScript(`set("leak", 1); let x = ${deep}; return x;`, {
        host,
        budget: 1000,
    }), BudgetExhausted);
    assert.equal(host.size, 0, 'unclosed state must not publish writes');
    // Deeply nested list literal exceeding the parser depth cap.
    const nested = '['.repeat(10_000) + ']'.repeat(10_000);
    assert.throws(() => runScript(`set("leak", 1); return ${nested};`, { host }), ParseError);
    assert.equal(host.size, 0);
});
test('runtime error after set() does not commit', () => {
    const host = new Map();
    assert.throws(() => runScript('set("a", 1); let z = 1 / 0;', { host }), ScriptError);
    assert.equal(host.size, 0);
});
test('no host object access: prototypes and globals unreachable', () => {
    // Missing dict key (incl. prototype names) is an error, not a host lookup.
    assert.throws(() => runScript('let d = {"a": 1}; return d["constructor"];'), ScriptError);
    // No globals leak into the sandbox.
    assert.throws(() => runScript('return process;'), ScriptError);
    assert.throws(() => runScript('return globalThis;'), ScriptError);
    // Assignment to an undefined variable is rejected.
    assert.throws(() => runScript('x = 1;'), ScriptError);
});
test('set() requires a string key', () => {
    assert.throws(() => runScript('set(1, 2);'), ScriptError);
});
test('program without return yields null', () => {
    const r = runScript('let x = 1;');
    assert.equal(r.value, null);
});
