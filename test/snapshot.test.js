import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSnapshot,
  resolve,
  correct,
  visibleValues,
  ResolveError,
  OverrideError,
} from '../src/index.js';

// Acceptance 1: three-level nesting, same-name param resolves to the nearest
// scope, and the full scope chain is reported.
test('three-level nesting resolves to nearest scope with full chain', () => {
  const snap = createSnapshot(`
    experiment outer {
      let rate = 1;
      experiment mid {
        let rate = 2;
        experiment inner {
          let rate = 3;
          let derived = rate * 10;
        }
      }
    }
  `);
  const result = resolve(snap, 'rate', 'outer.mid.inner');
  assert.equal(result.value, 3);
  assert.equal(result.definedIn, 'root.outer.mid.inner');
  assert.deepEqual(
    result.chain.map((c) => ({ scope: c.scope, hasBinding: c.hasBinding })),
    [
      { scope: 'inner', hasBinding: true },
      { scope: 'mid', hasBinding: true },
      { scope: 'outer', hasBinding: true },
      { scope: 'root', hasBinding: false },
    ],
  );
  // inner `rate` shadows outer ones for references made inside inner
  assert.equal(resolve(snap, 'derived', 'outer.mid.inner').value, 30);
  // outer scopes still see their own bindings
  assert.equal(resolve(snap, 'rate', 'outer.mid').value, 2);
  assert.equal(resolve(snap, 'rate', 'outer').value, 1);
});

test('override corrects the nearest existing binding only', () => {
  const snap = createSnapshot(`
    let x = 1;
    experiment e {
      let x = 2;
      override x = 9;
    }
    experiment f {
      override x = 7;
    }
  `);
  assert.equal(resolve(snap, 'x', 'e').value, 9);
  assert.equal(resolve(snap, 'x', 'f').value, 7);
  assert.equal(resolve(snap, 'x').value, 7);
});

// Acceptance 2: override of a nonexistent binding fails; the original
// snapshot is unchanged.
test('override of undefined binding fails and snapshot stays intact', () => {
  assert.throws(
    () => createSnapshot('experiment e { override missing = 5; }'),
    (err) => {
      assert.ok(err instanceof OverrideError);
      assert.match(err.message, /undefined binding 'missing'/);
      return true;
    },
  );

  const snap = createSnapshot('let a = 1; let b = a + 1;');
  const before = visibleValues(snap);
  const versionBefore = snap.version;
  assert.throws(() => correct(snap, 'nope', '5'), OverrideError);
  assert.equal(snap.version, versionBefore);
  assert.deepEqual(visibleValues(snap), before);
  assert.deepEqual(visibleValues(snap), { a: 1, b: 2 });
});

// Acceptance 3: incremental correct on a small snapshot; parent and child
// versions coexist and the child matches a hand-enumerated binding table.
test('incremental correct: parent and child coexist with expected tables', () => {
  const parent = createSnapshot(`
    let a = 1;
    let b = a + 1;
    let c = b * 10;
    let note = \`obs (raw) # kept\`;
  `);
  const child = correct(parent, 'a', '5');

  assert.equal(child.parentVersion, parent.version);
  assert.notEqual(child.version, parent.version);

  // hand-enumerated visible binding tables
  assert.deepEqual(visibleValues(child), { a: 5, b: 6, c: 60, note: 'obs (raw) # kept' });
  assert.deepEqual(visibleValues(parent), { a: 1, b: 2, c: 20, note: 'obs (raw) # kept' });

  // corrections can chain: each version stays usable
  const grandchild = correct(child, 'b', '100');
  assert.equal(grandchild.parentVersion, child.version);
  assert.deepEqual(visibleValues(grandchild), { a: 5, b: 100, c: 1000, note: 'obs (raw) # kept' });
  assert.deepEqual(visibleValues(child), { a: 5, b: 6, c: 60, note: 'obs (raw) # kept' });
  assert.deepEqual(visibleValues(parent), { a: 1, b: 2, c: 20, note: 'obs (raw) # kept' });
});

test('unknown name resolution is an error', () => {
  const snap = createSnapshot('let a = 1;');
  assert.throws(() => resolve(snap, 'ghost'), ResolveError);
  const bad = createSnapshot('let b = ghost + 1;');
  assert.throws(() => resolve(bad, 'b'), ResolveError);
});
