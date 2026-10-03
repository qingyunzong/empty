import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenize, LexError } from '../src/lexer.js';
import { parse, ParseError } from '../src/parser.js';
import {
  buildProgram,
  resolve,
  visibleTables,
  deepestScope,
  ScopeError,
} from '../src/scope.js';
import { SnapshotStore } from '../src/snapshot.js';
import { run as runCli } from '../cli.js';

const NESTED = `
let x = 1;
experiment outer {
  let x = 2;
  let y = x + 10;
  experiment mid {
    let x = 3;
    experiment inner {
      let z = x * 2;
    }
  }
}
`;

const SMALL = `
let a = 1;
let b = a + 1;
experiment cfg {
  let a = 10;
  let c = a * 2;
}
`;

function build(source) {
  return buildProgram(parse(source));
}

test('lexer: raw observations keep parens and # literally; comments stripped', () => {
  const tokens = tokenize('let n = `obs (a) [b] # still raw ;` ; # gone\nlet x = 1;');
  const raw = tokens.find((t) => t.type === 'raw');
  assert.equal(raw.value, 'obs (a) [b] # still raw ;');
  assert.equal(tokens.filter((t) => t.type === 'ident' && t.value === 'gone').length, 0);
});

test('lexer: unclosed raw observation is an error', () => {
  assert.throws(() => tokenize('let n = `never closed'), LexError);
});

test('parser: Pratt precedence and parentheses', () => {
  const root = build('let v = 1 + 2 * 3; let w = (1 + 2) * 3; let u = -v + w;');
  const tables = visibleTables(root);
  const get = (n) => tables[0].bindings.find((b) => b.name === n).value;
  assert.equal(get('v'), 7);
  assert.equal(get('w'), 9);
  assert.equal(get('u'), 2);
});

test('acceptance 1: three-level nesting resolves to nearest scope with full chain', () => {
  const root = build(NESTED);
  const inner = root.children[0].children[0].children[0];
  assert.equal(inner.name, 'inner');

  const x = resolve(root, inner.id, 'x');
  assert.equal(x.value, 3); // mid's x shadows outer's and root's
  assert.equal(x.definedIn, 'mid');
  assert.deepEqual(x.chain, ['inner', 'mid', 'outer', '<root>']);

  const z = resolve(root, inner.id, 'z');
  assert.equal(z.value, 6); // z = x * 2 with x = 3

  const outerScope = root.children[0];
  const y = resolve(root, outerScope.id, 'y');
  assert.equal(y.value, 12); // y = x + 10 with outer x = 2
  assert.deepEqual(y.chain, ['outer', '<root>']);
});

test('acceptance 2: override of undefined binding fails; snapshot untouched', () => {
  // DSL-level override of a nonexistent binding
  assert.throws(
    () => build('experiment a { override nope = 5; }'),
    /override 'nope' has no existing binding/,
  );
  // valid override corrects the nearest existing binding
  const root = build('let x = 1; experiment e { override x = 9; let y = x; }');
  const e = root.children[0];
  assert.equal(resolve(root, e.id, 'y').value, 9);
  assert.equal(resolve(root, e.id, 'x').definedIn, '<root>');

  // store-level correct of a nonexistent binding
  const store = new SnapshotStore();
  const v1 = store.commit(build(SMALL));
  const before = visibleTables(store.materialize(v1));
  assert.throws(() => store.correct(v1, 'missing', '42'), /cannot correct undefined binding 'missing'/);
  assert.deepEqual(store.versions(), [v1]); // no new version created
  assert.deepEqual(visibleTables(store.materialize(v1)), before); // parent unchanged
});

test('acceptance 3: incremental correct; parent and child coexist with manual table', () => {
  const store = new SnapshotStore();
  const v1 = store.commit(build(SMALL));
  const v2 = store.correct(v1, 'a', '5'); // nearest 'a' is cfg's a = 10

  assert.deepEqual(store.versions(), [1, 2]);

  // manually enumerated visible binding tables
  const manualParent = [
    { scopeName: '<root>', bindings: { a: 1, b: 2 } },
    { scopeName: 'cfg', bindings: { a: 10, b: 2, c: 20 } },
  ];
  const manualChild = [
    { scopeName: '<root>', bindings: { a: 1, b: 2 } },
    { scopeName: 'cfg', bindings: { a: 5, b: 2, c: 10 } },
  ];

  const toMap = (tables) =>
    tables.map((t) => ({
      scopeName: t.scopeName,
      bindings: Object.fromEntries(t.bindings.map((b) => [b.name, b.value])),
    }));

  assert.deepEqual(toMap(visibleTables(store.materialize(v1))), manualParent);
  assert.deepEqual(toMap(visibleTables(store.materialize(v2))), manualChild);

  // corrected binding is marked, parent binding kind is untouched
  const childCfg = visibleTables(store.materialize(v2))[1];
  assert.equal(childCfg.bindings.find((b) => b.name === 'a').kind, 'corrected');
  const parentCfg = visibleTables(store.materialize(v1))[1];
  assert.equal(parentCfg.bindings.find((b) => b.name === 'a').kind, 'let');
});

test('unknown name is an error', () => {
  const root = build('let x = 1;');
  assert.throws(() => resolve(root, deepestScope(root).id, 'nope'), /unknown name 'nope'/);
  assert.throws(() => build('let y = q + 1;') && visibleTables(build('let y = q + 1;')), ScopeError);
});

test('CLI: parse/resolve/correct exit codes and output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'expdsl-'));
  const dsl = join(dir, 'small.dsl');
  const storePath = join(dir, 'store.json');
  writeFileSync(dsl, SMALL);

  const parsed = runCli(['parse', dsl, '--store', storePath]);
  assert.equal(parsed.code, 0);
  assert.match(parsed.stdout, /snapshot v1/);
  assert.match(parsed.stdout, /scope cfg/);

  const resolved = runCli(['resolve', dsl, 'a', '--in', 'cfg']);
  assert.equal(resolved.code, 0);
  assert.match(resolved.stdout, /a = 10/);
  assert.match(resolved.stdout, /cfg\s+<-- resolved here/);

  const corrected = runCli(['correct', storePath, '1', 'a', '5']);
  assert.equal(corrected.code, 0);
  assert.match(corrected.stdout, /snapshot v2/);
  assert.match(corrected.stdout, /a = 5\s+\[corrected/);

  // parent snapshot still resolvable from the store
  const parent = runCli(['resolve', `${storePath}@1`, 'a', '--in', 'cfg']);
  assert.equal(parent.code, 0);
  assert.match(parent.stdout, /a = 10/);

  // errors exit with code 1
  assert.equal(runCli(['resolve', dsl, 'missing']).code, 1);
  assert.equal(runCli(['correct', storePath, '1', 'missing', '1']).code, 1);
  const bad = join(dir, 'bad.dsl');
  writeFileSync(bad, 'let n = `oops');
  assert.equal(runCli(['parse', bad]).code, 1);
  writeFileSync(join(dir, 'ovr.dsl'), 'experiment e { override nope = 1; }');
  assert.equal(runCli(['parse', join(dir, 'ovr.dsl')]).code, 1);
});
