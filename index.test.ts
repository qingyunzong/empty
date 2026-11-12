import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  locate,
  LocateError,
  type ElementNode,
  type FrameAdapter,
  type FrameId,
  type FrameSnapshot,
  type SelectorEvaluator,
} from './index.js';

interface FrameState {
  generation: number;
  root: ElementNode;
}

class TestAdapter implements FrameAdapter {
  private frames = new Map<FrameId, FrameState>();
  private generationLog = new Map<FrameId, number[]>();
  private listeners = new Map<FrameId, Set<(generation: number) => void>>();
  private inaccessible = new Set<FrameId>();
  readonly checkCalls: Array<Record<FrameId, number>> = [];
  failNextChecks = 0;
  alwaysFailChecks = false;
  readHook: ((frameId: FrameId) => void | Promise<void>) | null = null;

  setFrame(frameId: FrameId, root: ElementNode): number {
    const generation = (this.frames.get(frameId)?.generation ?? 0) + 1;
    this.frames.set(frameId, { generation, root });
    const log = this.generationLog.get(frameId) ?? [];
    log.push(generation);
    this.generationLog.set(frameId, log);
    for (const listener of this.listeners.get(frameId) ?? []) listener(generation);
    return generation;
  }

  dropFrame(frameId: FrameId): void {
    this.inaccessible.add(frameId);
  }

  listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }

  async readFrame(frameId: FrameId): Promise<FrameSnapshot> {
    await Promise.resolve();
    if (this.inaccessible.has(frameId) || !this.frames.has(frameId)) {
      throw new Error(`frame ${frameId} gone`);
    }
    const state = this.frames.get(frameId)!;
    const snapshot: FrameSnapshot = { frameId, generation: state.generation, root: state.root };
    await this.readHook?.(frameId);
    return snapshot;
  }

  async checkVersions(versions: ReadonlyMap<FrameId, number>): Promise<boolean> {
    await Promise.resolve();
    this.checkCalls.push(Object.fromEntries(versions));
    if (this.alwaysFailChecks) return false;
    if (this.failNextChecks > 0) {
      this.failNextChecks -= 1;
      return false;
    }
    for (const [frameId, generation] of versions) {
      const state = this.frames.get(frameId);
      if (!state || this.inaccessible.has(frameId) || state.generation !== generation) return false;
    }
    return true;
  }

  async subscribe(
    frameId: FrameId,
    fromGeneration: number,
    onChange: (generation: number) => void,
  ): Promise<() => void> {
    await Promise.resolve();
    for (const generation of this.generationLog.get(frameId) ?? []) {
      if (generation > fromGeneration) onChange(generation);
    }
    let set = this.listeners.get(frameId);
    if (!set) {
      set = new Set();
      this.listeners.set(frameId, set);
    }
    set.add(onChange);
    return () => {
      set.delete(onChange);
    };
  }
}

const iframe = (name: string, childFrameId: string): ElementNode => ({
  tag: 'iframe',
  kind: 'iframe',
  attrs: { name },
  childFrameId,
});

const leaf = (name: string): ElementNode => ({ tag: 'div', attrs: { name } });

const byName: SelectorEvaluator = (root, selector) => {
  const matches: ElementNode[] = [];
  const walk = (node: ElementNode) => {
    if (node.attrs?.name === selector) matches.push(node);
    node.children?.forEach(walk);
  };
  walk(root);
  return matches;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('locates nodes across nested frames, last segment may match many', async () => {
  const adapter = new TestAdapter();
  adapter.setFrame('root', { tag: 'html', children: [iframe('a', 'frameA')] });
  adapter.setFrame('frameA', {
    tag: 'html',
    children: [iframe('b', 'frameB'), leaf('target')],
  });
  adapter.setFrame('frameB', { tag: 'html', children: [leaf('target'), leaf('target')] });

  const result = await locate(adapter, byName, 'root', ['a', 'b', 'target'], { maxAttempts: 3 });
  assert.equal(result.length, 2);
  assert.deepEqual(adapter.checkCalls.at(-1), { root: 1, frameA: 1, frameB: 1 });
  assert.equal(adapter.listenerCount(), 0);
});

test('supports async evaluator and async adapter calls', async () => {
  const adapter = new TestAdapter();
  adapter.setFrame('root', { tag: 'html', children: [iframe('a', 'frameA')] });
  adapter.setFrame('frameA', { tag: 'html', children: [leaf('target')] });
  const asyncEvaluator: SelectorEvaluator = async (root, selector) => {
    await tick();
    return byName(root, selector);
  };
  const result = await locate(adapter, asyncEvaluator, 'root', ['a', 'target'], { maxAttempts: 2 });
  assert.equal(result.length, 1);
  assert.equal(result[0].attrs?.name, 'target');
});

test('top-level navigation replacement invalidates the attempt and retries from the top', async () => {
  const adapter = new TestAdapter();
  adapter.setFrame('root', { tag: 'html', children: [iframe('a', 'frameOld')] });
  adapter.setFrame('frameOld', { tag: 'html', children: [leaf('stale')] });

  let navigated = false;
  adapter.readHook = (frameId) => {
    if (frameId === 'root' && !navigated) {
      navigated = true;
      adapter.setFrame('root', { tag: 'html', children: [iframe('a', 'frameNew')] });
      adapter.setFrame('frameNew', { tag: 'html', children: [leaf('fresh')] });
    }
  };

  const result = await locate(adapter, byName, 'root', ['a', 'fresh'], { maxAttempts: 3 });
  assert.equal(result.length, 1);
  assert.equal(result[0].attrs?.name, 'fresh');
  assert.deepEqual(adapter.checkCalls, [{ root: 2, frameNew: 1 }]);
  assert.equal(adapter.listenerCount(), 0);
});

test('nested frame change between read and subscribe is replayed and not missed', async () => {
  const adapter = new TestAdapter();
  adapter.setFrame('root', { tag: 'html', children: [iframe('a', 'frameA')] });
  adapter.setFrame('frameA', { tag: 'html', children: [leaf('old')] });

  let mutated = false;
  adapter.readHook = (frameId) => {
    if (frameId === 'frameA' && !mutated) {
      mutated = true;
      adapter.setFrame('frameA', { tag: 'html', children: [leaf('new')] });
    }
  };

  const result = await locate(adapter, byName, 'root', ['a', 'new'], { maxAttempts: 3 });
  assert.equal(result.length, 1);
  assert.equal(result[0].attrs?.name, 'new');
  assert.deepEqual(adapter.checkCalls, [{ root: 1, frameA: 2 }]);
});

test('failed atomic checkVersions retries and eventually succeeds', async () => {
  const adapter = new TestAdapter();
  adapter.setFrame('root', { tag: 'html', children: [leaf('target')] });
  adapter.failNextChecks = 1;

  const result = await locate(adapter, byName, 'root', ['target'], { maxAttempts: 3 });
  assert.equal(result.length, 1);
  assert.equal(adapter.checkCalls.length, 2);
});

test('persistently failing checkVersions exhausts attempts with VERSION_CONFLICT', async () => {
  const adapter = new TestAdapter();
  adapter.setFrame('root', { tag: 'html', children: [leaf('target')] });
  adapter.alwaysFailChecks = true;

  await assert.rejects(
    locate(adapter, byName, 'root', ['target'], { maxAttempts: 2 }),
    (error: unknown) => {
      if (!(error instanceof LocateError)) throw new Error('expected LocateError');
      assert.equal(error.code, 'VERSION_CONFLICT');
      return true;
    },
  );
  assert.equal(adapter.checkCalls.length, 2);
  assert.equal(adapter.listenerCount(), 0);
});

test('mutation during async selector evaluation invalidates the attempt', async () => {
  const adapter = new TestAdapter();
  adapter.setFrame('root', { tag: 'html', children: [leaf('v1')] });

  let mutated = false;
  const evaluator: SelectorEvaluator = async (root, selector) => {
    await tick();
    if (!mutated) {
      mutated = true;
      adapter.setFrame('root', { tag: 'html', children: [leaf('v2')] });
    }
    return byName(root, selector);
  };

  const result = await locate(adapter, evaluator, 'root', ['v2'], { maxAttempts: 3 });
  assert.equal(result.length, 1);
  assert.equal(result[0].attrs?.name, 'v2');
  assert.deepEqual(adapter.checkCalls, [{ root: 2 }]);
});

test('cancellation removes all listeners and never yields partial nodes', async () => {
  const adapter = new TestAdapter();
  adapter.setFrame('root', { tag: 'html', children: [iframe('a', 'frameA')] });
  adapter.setFrame('frameA', { tag: 'html', children: [leaf('target')] });
  adapter.readHook = (frameId) =>
    frameId === 'frameA' ? new Promise<void>(() => {}) : undefined;

  const controller = new AbortController();
  const pending = locate(adapter, byName, 'root', ['a', 'target'], {
    maxAttempts: 5,
    signal: controller.signal,
  });
  const observed = pending.then(
    () => 'resolved',
    (error: unknown) => (error as LocateError).code,
  );
  await tick();
  assert.ok(adapter.listenerCount() > 0);
  controller.abort();
  assert.equal(await observed, 'CANCELLED');
  assert.equal(adapter.listenerCount(), 0);
});

test('deterministic errors carry the failing segment index', async () => {
  const expectError = async (
    build: (adapter: TestAdapter) => { path: string[] },
    code: string,
    segmentIndex: number,
  ) => {
    const adapter = new TestAdapter();
    const { path } = build(adapter);
    await assert.rejects(
      locate(adapter, byName, 'root', path, { maxAttempts: 3 }),
      (error: unknown) => {
        if (!(error instanceof LocateError)) throw new Error('expected LocateError');
        assert.equal(error.code, code);
        assert.equal(error.segmentIndex, segmentIndex);
        return true;
      },
    );
    assert.equal(adapter.listenerCount(), 0);
  };

  await expectError(
    (adapter) => {
      adapter.setFrame('root', { tag: 'html', children: [iframe('a', 'frameA')] });
      adapter.setFrame('frameA', { tag: 'html', children: [iframe('b', 'root')] });
      return { path: ['a', 'b', 'x'] };
    },
    'CYCLE',
    1,
  );

  await expectError(
    (adapter) => {
      adapter.setFrame('root', { tag: 'html', children: [leaf('a')] });
      return { path: ['a', 'x'] };
    },
    'NOT_IFRAME',
    0,
  );

  await expectError(
    (adapter) => {
      adapter.setFrame('root', {
        tag: 'html',
        children: [iframe('a', 'f1'), iframe('a', 'f2')],
      });
      return { path: ['a', 'x'] };
    },
    'MULTIPLE_MATCHES',
    0,
  );

  await expectError(
    (adapter) => {
      adapter.setFrame('root', { tag: 'html', children: [leaf('other')] });
      return { path: ['missing', 'x'] };
    },
    'NO_MATCH',
    0,
  );

  await expectError(
    (adapter) => {
      adapter.setFrame('root', { tag: 'html', children: [iframe('a', 'ghost')] });
      adapter.dropFrame('ghost');
      return { path: ['a', 'x'] };
    },
    'FRAME_INACCESSIBLE',
    1,
  );
});

test('rejects invalid queries before touching the adapter', async () => {
  const adapter = new TestAdapter();
  await assert.rejects(locate(adapter, byName, 'root', [], { maxAttempts: 1 }), (e: unknown) =>
    (e as LocateError).code === 'INVALID_QUERY' ? true : false,
  );
  await assert.rejects(
    locate(adapter, byName, 'root', ['a'], { maxAttempts: 0 }),
    (e: unknown) => ((e as LocateError).code === 'INVALID_QUERY' ? true : false),
  );
  assert.equal(adapter.checkCalls.length, 0);
});
