import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, minimumSetCovers } from '../src/index.js';
import { T0, MIN, temp, ship } from '../testlib/helpers.js';

// Acceptance 3: with <= 4 lots the minimum cover is enumerated exactly and
// all tied minimum solutions are listed in lexicographic lot order.
function fourLotScenario() {
  return [
    temp('t1', T0, 'Z', -10),
    temp('t2', T0 + MIN, 'Z', -20),
    temp('t3', T0 + 10 * MIN, 'Z', -9),
    temp('t4', T0 + 11 * MIN, 'Z', -20),
    ship('s1', T0 + 12 * MIN, 'A', 'Z', T0 - 10_000, T0 + 30_000),
    ship('s2', T0 + 12 * MIN + 1, 'B', 'Z', T0 - 10_000, T0 + 30_000),
    ship('s3', T0 + 12 * MIN + 2, 'C', 'Z', T0 + 10 * MIN + 10_000, T0 + 10 * MIN + 50_000),
    ship('s4', T0 + 12 * MIN + 3, 'D', 'Z', T0 + 10 * MIN + 10_000, T0 + 10 * MIN + 50_000),
  ];
}

test('enumerates all tied minimum covers, lexicographically ordered', () => {
  const result = analyze(fourLotScenario());
  assert.equal(result.counts.unexplainedWindows, 2);
  assert.equal(result.recall.minimalSize, 2);
  assert.equal(result.recall.exact, true);
  assert.deepEqual(result.recall.solutions, [
    ['A', 'C'],
    ['A', 'D'],
    ['B', 'C'],
    ['B', 'D'],
  ]);
  assert.deepEqual(result.recall.lots, ['A', 'C']);
});

test('single lot covering every window wins over pairs', () => {
  const events = [
    temp('t1', T0, 'Z', -10),
    temp('t2', T0 + MIN, 'Z', -20),
    temp('t3', T0 + 10 * MIN, 'Z', -9),
    temp('t4', T0 + 11 * MIN, 'Z', -20),
    ship('s1', T0 + 12 * MIN, 'A', 'Z', T0 - 10_000, T0 + 30_000),
    ship('s2', T0 + 12 * MIN + 1, 'B', 'Z', T0 + 10 * MIN + 10_000, T0 + 10 * MIN + 50_000),
    ship('s3', T0 + 12 * MIN + 2, 'E', 'Z', T0 - 10_000, T0 + 11 * MIN),
  ];
  const result = analyze(events);
  assert.equal(result.recall.minimalSize, 1);
  assert.deepEqual(result.recall.solutions, [['E']]);
});

test('minimumSetCovers unit: empty universe yields the empty set', () => {
  const result = minimumSetCovers([]);
  assert.equal(result.size, 0);
  assert.deepEqual(result.solutions, [[]]);
});

test('minimumSetCovers unit: uncoverable windows are ignored', () => {
  const result = minimumSetCovers([{ lots: [] }, { lots: ['X'] }]);
  assert.equal(result.size, 1);
  assert.deepEqual(result.solutions, [['X']]);
});

test('minimumSetCovers unit: brute-force cross-check on random instances', () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let trial = 0; trial < 50; trial += 1) {
    const lots = ['L1', 'L2', 'L3', 'L4'];
    const windowCount = 1 + Math.floor(rand() * 4);
    const windows = Array.from({ length: windowCount }, () => ({
      lots: lots.filter(() => rand() < 0.5),
    }));
    const result = minimumSetCovers(windows);

    const universe = windows.filter((w) => w.lots.length > 0);
    const usedLots = [...new Set(universe.flatMap((w) => w.lots))];
    let bruteBest = Infinity;
    const bruteSolutions = [];
    for (let mask = 0; mask < 2 ** usedLots.length; mask += 1) {
      const chosen = usedLots.filter((_, i) => mask & (1 << i));
      if (chosen.length > bruteBest) continue;
      const covered = universe.every((w) => w.lots.some((lot) => chosen.includes(lot)));
      if (!covered) continue;
      if (chosen.length < bruteBest) {
        bruteBest = chosen.length;
        bruteSolutions.length = 0;
      }
      bruteSolutions.push([...chosen].sort());
    }
    bruteSolutions.sort((a, b) => a.join('').localeCompare(b.join('')));
    assert.equal(result.size, bruteBest === Infinity ? 0 : bruteBest);
    assert.deepEqual(result.solutions, bruteSolutions.length ? bruteSolutions : [[]]);
  }
});
