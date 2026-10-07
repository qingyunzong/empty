import { bindSource, runDifferential } from './diff';
import { Op } from './sut';
import { ReferenceQueue } from './impl/referenceQueue';
import { BuggyCancelQueue } from './impl/buggyCancelQueue';

const SRC = __dirname + '/../../src';

async function main(): Promise<void> {
  const ops: Op[] = [
    { kind: 'submit', name: 'render' },
    { kind: 'submit', name: 'index' },
    { kind: 'cancel', id: 'j1' },
    { kind: 'status', id: 'j1' },
    { kind: 'tick' },
    { kind: 'tick' },
    { kind: 'tick' },
  ];
  const report = await runDifferential({
    ops,
    plan: { seed: 11, maxDelay: 3 },
    a: {
      binding: bindSource('reference', `${SRC}/impl/referenceQueue.ts`),
      make: (s) => new ReferenceQueue(s),
    },
    b: {
      binding: bindSource('buggy-cancel', `${SRC}/impl/buggyCancelQueue.ts`),
      make: (s) => new BuggyCancelQueue(s),
    },
  });
  console.log(JSON.stringify(report, null, 2));
}

void main();
