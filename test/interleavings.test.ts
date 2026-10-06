import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus, type Subscription } from '../src/event-bus.js';
import { sleep, watchdog } from './helpers/util.js';

// Enumerates interleavings of nested publish x cancel x remove and proves
// every combination settles (watchdog-guarded) with the expected trace
// invariants. Covered axes:
//   depth       1..3 levels of nested publishes
//   awaitChild  derived publish awaited vs fire-and-forget
//   cancel      none | cancel root mid-dispatch | cancel child mid-dispatch
//   removal     none | self removeAndWait | bystander removeAndWait |
//               ancestor removeAndWait from the deepest nested callback

const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

type CancelMode = 'none' | 'root' | 'child';
type RemovalMode = 'none' | 'self' | 'bystander' | 'ancestor';

interface Scenario {
  readonly depth: number;
  readonly awaitChild: boolean;
  readonly cancel: CancelMode;
  readonly removal: RemovalMode;
}

async function runScenario(scenario: Scenario): Promise<string[]> {
  const bus = new EventBus();
  const trace: string[] = [];
  const topics = Array.from({ length: scenario.depth + 1 }, (_, i) => `L${i}`);
  const controllers = topics.map(() => new AbortController());
  const chain: Subscription[] = [];
  // A bystander subscription that is never published to: removeAndWait on it
  // must resolve immediately.
  const bystander = bus.subscribe('bystander', () => {});

  for (let level = 0; level <= scenario.depth; level++) {
    const subscription = bus.subscribe(topics[level]!, async (_payload, ctx) => {
      trace.push(`enter:${level}`);
      await sleep(1); // yield, then reenter: the interesting async case
      if (scenario.cancel === 'root' && level === 0) controllers[0]!.abort();
      if (scenario.cancel === 'child' && level === 1) controllers[1]!.abort();
      if (scenario.removal === 'self') await ctx.subscription.removeAndWait();
      if (scenario.removal === 'bystander') await bystander.removeAndWait();
      if (scenario.removal === 'ancestor' && level === scenario.depth) {
        await chain[0]!.removeAndWait();
      }
      if (level < scenario.depth) {
        const derived = bus.publishAsync(topics[level + 1]!, null, {
          signal: controllers[level + 1]!.signal,
        });
        if (scenario.awaitChild) await derived;
      }
      trace.push(`exit:${level}`);
    });
    chain.push(subscription);
  }
  // Second callback on L0 and L1 to make cancellation observable.
  bus.subscribe('L0', () => {
    trace.push('extra-L0');
  });
  bus.subscribe('L1', () => {
    trace.push('extra-L1');
  });

  const receipt = await watchdog(
    bus.publishAsync('L0', null, { signal: controllers[0]!.signal }),
  );

  assert.equal(receipt.cancelled, scenario.cancel === 'root');
  // The chain always reaches the deepest level: cancellation only skips
  // not-yet-started callbacks of the cancelled publish itself.
  assert.ok(
    trace.includes(`exit:${scenario.depth}`),
    `chain did not complete: ${JSON.stringify(scenario)} -> ${trace.join(',')}`,
  );
  assert.equal(trace.includes('extra-L0'), scenario.cancel !== 'root');
  assert.equal(trace.includes('extra-L1'), scenario.cancel !== 'child');
  return trace;
}

test('enumeration of nested publish x cancel x remove interleavings never deadlocks', async () => {
  let scenarios = 0;
  for (const depth of [1, 2, 3]) {
    for (const awaitChild of [true, false]) {
      for (const cancel of ['none', 'root', 'child'] as const) {
        for (const removal of ['none', 'self', 'bystander', 'ancestor'] as const) {
          await runScenario({ depth, awaitChild, cancel, removal });
          scenarios += 1;
        }
      }
    }
  }
  assert.equal(scenarios, 72);
});

test('no unhandled rejections were produced by the enumeration', async () => {
  await sleep(20);
  assert.deepEqual(unhandled, []);
});
