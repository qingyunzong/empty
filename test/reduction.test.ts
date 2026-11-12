import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalRowOrder, rowKey } from '../src/canonical.ts';
import { JoinEngineError } from '../src/errors.ts';
import { reduceJoin } from '../src/reduction.ts';
import type { JoinInput, Row } from '../src/types.ts';
import {
  allAttributes,
  bruteForceJoin,
  cycleInput,
  disconnectedInput,
  emptyRelationInput,
  emptySharedKeyInput,
  joinKey,
  lineInput,
  relation,
  ripViolationInput,
  sameAttributeAcrossPathInput,
  starInput,
} from './helpers.ts';

test('root is the UTF-8 bytewise smallest relation and traversals are deterministic', () => {
  const result = reduceJoin(lineInput());
  assert.equal(result.plan.root, 'product');
  assert.deepEqual(result.plan.preorder, ['product', 'stock', 'supplier']);
  assert.deepEqual(result.plan.postorder, ['supplier', 'stock', 'product']);
  assert.deepEqual(result.plan.children['product'], ['stock']);
  assert.deepEqual(result.plan.children['stock'], ['supplier']);
});

test('duplicate full rows are deduplicated before reduction', () => {
  const result = reduceJoin(lineInput());
  assert.equal(result.reports['supplier'].rowReports.length, 3);
  const keys = result.reports['supplier'].rowReports.map((report) =>
    rowKey(report.row, ['sid', 'city']),
  );
  assert.equal(new Set(keys).size, 3);
});

test('surviving rows are emitted in canonical row order', () => {
  const input: JoinInput = {
    relations: [
      relation('t', ['s', 'n'], [
        { s: 'é', n: 2n },
        { s: 'a', n: 10n },
        { s: 'a', n: 2n },
        { s: 'A', n: 0n },
      ]),
    ],
    edges: [],
  };
  const result = reduceJoin(input);
  const ordered = canonicalRowOrder(input.relations[0].rows as Row[], ['n', 's']);
  assert.deepEqual(result.reduced['t'], ordered);
});

test('postorder semi-join removes rows with no child projection match', () => {
  const result = reduceJoin(lineInput());
  const stockReports = result.reports['stock'].rowReports;
  const orphan = stockReports.find((report) => report.row.sid === 9n)!;
  assert.equal(orphan.alive, false);
  assert.deepEqual(orphan.firstDeletedBy, { from: 'supplier', to: 'stock' });
  assert.deepEqual(orphan.missingKey, { sid: 9n });

  const productNut = result.reports['product'].rowReports.find(
    (report) => report.row.pid === 12n,
  )!;
  assert.equal(productNut.alive, false);
  assert.deepEqual(productNut.firstDeletedBy, { from: 'stock', to: 'product' });
  assert.deepEqual(productNut.missingKey, { pid: 12n });

  const supplierReports = result.reports['supplier'].rowReports;
  const guangzhou = supplierReports.find((report) => report.row.sid === 3n)!;
  assert.equal(guangzhou.alive, false);
  assert.deepEqual(guangzhou.firstDeletedBy, { from: 'stock', to: 'supplier' });
  assert.deepEqual(guangzhou.missingKey, { sid: 3n });
});

test('preorder semi-join removes rows whose reduced parent no longer supports them', () => {
  const result = reduceJoin(starInput());
  const centerK3 = result.reports['center'].rowReports.find((report) => report.row.k === 3n)!;
  assert.equal(centerK3.alive, false);
  assert.deepEqual(centerK3.firstDeletedBy, { from: 'leaf_a', to: 'center' });

  const leafB = result.reports['leaf_b'].rowReports;
  const k3 = leafB.find((report) => report.row.k === 3n)!;
  assert.equal(k3.alive, false);
  assert.deepEqual(k3.firstDeletedBy, { from: 'center', to: 'leaf_b' });
  assert.deepEqual(k3.missingKey, { k: 3n });

  const leafA = result.reports['leaf_a'].rowReports;
  assert.deepEqual(
    leafA.map((report) => [report.row.k, report.alive]),
    [[1n, true], [2n, false], [4n, false]],
  );
  const k4 = leafA.find((report) => report.row.k === 4n)!;
  assert.deepEqual(k4.firstDeletedBy, { from: 'center', to: 'leaf_a' });
  assert.deepEqual(k4.missingKey, { k: 4n });
  const k2 = leafA.find((report) => report.row.k === 2n)!;
  assert.deepEqual(k2.firstDeletedBy, { from: 'center', to: 'leaf_a' });
});

test('an empty relation empties every relation through the full reducer', () => {
  const result = reduceJoin(emptyRelationInput());
  assert.equal(result.isEmpty, true);
  assert.deepEqual(result.reduced['r1'], []);
  assert.deepEqual(result.reduced['r2'], []);
  assert.deepEqual(result.reduced['r3'], []);

  const r3Report = result.reports['r3'].rowReports[0];
  assert.equal(r3Report.alive, false);
  assert.deepEqual(r3Report.firstDeletedBy, { from: 'r2', to: 'r3' });
  assert.deepEqual(r3Report.missingKey, { y: 9n });
});

test('empty shared attributes keep everything when the neighbor still has rows', () => {
  const input = emptySharedKeyInput([{ a: 1n }], [{ b: 'x' }, { b: 'y' }]);
  const result = reduceJoin(input);
  assert.equal(result.isEmpty, false);
  assert.equal(result.reduced['alpha'].length, 1);
  assert.equal(result.reduced['bravo'].length, 2);
  for (const report of result.reports['alpha'].rowReports) {
    assert.equal(report.alive, true);
  }
});

test('empty shared attributes delete everything when the neighbor becomes empty', () => {
  const input = emptySharedKeyInput([{ a: 1n }], []);
  const result = reduceJoin(input);
  assert.equal(result.isEmpty, true);
  assert.equal(result.reduced['alpha'].length, 0);
  assert.equal(result.reduced['bravo'].length, 0);
  const report = result.reports['alpha'].rowReports[0];
  assert.deepEqual(report.firstDeletedBy, { from: 'bravo', to: 'alpha' });
  assert.deepEqual(report.missingKey, {});
});

test('an attribute spanning a non-connected induced subtree is rejected', () => {
  assert.throws(
    () => reduceJoin(ripViolationInput()),
    (error: unknown) =>
      error instanceof JoinEngineError &&
      error.code === 'RUNNING_INTERSECTION_VIOLATION',
  );
});

test('cycles and disconnected edge sets are rejected instead of optimized loosely', () => {
  assert.throws(
    () => reduceJoin(cycleInput()),
    (error: unknown) => error instanceof JoinEngineError && error.code === 'CYCLE_DETECTED',
  );
  assert.throws(
    () => reduceJoin(disconnectedInput()),
    (error: unknown) => error instanceof JoinEngineError && error.code === 'NOT_CONNECTED',
  );
});

test('same attribute across a path needs both passes to reach a fixed point', () => {
  const result = reduceJoin(sameAttributeAcrossPathInput());
  assert.deepEqual(result.reduced['a'].map((row) => row.k), [1n]);
  assert.deepEqual(result.reduced['b'].map((row) => row.k), [1n]);
  assert.deepEqual(result.reduced['c'].map((row) => row.k), [1n]);

  const removedFromB = result.reports['b'].rowReports;
  assert.deepEqual(
    removedFromB.find((report) => report.row.k === 5n)!.firstDeletedBy,
    { from: 'a', to: 'b' },
  );
  assert.deepEqual(
    removedFromB.find((report) => report.row.k === 2n)!.firstDeletedBy,
    { from: 'c', to: 'b' },
  );
  const removedFromA = result.reports['a'].rowReports.find((report) => report.row.k === 2n)!;
  assert.deepEqual(removedFromA.firstDeletedBy, { from: 'b', to: 'a' });
  const removedFromC = result.reports['c'].rowReports.find((report) => report.row.k === 5n)!;
  assert.deepEqual(removedFromC.firstDeletedBy, { from: 'b', to: 'c' });
});

test('each reduction step records the projection snapshot used at that moment', () => {
  const input = sameAttributeAcrossPathInput();
  const result = reduceJoin(input);

  const live = new Map<string, Set<Row>>();
  for (const item of input.relations) {
    const distinct = new Map<string, Row>();
    for (const row of item.rows) {
      distinct.set(rowKey(row, item.attributes), row);
    }
    live.set(item.name, new Set(distinct.values()));
  }

  for (const step of result.steps) {
    const sourceRows = [...live.get(step.from)!];
    const targetRows = [...live.get(step.to)!];
    if (step.sharedAttributes.length === 0) {
      if (sourceRows.length === 0) {
        assert.equal(step.deletedCount, targetRows.length);
        live.set(step.to, new Set());
      } else {
        assert.equal(step.deletedCount, 0);
      }
      continue;
    }
    const projection = new Set(
      sourceRows.map((row) => rowKey(row, step.sharedAttributes)),
    );
    const expectedDeletions = targetRows.filter(
      (row) => !projection.has(rowKey(row, step.sharedAttributes)),
    );
    assert.equal(step.deletedCount, expectedDeletions.length);

    for (const deleted of expectedDeletions) {
      const report = result.reports[step.to].rowReports.find(
        (candidate) => rowKey(candidate.row, result.plan.attributes[step.to]) ===
          rowKey(deleted, result.plan.attributes[step.to]),
      )!;
      if (report.firstDeletedBy?.from === step.from && report.firstDeletedBy.to === step.to) {
        for (const attribute of step.sharedAttributes) {
          assert.equal(report.missingKey![attribute], deleted[attribute]);
        }
      }
    }
    live.set(
      step.to,
      new Set(targetRows.filter((row) => projection.has(rowKey(row, step.sharedAttributes)))),
    );
  }

  for (const name of result.plan.relations) {
    assert.equal(live.get(name)!.size, result.reduced[name].length);
  }
});

test('reduced rows match the full Cartesian reference and every row participates', () => {
  for (const input of [
    lineInput(),
    starInput(),
    sameAttributeAcrossPathInput(),
    emptySharedKeyInput([{ a: 1n }, { a: 2n }], [{ b: 'x' }]),
  ]) {
    const result = reduceJoin(input);
    const reference = bruteForceJoin(input);
    const attributes = allAttributes(input);

    const reducedCartesian: Row[] = [];
    const visit = (
      relationIndex: number,
      merged: Map<string, bigint | string>,
    ): void => {
      if (relationIndex === result.plan.relations.length) {
        reducedCartesian.push(Object.fromEntries(merged));
        return;
      }
      const name = result.plan.relations[relationIndex];
      for (const row of result.reduced[name]) {
        const additions: Array<[string, bigint | string]> = [];
        let compatible = true;
        for (const attribute of result.plan.attributes[name]) {
          const existing = merged.get(attribute);
          if (existing !== undefined && existing !== row[attribute]) {
            compatible = false;
            break;
          }
          if (existing === undefined) {
            additions.push([attribute, row[attribute]]);
          }
        }
        if (!compatible) {
          continue;
        }
        for (const [attribute, value] of additions) {
          merged.set(attribute, value);
        }
        visit(relationIndex + 1, merged);
        for (const [attribute] of additions) {
          merged.delete(attribute);
        }
      }
    };
    visit(0, new Map());

    const referenceKeys = reference.map((row) => joinKey(row, attributes)).sort();
    const reducedKeys = reducedCartesian.map((row) => joinKey(row, attributes)).sort();
    assert.deepEqual(reducedKeys, referenceKeys);

    for (const name of result.plan.relations) {
      for (const surviving of result.reduced[name]) {
        const participates = reference.some((row) =>
          result.plan.attributes[name].every(
            (attribute) => row[attribute] === surviving[attribute],
          ),
        );
        assert.ok(participates, `surviving row of ${name} cannot extend to a full result`);
      }
    }
  }
});

test('global attribute domain mismatch is rejected', () => {
  const input: JoinInput = {
    relations: [
      relation('left', ['k'], [{ k: 1n }]),
      relation('right', ['k'], [{ k: '1' }]),
    ],
    edges: [['left', 'right']],
  };
  assert.throws(
    () => reduceJoin(input),
    (error: unknown) => error instanceof JoinEngineError && error.code === 'TYPE_MISMATCH',
  );
});

test('integer ordering is mathematical and string ordering is UTF-8 byte order', () => {
  const rows: Row[] = [
    { n: 100n, s: 'z' },
    { n: -9n, s: 'A' },
    { n: 2n, s: 'a' },
    { n: 10n, s: 'ä' },
  ];
  const ordered = canonicalRowOrder(rows, ['n', 's']);
  assert.deepEqual(ordered.map((row) => row.n), [-9n, 2n, 10n, 100n]);

  const strings = canonicalRowOrder(
    rows.map((row) => ({ s: row.s as string })),
    ['s'],
  );
  assert.deepEqual(strings.map((row) => row.s), ['A', 'a', 'z', 'ä']);
});
