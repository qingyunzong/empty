import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DeltaQueue,
  DeltaQueueConnector,
  type AckReceipt,
  type PackagePersistCommand,
} from '../index.js';

class TestSink {
  readonly commands: PackagePersistCommand[] = [];

  async persistPackage(command: PackagePersistCommand): Promise<void> {
    this.commands.push(command);
  }
}

class TestGateway {
  readonly receipts: AckReceipt[] = [];
  failNext = 0;

  async confirm(receipt: AckReceipt): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('gateway unavailable');
    }
    this.receipts.push(receipt);
  }
}

describe('DeltaQueueConnector', () => {
  it('sends exactly one final confirmation when the request completes', async () => {
    const queue = await DeltaQueue.create();
    const sink = new TestSink();
    const gateway = new TestGateway();
    const connector = DeltaQueueConnector.create(queue, sink, gateway);

    const token = await queue.beginGeneration('sub-a', 'bootstrap');
    await queue.openRequest({
      subscriberId: 'sub-a',
      requestId: 'req-1',
      generation: token,
      expectedPackageIds: ['p1', 'p2', 'p3'],
    });

    const partial = await connector.deliver({
      subscriberId: 'sub-a',
      requestId: 'req-1',
      generation: token,
      packageId: 'p2',
      payload: { n: 2 },
    });
    assert.equal(partial.receipt, undefined);
    assert.equal(gateway.receipts.length, 0);

    await connector.deliver({
      subscriberId: 'sub-a',
      requestId: 'req-1',
      generation: token,
      packageId: 'p1',
      payload: { n: 1 },
    });

    const completion = await connector.deliver({
      subscriberId: 'sub-a',
      requestId: 'req-1',
      generation: token,
      packageId: 'p3',
      payload: { n: 3 },
    });
    assert.ok(completion.receipt);
    assert.deepEqual(completion.receipt.packageIds, ['p2', 'p1', 'p3']);
    assert.deepEqual(
      sink.commands.map((command) => command.packageId),
      ['p2', 'p1', 'p3'],
    );

    const duplicate = await connector.deliver({
      subscriberId: 'sub-a',
      requestId: 'req-1',
      generation: token,
      packageId: 'p1',
      payload: { n: 1 },
    });
    assert.equal(duplicate.packageResult.status, 'ignored');
    assert.equal(duplicate.receipt, undefined);
    assert.equal(gateway.receipts.length, 1);
  });

  it('keeps the persisted state after a gateway failure and allows retry', async () => {
    const queue = await DeltaQueue.create();
    const sink = new TestSink();
    const gateway = new TestGateway();
    gateway.failNext = 1;
    const connector = DeltaQueueConnector.create(queue, sink, gateway);

    const token = await queue.beginGeneration('sub-a', 'bootstrap');
    await queue.openRequest({
      subscriberId: 'sub-a',
      requestId: 'req-1',
      generation: token,
      expectedPackageCount: 1,
    });

    await assert.rejects(
      connector.deliver({
        subscriberId: 'sub-a',
        requestId: 'req-1',
        generation: token,
        packageId: 'p1',
        payload: {},
      }),
      /gateway unavailable/,
    );

    assert.equal(queue.getRequest('sub-a', 'req-1')?.state, 'acked');
    assert.equal(sink.commands.length, 1);
    assert.equal(gateway.receipts.length, 0);

    // The internal state is already acked, so the retry only re-sends the
    // idempotent confirmation receipt through the gateway.
    const receipt = await connector.confirm('sub-a', 'req-1');
    assert.equal(receipt.requestId, 'req-1');
    assert.equal(gateway.receipts.length, 1);
  });

  it('binds the receipt to subscriber, request, generation and packages', async () => {
    const queue = await DeltaQueue.create();
    const sink = new TestSink();
    const gateway = new TestGateway();
    const connector = DeltaQueueConnector.create(queue, sink, gateway);

    const bootstrap = await queue.beginGeneration('sub-a', 'bootstrap');
    await queue.openRequest({
      subscriberId: 'sub-a',
      requestId: 'full',
      generation: bootstrap,
      expectedPackageCount: 1,
    });
    await connector.deliver({
      subscriberId: 'sub-a',
      requestId: 'full',
      generation: bootstrap,
      packageId: 'p0',
      payload: {},
    });

    await queue.sealGeneration('sub-a');
    const delta = await queue.beginGeneration('sub-a', 'delta');
    await queue.openRequest({
      subscriberId: 'sub-a',
      requestId: 'delta-1',
      generation: delta,
      expectedPackageIds: ['d1', 'd2'],
    });
    await connector.deliver({
      subscriberId: 'sub-a',
      requestId: 'delta-1',
      generation: delta,
      packageId: 'd1',
      payload: {},
    });
    const outcome = await connector.deliver({
      subscriberId: 'sub-a',
      requestId: 'delta-1',
      generation: delta,
      packageId: 'd2',
      payload: {},
    });

    assert.deepEqual(outcome.receipt?.generation, {
      subscriberId: 'sub-a',
      kind: 'delta',
      sequence: 1,
    });
    assert.equal(outcome.receipt?.requestId, 'delta-1');
    assert.deepEqual(outcome.receipt?.packageIds, ['d1', 'd2']);
    assert.equal(gateway.receipts.length, 2);
  });
});
