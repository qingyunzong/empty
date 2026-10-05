import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { MemoryLayer, OverlayResolver } from '../src/index.js';

describe('layer priority', () => {
  it('higher layers shadow lower layers, missing entries fall through', () => {
    const base = new MemoryLayer('base');
    base.writeFile('/app/config.json', '{"v":1}');
    base.writeFile('/app/only-base.txt', 'base');
    const mid = new MemoryLayer('mid');
    mid.writeFile('/app/config.json', '{"v":2}');
    const top = new MemoryLayer('top');

    const r = new OverlayResolver([top, mid, base]);
    assert.equal(r.readTextFile('/app/config.json'), '{"v":2}');
    assert.equal(r.readTextFile('/app/only-base.txt'), 'base');
    assert.equal(r.stat('/app'), 'dir');
    assert.equal(r.stat('/nope'), undefined);
    assert.deepEqual(r.listDir('/app'), ['config.json', 'only-base.txt']);
  });

  it('readFile returns a defensive copy', () => {
    const layer = new MemoryLayer('l');
    layer.writeFile('/a.bin', new Uint8Array([1, 2, 3]));
    const r = new OverlayResolver([layer]);
    const first = r.readFile('/a.bin');
    assert.ok(first);
    first[0] = 99;
    assert.deepEqual([...r.readFile('/a.bin')!], [1, 2, 3]);
  });
});

describe('directory tombstones', () => {
  it('shadow the whole lower-layer subtree', () => {
    const lower = new MemoryLayer('lower');
    lower.writeFile('/assets/img/logo.png', 'png');
    lower.writeFile('/assets/img/icons/add.svg', 'svg');
    lower.writeFile('/assets/readme.txt', 'readme');
    const upper = new MemoryLayer('upper');
    upper.deleteDir('/assets/img');

    const r = new OverlayResolver([upper, lower]);
    assert.equal(r.readFile('/assets/img/logo.png'), undefined);
    assert.equal(r.readFile('/assets/img/icons/add.svg'), undefined);
    assert.equal(r.stat('/assets/img'), undefined);
    assert.equal(r.listDir('/assets/img'), undefined);
    assert.equal(r.readTextFile('/assets/readme.txt'), 'readme');
    assert.deepEqual(r.listDir('/assets'), ['readme.txt']);
  });

  it('keep new entries created in the same layer visible', () => {
    const lower = new MemoryLayer('lower');
    lower.writeFile('/assets/img/logo.png', 'old-logo');
    lower.writeFile('/assets/img/icons/add.svg', 'old-add');
    const upper = new MemoryLayer('upper');
    upper.deleteDir('/assets/img');
    upper.writeFile('/assets/img/new-logo.png', 'new-logo');
    upper.writeFile('/assets/img/icons/new.svg', 'new-icon');

    const r = new OverlayResolver([upper, lower]);
    assert.equal(r.readTextFile('/assets/img/new-logo.png'), 'new-logo');
    assert.equal(r.readTextFile('/assets/img/icons/new.svg'), 'new-icon');
    assert.equal(r.readFile('/assets/img/logo.png'), undefined);
    assert.equal(r.readFile('/assets/img/icons/add.svg'), undefined);
    assert.equal(r.stat('/assets/img'), 'dir');
    assert.deepEqual(r.listDir('/assets/img'), ['icons', 'new-logo.png']);
    assert.deepEqual(r.listDir('/assets/img/icons'), ['new.svg']);

    const scan = r.scan('/assets/img');
    assert.equal(scan.trace[0]?.outcome, 'hit-opaque-dir');
    const blocked = r.scan('/assets/img/logo.png');
    assert.equal(blocked.trace[0]?.outcome, 'blocked-by-dir-tombstone');
    assert.equal(blocked.trace[0]?.at, '/assets/img');
  });
});

describe('file tombstones and priority', () => {
  it('file tombstone hides lower file; higher file beats lower tombstone', () => {
    const lower = new MemoryLayer('lower');
    lower.writeFile('/a.txt', 'low-a');
    lower.writeFile('/b.txt', 'low-b');
    const upper = new MemoryLayer('upper');
    upper.deleteFile('/a.txt');
    upper.writeFile('/c.txt', 'up-c');

    const r = new OverlayResolver([upper, lower]);
    assert.equal(r.readFile('/a.txt'), undefined);
    assert.equal(r.readTextFile('/b.txt'), 'low-b');
    assert.deepEqual(r.listDir('/'), ['b.txt', 'c.txt']);

    const top = new MemoryLayer('top');
    top.writeFile('/a.txt', 'top-a');
    const r2 = new OverlayResolver([top, upper, lower]);
    assert.equal(r2.readTextFile('/a.txt'), 'top-a');
    assert.deepEqual(r2.listDir('/'), ['a.txt', 'b.txt', 'c.txt']);
  });
});

describe('case rules', () => {
  it('case-insensitive matching folds case but preserves display names', () => {
    const base = new MemoryLayer('base', false);
    base.writeFile('/Docs/README.md', 'hello');
    const up = new MemoryLayer('up', false);
    up.writeFile('/docs/readme.md', 'upper');

    const r = new OverlayResolver([up, base], { caseSensitive: false });
    assert.equal(r.readTextFile('/DOCS/README.MD'), 'upper');
    assert.deepEqual(r.listDir('/Docs'), ['readme.md']);
    assert.equal(r.scan('/docs/readme.md').winner, 'up');
  });

  it('case-insensitive directory tombstone shadows regardless of casing', () => {
    const lower = new MemoryLayer('lower', false);
    lower.writeFile('/Assets/Img/logo.png', 'png');
    const upper = new MemoryLayer('upper', false);
    upper.deleteDir('/assets/IMG');

    const r = new OverlayResolver([upper, lower], { caseSensitive: false });
    assert.equal(r.readFile('/ASSETS/img/LOGO.PNG'), undefined);
    assert.equal(r.listDir('/assets/img'), undefined);
  });

  it('case-sensitive matching treats different casings as distinct', () => {
    const layer = new MemoryLayer('s', true);
    layer.writeFile('/A.txt', 'A');
    layer.writeFile('/a.txt', 'a');

    const r = new OverlayResolver([layer], { caseSensitive: true });
    assert.deepEqual(r.listDir('/'), ['A.txt', 'a.txt']);
    assert.equal(r.readTextFile('/A.txt'), 'A');
    assert.equal(r.readTextFile('/a.txt'), 'a');
    assert.equal(r.readFile('/A.TXT'), undefined);
  });

  it('rejects layers whose case rule mismatches the resolver', () => {
    assert.throws(
      () => new OverlayResolver([new MemoryLayer('x', false)], { caseSensitive: true }),
      /caseSensitive/,
    );
  });
});

describe('list/read consistency', () => {
  function collectListedFiles(r: OverlayResolver, dir: string): string[] {
    const names = r.listDir(dir);
    if (!names) return [];
    const files: string[] = [];
    for (const name of names) {
      const child = (dir === '/' ? '' : dir) + '/' + name;
      const kind = r.stat(child);
      assert.ok(kind !== undefined, `listed ${child} must stat`);
      if (kind === 'dir') {
        files.push(...collectListedFiles(r, child));
      } else {
        assert.ok(r.readFile(child) !== undefined, `listed ${child} must be readable`);
        files.push(child);
      }
    }
    return files;
  }

  it('every listed file is readable and every readable file is listed', () => {
    const l0 = new MemoryLayer('L0');
    const l1 = new MemoryLayer('L1');
    const l2 = new MemoryLayer('L2');
    l2.writeFile('/pkg/core/a.js', 'a2');
    l2.writeFile('/pkg/core/b.js', 'b2');
    l2.writeFile('/pkg/util/c.js', 'c2');
    l2.writeFile('/pkg/keep.txt', 'keep2');
    l1.deleteDir('/pkg/core');
    l1.writeFile('/pkg/core/a1.js', 'a1');
    l1.deleteFile('/pkg/keep.txt');
    l0.writeFile('/pkg/util/c.js', 'c0');
    l0.writeFile('/top.txt', 'top');

    const r = new OverlayResolver([l0, l1, l2]);
    const listed = collectListedFiles(r, '/').sort();
    assert.deepEqual(listed, ['/pkg/core/a1.js', '/pkg/util/c.js', '/top.txt']);

    const reachable = new Set<string>();
    for (const layer of [l0, l1, l2]) {
      for (const key of layer.keys()) {
        if (r.readFile(key) !== undefined) reachable.add(key);
      }
    }
    assert.deepEqual(listed, [...reachable].sort());
  });
});

describe('immutable snapshots', () => {
  it('snapshot is unaffected by later mutations and frozen layers reject writes', () => {
    const live = new MemoryLayer('live');
    live.writeFile('/a.txt', 'v1');
    const r = new OverlayResolver([live]);

    const snap = r.snapshot();
    live.writeFile('/b.txt', 'new');
    live.deleteFile('/a.txt');

    assert.equal(snap.readTextFile('/a.txt'), 'v1');
    assert.equal(snap.readFile('/b.txt'), undefined);
    assert.deepEqual(snap.listDir('/'), ['a.txt']);

    assert.equal(r.readFile('/a.txt'), undefined);
    assert.deepEqual(r.listDir('/'), ['b.txt']);

    const frozen = snap.layers[0] as MemoryLayer;
    assert.ok(frozen.frozen);
    assert.throws(() => frozen.writeFile('/x.txt', 'x'), /frozen/);
    assert.throws(() => frozen.deleteDir('/'), /frozen/);
    assert.throws(() => frozen.mkdir('/d'), /frozen/);

    const snap2 = snap.snapshot();
    assert.equal(snap2.readTextFile('/a.txt'), 'v1');
  });
});

describe('layer-by-layer scan of mixed tombstones', () => {
  const l0 = new MemoryLayer('L0-top');
  const l1 = new MemoryLayer('L1');
  const l2 = new MemoryLayer('L2');
  const l3 = new MemoryLayer('L3-base');

  l3.writeFile('/pkg/core/a.js', 'a3');
  l3.writeFile('/pkg/core/b.js', 'b3');
  l3.writeFile('/pkg/util/c.js', 'c3');
  l3.writeFile('/pkg/keep.txt', 'keep3');

  l2.deleteDir('/pkg/core');
  l2.writeFile('/pkg/util/c.js', 'c2');
  l2.deleteFile('/pkg/keep.txt');

  l1.writeFile('/pkg/core/a.js', 'a1');
  l1.deleteDir('/pkg/util');
  l1.writeFile('/pkg/util/new.js', 'n1');

  const r = new OverlayResolver([l0, l1, l2, l3]);

  it('resolves each path according to the highest deciding layer', () => {
    assert.equal(r.readTextFile('/pkg/core/a.js'), 'a1');
    assert.equal(r.readFile('/pkg/core/b.js'), undefined);
    assert.equal(r.readFile('/pkg/util/c.js'), undefined);
    assert.equal(r.readTextFile('/pkg/util/new.js'), 'n1');
    assert.equal(r.readFile('/pkg/keep.txt'), undefined);
    assert.deepEqual(r.listDir('/pkg'), ['core', 'util']);
    assert.deepEqual(r.listDir('/pkg/core'), ['a.js']);
    assert.deepEqual(r.listDir('/pkg/util'), ['new.js']);
  });

  it('reports per-layer outcomes for a higher-layer hit', () => {
    const scan = r.scan('/pkg/core/a.js');
    assert.equal(scan.found, 'file');
    assert.equal(scan.winner, 'L1');
    assert.deepEqual(scan.trace, [
      { layer: 'L0-top', outcome: 'miss', at: '/pkg/core/a.js' },
      { layer: 'L1', outcome: 'hit-file', at: '/pkg/core/a.js' },
    ]);
  });

  it('reports where a directory tombstone blocks lower layers', () => {
    const scan = r.scan('/pkg/core/b.js');
    assert.equal(scan.found, undefined);
    assert.deepEqual(scan.trace, [
      { layer: 'L0-top', outcome: 'miss', at: '/pkg/core/b.js' },
      { layer: 'L1', outcome: 'miss', at: '/pkg/core/b.js' },
      { layer: 'L2', outcome: 'blocked-by-dir-tombstone', at: '/pkg/core' },
    ]);
  });

  it('reports opaque dirs and file tombstones layer by layer', () => {
    const util = r.scan('/pkg/util/c.js');
    assert.deepEqual(util.trace, [
      { layer: 'L0-top', outcome: 'miss', at: '/pkg/util/c.js' },
      { layer: 'L1', outcome: 'blocked-by-dir-tombstone', at: '/pkg/util' },
    ]);

    const opaque = r.scan('/pkg/util');
    assert.equal(opaque.trace[1]?.outcome, 'hit-opaque-dir');
    assert.equal(opaque.winner, 'L1');

    const keep = r.scan('/pkg/keep.txt');
    assert.deepEqual(keep.trace, [
      { layer: 'L0-top', outcome: 'miss', at: '/pkg/keep.txt' },
      { layer: 'L1', outcome: 'miss', at: '/pkg/keep.txt' },
      { layer: 'L2', outcome: 'tombstone-file', at: '/pkg/keep.txt' },
    ]);
  });
});
