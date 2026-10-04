import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTrace } from '../src/model';
import { dynamicSlice } from '../src/slice';
import { verifySliceReplay, checkMinimality } from '../src/verify';
import { genTrace, allCriteria } from '../src/gen';

const SEEDS = 60;
const MAX_EVENTS = 20;
const EXHAUSTIVE_LIMIT = 12;

test('exhaustive acceptance: slice, delete, replay, minimize over generated traces', () => {
  let traces = 0;
  let criteria = 0;
  let replayChecks = 0;
  let subsetsChecked = 0;
  let exhaustiveSlices = 0;
  let singleRemovalSlices = 0;
  let sliceSizeTotal = 0;
  let sliceSizeMax = 0;
  const failures: string[] = [];

  for (let seed = 0; seed < SEEDS; seed++) {
    const n = 1 + (seed % MAX_EVENTS);
    const { trace, initial } = genTrace(seed * 7919 + 13, n);
    validateTrace(trace);
    traces++;
    for (const criterion of allCriteria(trace, initial)) {
      criteria++;
      const slice = dynamicSlice(trace, criterion);
      sliceSizeTotal += slice.size;
      sliceSizeMax = Math.max(sliceSizeMax, slice.size);
      const check = verifySliceReplay(trace, slice, criterion, initial);
      replayChecks++;
      if (!check.ok) {
        failures.push(`seed=${seed} crit=${criterion.event}:${criterion.var} expected=${check.expected} actual=${check.actual}`);
        continue;
      }
      const min = checkMinimality(trace, slice, criterion, initial, EXHAUSTIVE_LIMIT);
      subsetsChecked += min.checked;
      if (min.mode === 'exhaustive') exhaustiveSlices++;
      if (min.mode === 'single-removal') singleRemovalSlices++;
      if (!min.ok) {
        failures.push(`seed=${seed} crit=${criterion.event}:${criterion.var} non-minimal, redundant subset=${min.counterexample}`);
      }
    }
  }

  console.log('--- acceptance results ---');
  console.log(`traces:              ${traces} (sizes 1..${MAX_EVENTS})`);
  console.log(`criteria:            ${criteria}`);
  console.log(`replay checks:       ${replayChecks} (full trace vs deleted trace)`);
  console.log(`subsets replayed:    ${subsetsChecked}`);
  console.log(`exhaustive slices:   ${exhaustiveSlices} (all proper subsets, |S| <= ${EXHAUSTIVE_LIMIT})`);
  console.log(`single-removal:      ${singleRemovalSlices} (|S| > ${EXHAUSTIVE_LIMIT})`);
  console.log(`slice size avg/max:  ${(sliceSizeTotal / criteria).toFixed(2)} / ${sliceSizeMax}`);
  console.log(`failures:            ${failures.length}`);
  for (const f of failures.slice(0, 10)) console.log(`  FAIL ${f}`);
  assert.equal(failures.length, 0, `${failures.length} failures`);
});

test('deterministic generator produces valid executed traces', () => {
  for (let seed = 0; seed < 20; seed++) {
    const { trace } = genTrace(seed, MAX_EVENTS);
    validateTrace(trace);
    const a = genTrace(seed, MAX_EVENTS);
    assert.deepEqual(
      a.trace.map((e) => [e.id, e.kind, e.reads, e.writes, e.controlDeps]),
      trace.map((e) => [e.id, e.kind, e.reads, e.writes, e.controlDeps]),
    );
  }
});
