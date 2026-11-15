import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DeltaQueue,
  DeltaQueueError,
  InMemoryStateStore,
  type GenerationToken,
  type PackageDelivery,
  type PackagePersistCommand,
} from '../index.js';

function makeClock(start = 1000): { now: number; tick: () => number } {
  let current = start;
  return {
    get now() {
      return current;
    },
    tick() {
      current += 10;
      return current;
    },
  };
}

function generation(
  subscriberId: string,
  sequence: number,
): GenerationToken {
  return {
    subscriberId,
    kind: sequence === 0 ? 'bootstrap' : 'delta',
    sequence,
  };
}

function delivery(
  subscriberId: string,
  requestId: string,
  token: GenerationToken,
  packageId: string,
  payload: unknown = { data: packageId },
): PackageDelivery {
  return {
    subscriberId,
    requestId,
    generation: token,
    packageId,
    payload,
  };
}

class RecordingSink {
  readonly commands: PackagePersistCommand[] = [];
  failOn?: string | undefined;

  async persistPackage(command: PackagePersistCommand): Promise<void> {
    if (this.failOn === command.packageId) {
      throw new Error(`sink failure on ${command.packageId}`);
    }
    this.commands.push(command);
  }
}

describe('generation fencing', () => {
  it('requires a bootstrap generation before any delta', async () => {
    const queue = await DeltaQueue.create({ clock: makeClock().tick });
    await assert.rejects(
      queue.beginGeneration('sub-a', 'delta'),
      (error: unknown) =>
        error instanceof DeltaQueueError && error.code === 'GENERATION_CONFLICT',
    );
  });

  it('sequences bootstrap then deltas and blocks interleaving', async () => {
    const queue = await DeltaQueue.create({ clock: makeClock().tick });
    const bootstrap = await queue.beginGeneration('sub-a', 'bootstrap');
    assert.deepEqual(bootstrap, {
      subscriberId: 'sub-a',
      kind: 'bootstrap',
      sequence: 0,
      sealed: false,
      openedAt: 1010,
    });

    await assert.rejects(
      queue.beginGeneration('sub-a', 'delta'),
      (error: unknown) =>
        error instanceof DeltaQueueError && error.code === 'GENERATION_CONFLICT',
    );

    const sealed = await queue.sealGeneration('sub-a');
    assert.equal(sealed.sealed, true);

    const delta = await queue.beginGeneration('sub-a', 'delta');
    assert.equal(delta.sequence, 1);
    assert.equal(delta.kind, 'delta');

    await assert.rejects(
      queue.beginGeneration('sub-a', 'bootstrap'),
      (error: unknown) =>
        error instanceof DeltaQueueError && error.code === 'GENERATION_CONFLICT',
    );
  });

  it('isolates subscribers with independent generation sequences', async () => {
    const queue = await DeltaQueue.create({ clock: makeClock().tick });
    await queue.beginGeneration('sub-a', 'bootstrap');
    await queue.beginGeneration('sub-b', 'bootstrap');
    assert.equal(queue.getCurrentGeneration('sub-a')?.sequence, 0);
    assert.equal(queue.getCurrentGeneration('sub-b')?.sequence, 0);
  });

  it('rejects requests and packages from foreign generations', async () => {
    const queue = await DeltaQueue.create({ clock: makeClock().tick });
    const token = await queue.beginGeneration('sub-a', 'bootstrap');
    await queue.openRequest({
      subscriberId: 'sub-a',
      requestId: 'req-1',
      generation: token,
      expectedPackageIds: ['p1'],
    });

    const staleToken = generation('sub-a', 99);
    await assert.rejects(
      queue.openRequest({
        subscriberId: 'sub-a',
        requestId: 'req-2',
        generation: staleToken,
        expectedPackageIds: ['p1'],
      }),
      (error: unknown) =>
        error instanceof DeltaQueueError && error.code === 'GENERATION_MISMATCH',
    );

    const sink = new RecordingSink();
    await assert.rejects(
      queue.handlePackage(
        delivery('sub-a', 'req-1', staleToken, 'p1'),
        (command) => sink.persistPackage(command),
      ),
      (error: unknown) =>
        error instanceof DeltaQueueError && error.code === 'GENERATION_MISMATCH',
    );
    assert.equal(sink.commands.length, 0);
  });

  it('refuses new requests once the generation is sealed', async () => {
    const queue = await DeltaQueue.create({ clock: makeClock().tick });
    const token = await queue.beginGeneration('sub-a', 'bootstrap');
    await queue.sealGeneration('sub-a');
    await assert.rejects(
      queue.openRequest({
        subscriberId: 'sub-a',
        requestId: 'req-1',
        generation: token,
        expectedPackageCount: 1,
      }),
      (error: unknown) =>
        error instanceof DeltaQueueError && error.code === 'GENERATION_SEALED',
    );
  });

  it('never crosses in-flight bootstrap data with a later delta generation', async () => {
    const queue = await DeltaQueue.create({ clock: makeClock().tick });
    const bootstrapToken = generation('sub-a', 0);
    await queue.beginGeneration('sub-a', 'bootstrap');
    await queue.openRequest({
      subscriberId: 'sub-a',
      requestId: 'full-req',
      generation: bootstrapToken,
      expectedPackageIds: ['b1', 'b2'],
    });
    const sink = new RecordingSink();
    await queue.handlePackage(
      delivery('sub-a', 'full-req', bootstrapToken, 'b1'),
      (command) => sink.persistPackage(command),
    );

    await queue.sealGeneration('sub-a');
    const deltaToken = generation('sub-a', 1);
    const delta = await queue.beginGeneration('sub-a', 'delta');
    assert.equal(delta.sequence, 1);

    await queue.openRequest({
      subscriberId: 'sub-a',
      requestId: 'delta-req',
      generation: deltaToken,
      expectedPackageCount: 1,
    });
    await queue.handlePackage(
      delivery('sub-a', 'delta-req', deltaToken, 'd1'),
      (command) => sink.persistPackage(command),
    );

    // The old request cannot be touched through the new generation token.
    await assert.rejects(
      queue.handlePackage(
        delivery('sub-a', 'full-req', deltaToken, 'b2'),
        (command) => sink.persistPackage(command),
      ),
      (error: unknown) =>
        error instanceof DeltaQueueError && error.code === 'GENERATION_MISMATCH',
    );

    // Its in-flight package still lands under the bootstrap token.
    const lateBootstrap = await queue.handlePackage(
      delivery('sub-a', 'full-req', bootstrapToken, 'b2'),
      (command) => sink.persistPackage(command),
    );
    assert.equal(lateBootstrap.request.state, 'persisted');
    assert.deepEqual(
      queue.getRequest('sub-a', 'full-req')?.generation,
      bootstrapToken,
    );
    assert.deepEqual(
      queue.getRequest('sub-a', 'delta-req')?.generation,
      deltaToken,
    );
    assert.deepEqual(
      sink.commands.map((command) => command.packageId),
      ['b1', 'd1', 'b2'],
    );
  });
});

describe('package handling', () => {
  it('accepts out-of-order packages and lands each package once', async () => {
    const queue = await DeltaQueue.create({ clock: makeClock().tick });
    const token = await queue.beginGeneration('sub-a', 'bootstrap');
    await queue.openRequest({
      subscriberId: 'sub-a',
      requestId: 'req-1',
      generation: token,
      expectedPackageIds: ['p1', 'p2', 'p3'],
    });
    const sink = new RecordingSink();
    const run = (packageId: string) =>
      queue.handlePackage(
        delivery('sub-a', 'req-1', token, packageId),
        (command) => sink.persistPackage(command),
      );

    const first = await run('p3');
    assert.equal(first.status, 'persisted');
    assert.equal(first.request.state, 'open');
    await run('p1');

    const duplicate = await run('p3');
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(duplicate.reason, 'already-persisted');

    const last = await run('p2');
    assert.equal(last.status, 'persisted');
    assert.equal(last.request.state, 'persisted');
    assert.deepEqual(last.request.receivedPackageIds, ['p3', 'p1', 'p2']);

    assert.equal(sink.commands.length, 3);
    assert.deepEqual(
      sink.commands.map((command) => command.packageId),
      ['p3', 'p1', 'p2'],
    );
  });

  it('supports count mode with any distinct package ids', async () => {
    const queue = await DeltaQueue.create({ clock: makeClock().tick });
    const token = await queue.beginGeneration('sub-a', 'bootstrap');
    await queue.openRequest({
      subscriberId: 'sub-a',
      requestId: 'req-1',
      generation: token,
      expectedPackageCount: 2,
    });
    const sink = new RecordingSink();
    const run = (packageId: string) =>
      queue.handlePackage(
        delivery('sub-a', 'req-1', token, packageId),
        (command) => sink.persistPackage(command),
      );

    await run('a');
    const complete = await run('b');
    assert.equal(complete.request.state, 'persisted');
    await assert.rejects(
      run('c'),
      (error: unknown) =>
        error instanceof DeltaQueueError && error.code === 'PACKAGE_UNEXPECTED',
    );
  });

  it('rejects packages outside the explicit id set', async () => {
    const queue = await DeltaQueue.create({ clock: makeClock().tick });
    const token = await queue.beginGeneration('sub-a', 'bootstrap');
    await queue.openRequest({
      subscriberId: 'sub-a',
      requestId: 'req-1',
      generation: token,
      expectedPackageIds: ['p1'],
    });
    const sink = new RecordingSink();
    await assert.rejects(
      queue.handlePackage(
        delivery('sub-a', 'req-1', token, 'other'),
        (command) => sink.persistPackage(command),
      ),
      (error: unknown) =>
        error instanceof DeltaQueueError && error.code === 'PACKAGE_UNEXPECTED',
    );
    assert.equal(sink.commands.length, 0);
  });

  it('detects checksum conflicts on redelivery', async () => {
    const queue = await DeltaQueue.create({ clock: makeClock().tick });
    const token = await queue.beginGeneration('sub-a', 'bootstrap');
    await queue.openRequest({
      subscriberId: 'sub-a',
      requestId: 'req-1',
      generation: token,
      expectedPackageCount: 1,
    });
    const recording = new RecordingSink();
    await queue.handlePackage(
      { ...delivery('sub-a', 'req-1', token, 'p1'), checksum: 'aaa' },
      (command) => recording.persistPackage(command),
    );
    await assert.rejects(
      queue.handlePackage(
        { ...delivery('sub-a', 'req-1', token, 'p1'), checksum: 'bbb' },
        (command) => recording.persistPackage(command),
      ),
      (error: unknown) =>
        error instanceof DeltaQueueError && error.code === 'CHECKSUM_CONFLICT',
    );
    assert.equal(recording.commands.length, 1);
  });

  it('leaves state untouched when the sink fails', async () => {
    const queue = await DeltaQueue.create({ clock: makeClock().tick });
    const token = await queue.beginGeneration('sub-a', 'bootstrap');
    await queue.openRequest({
      subscriberId: 'sub-a',
      requestId: 'req-1',
      generation: token,
      expectedPackageCount: 1,
    });
    const sink = new RecordingSink();
    sink.failOn = 'p1';
    await assert.rejects(
      queue.handlePackage(
        delivery('sub-a', 'req-1', token, 'p1'),
        (command) => sink.persistPackage(command),
      ),
      /sink failure on p1/,
    );
    const request = queue.getRequest('sub-a', 'req-1')!;
    assert.equal(request.state, 'open');
    assert.deepEqual(request.receivedPackageIds, []);

    sink.failOn = undefined;
    const retried = await queue.handlePackage(
      delivery('sub-a', 'req-1', token, 'p1'),
      (command) => sink.persistPackage(command),
    );
    assert.equal(retried.status, 'persisted');
    assert.equal(sink.commands.length, 1);
  });
});

describe('acknowledgment', () => {
  it('confirms only after every package is persisted', async () => {
    const queue = await DeltaQueue.create({ clock: makeClock().tick });
    const token = generation('sub-a', 0);
    await queue.beginGeneration('sub-a', 'bootstrap');
    await queue.openRequest({
      subscriberId: 'sub-a',
      requestId: 'req-1',
      generation: token,
      expectedPackageIds: ['p1', 'p2'],
    });
    const sink = new RecordingSink();

    await assert.rejects(
      queue.acknowledge('sub-a', 'req-1'),
      (error: unknown) =>
        error instanceof DeltaQueueError
        && error.code === 'REQUEST_NOT_PERSISTED',
    );

    await queue.handlePackage(
      delivery('sub-a', 'req-1', token, 'p1'),
      (command) => sink.persistPackage(command),
    );
    await assert.rejects(
      queue.acknowledge('sub-a', 'req-1'),
      (error: unknown) =>
        error instanceof DeltaQueueError
        && error.code === 'REQUEST_NOT_PERSISTED',
    );

    await queue.handlePackage(
      delivery('sub-a', 'req-1', token, 'p2'),
      (command) => sink.persistPackage(command),
    );
    const receipt = await queue.acknowledge('sub-a', 'req-1');
    assert.equal(receipt.subscriberId, 'sub-a');
    assert.equal(receipt.requestId, 'req-1');
    assert.deepEqual(receipt.generation, token);
    assert.deepEqual(receipt.packageIds, ['p1', 'p2']);
    assert.equal(receipt.packageCount, 2);

    const retried = await queue.acknowledge('sub-a', 'req-1');
    assert.deepEqual(retried, receipt);
    assert.equal(queue.getRequest('sub-a', 'req-1')?.state, 'acked');
  });

  it('ignores late packages after acknowledgment', async () => {
    const queue = await DeltaQueue.create({ clock: makeClock().tick });
    const token = await queue.beginGeneration('sub-a', 'bootstrap');
    await queue.openRequest({
      subscriberId: 'sub-a',
      requestId: 'req-1',
      generation: token,
      expectedPackageCount: 1,
    });
    const sink = new RecordingSink();
    await queue.handlePackage(
      delivery('sub-a', 'req-1', token, 'p1'),
      (command) => sink.persistPackage(command),
    );
    await queue.acknowledge('sub-a', 'req-1');

    const late = await queue.handlePackage(
      delivery('sub-a', 'req-1', token, 'p1'),
      (command) => sink.persistPackage(command),
    );
    assert.equal(late.status, 'ignored');
    assert.equal(late.reason, 'request-acked');
    assert.equal(sink.commands.length, 1);
  });
});

describe('cancellation', () => {
  it('is terminal and late packages cannot revive the request', async () => {
    const queue = await DeltaQueue.create({ clock: makeClock().tick });
    const token = await queue.beginGeneration('sub-a', 'bootstrap');
    await queue.openRequest({
      subscriberId: 'sub-a',
      requestId: 'req-1',
      generation: token,
      expectedPackageIds: ['p1', 'p2'],
    });
    const sink = new RecordingSink();
    await queue.handlePackage(
      delivery('sub-a', 'req-1', token, 'p1'),
      (command) => sink.persistPackage(command),
    );

    const canceled = await queue.cancelRequest('sub-a', 'req-1');
    assert.equal(canceled.state, 'canceled');

    const late = await queue.handlePackage(
      delivery('sub-a', 'req-1', token, 'p2'),
      (command) => sink.persistPackage(command),
    );
    assert.equal(late.status, 'ignored');
    assert.equal(late.reason, 'request-canceled');
    assert.equal(sink.commands.length, 1);
    assert.equal(
      queue.getRequest('sub-a', 'req-1')?.receivedPackageIds.length,
      1,
    );

    await assert.rejects(
      queue.acknowledge('sub-a', 'req-1'),
      (error: unknown) =>
        error instanceof DeltaQueueError && error.code === 'REQUEST_TERMINAL',
    );
  });

  it('cannot cancel an already acknowledged request', async () => {
    const queue = await DeltaQueue.create({ clock: makeClock().tick });
    const token = await queue.beginGeneration('sub-a', 'bootstrap');
    await queue.openRequest({
      subscriberId: 'sub-a',
      requestId: 'req-1',
      generation: token,
      expectedPackageCount: 0,
    });
    await queue.acknowledge('sub-a', 'req-1');
    await assert.rejects(
      queue.cancelRequest('sub-a', 'req-1'),
      (error: unknown) =>
        error instanceof DeltaQueueError && error.code === 'REQUEST_TERMINAL',
    );
  });
});

describe('durability and concurrency', () => {
  it('rehydrates state from the shared store after restart', async () => {
    const store = new InMemoryStateStore();
    const first = await DeltaQueue.create({
      store,
      clock: makeClock().tick,
    });
    const token = await first.beginGeneration('sub-a', 'bootstrap');
    await first.openRequest({
      subscriberId: 'sub-a',
      requestId: 'req-1',
      generation: token,
      expectedPackageIds: ['p1', 'p2'],
    });
    const sink = new RecordingSink();
    await first.handlePackage(
      delivery('sub-a', 'req-1', token, 'p1'),
      (command) => sink.persistPackage(command),
    );

    const restarted = await DeltaQueue.create({
      store,
      clock: makeClock(5000).tick,
    });
    const restored = restarted.getRequest('sub-a', 'req-1')!;
    assert.deepEqual(restored.receivedPackageIds, ['p1']);
    assert.equal(restored.state, 'open');

    await restarted.handlePackage(
      delivery('sub-a', 'req-1', token, 'p2'),
      (command) => sink.persistPackage(command),
    );
    const receipt = await restarted.acknowledge('sub-a', 'req-1');
    assert.deepEqual(receipt.packageIds, ['p1', 'p2']);
  });

  it('serializes concurrent duplicate deliveries to one sink write', async () => {
    const queue = await DeltaQueue.create({ clock: makeClock().tick });
    const token = await queue.beginGeneration('sub-a', 'bootstrap');
    await queue.openRequest({
      subscriberId: 'sub-a',
      requestId: 'req-1',
      generation: token,
      expectedPackageCount: 1,
    });
    const sink = new RecordingSink();
    const handle = () =>
      queue.handlePackage(
        delivery('sub-a', 'req-1', token, 'p1'),
        (command) => sink.persistPackage(command),
      );

    const results = await Promise.all([handle(), handle(), handle()]);
    const statuses = results.map((result) => result.status).sort();
    assert.deepEqual(statuses, ['duplicate', 'duplicate', 'persisted']);
    assert.equal(sink.commands.length, 1);
    assert.equal(
      queue.getRequest('sub-a', 'req-1')?.state,
      'persisted',
    );
  });

  it('keeps two requests of one subscriber independently tracked', async () => {
    const queue = await DeltaQueue.create({ clock: makeClock().tick });
    const token = await queue.beginGeneration('sub-a', 'bootstrap');
    await queue.openRequest({
      subscriberId: 'sub-a',
      requestId: 'req-a',
      generation: token,
      expectedPackageCount: 1,
    });
    await queue.openRequest({
      subscriberId: 'sub-a',
      requestId: 'req-b',
      generation: token,
      expectedPackageCount: 1,
    });
    const sink = new RecordingSink();
    await queue.handlePackage(
      delivery('sub-a', 'req-a', token, 'pa'),
      (command) => sink.persistPackage(command),
    );

    assert.equal(queue.getRequest('sub-a', 'req-a')?.state, 'persisted');
    assert.equal(queue.getRequest('sub-a', 'req-b')?.state, 'open');
    const requests = queue.listRequests('sub-a');
    assert.deepEqual(
      requests.map((request) => request.requestId),
      ['req-a', 'req-b'],
    );
  });
});
