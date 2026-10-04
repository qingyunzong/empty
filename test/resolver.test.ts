import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LayeredResolver } from '../src/index.js';

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

function makeResolver(caseSensitive = true) {
  const resolver = new LayeredResolver({ caseSensitive });
  const top = resolver.addLayer('top');
  const mid = resolver.addLayer('mid');
  const bottom = resolver.addLayer('bottom');
  return { resolver, top, mid, bottom };
}

describe('layer priority', () => {
  it('reads the topmost layer first', () => {
    const { resolver, top, mid, bottom } = makeResolver();
    bottom.writeFile('/app/config.json', 'bottom');
    mid.writeFile('/app/config.json', 'mid');
    top.writeFile('/app/config.json', 'top');
    assert.equal(resolver.readFile('/app/config.json'), 'top');
    assert.equal(resolver.stat('/app/config.json')?.layer, 'top');
  });

  it('falls through to lower layers for paths not shadowed above', () => {
    const { resolver, top, bottom } = makeResolver();
    bottom.writeFile('/only-bottom.txt', 'b');
    top.writeFile('/only-top.txt', 't');
    assert.equal(resolver.readFile('/only-bottom.txt'), 'b');
    assert.equal(resolver.readFile('/only-top.txt'), 't');
  });

  it('a tombstone in a higher layer wins over files below', () => {
    const { resolver, top, bottom } = makeResolver();
    bottom.writeFile('/gone.txt', 'b');
    top.remove('/gone.txt');
    assert.throws(() => resolver.readFile('/gone.txt'), (e) => codeOf(e) === 'ENOENT');
    assert.equal(resolver.exists('/gone.txt'), false);
  });
});

describe('directory tombstones', () => {
  it('shadow the whole lower subtree', () => {
    const { resolver, top, bottom } = makeResolver();
    bottom.writeFile('/app/config/db.json', 'db');
    bottom.writeFile('/app/config/app.json', 'app');
    bottom.writeFile('/app/assets/logo.txt', 'logo');
    top.remove('/app/config');
    assert.throws(() => resolver.readdir('/app/config'), (e) => codeOf(e) === 'ENOENT');
    assert.throws(() => resolver.readFile('/app/config/db.json'), (e) => codeOf(e) === 'ENOENT');
    assert.deepEqual(resolver.readdir('/app'), ['assets']);
    assert.equal(resolver.readFile('/app/assets/logo.txt'), 'logo');
  });

  it('keeps new children created in the current layer visible', () => {
    const { resolver, top, bottom } = makeResolver();
    bottom.writeFile('/app/config/db.json', 'db');
    bottom.writeFile('/app/config/old.json', 'old');
    top.remove('/app/config');
    top.writeFile('/app/config/new.json', 'new');
    assert.deepEqual(resolver.readdir('/app/config'), ['new.json']);
    assert.equal(resolver.readFile('/app/config/new.json'), 'new');
    assert.throws(() => resolver.readFile('/app/config/db.json'), (e) => codeOf(e) === 'ENOENT');
  });

  it('mixes tombstones across three layers', () => {
    const { resolver, top, mid, bottom } = makeResolver();
    bottom.writeFile('/a/b/c.txt', 'c');
    bottom.writeFile('/a/b/old.txt', 'old');
    bottom.writeFile('/a/x.txt', 'x');
    mid.remove('/a/b');
    mid.writeFile('/a/b/mid.txt', 'mid');
    top.writeFile('/a/b/top.txt', 'top');
    assert.deepEqual(resolver.readdir('/a'), ['b', 'x.txt']);
    assert.deepEqual(resolver.readdir('/a/b'), ['mid.txt', 'top.txt']);
    assert.equal(resolver.readFile('/a/b/mid.txt'), 'mid');
    assert.equal(resolver.readFile('/a/x.txt'), 'x');
    assert.throws(() => resolver.readFile('/a/b/c.txt'), (e) => codeOf(e) === 'ENOENT');
  });

  it('a file in a higher layer replaces a lower directory subtree', () => {
    const { resolver, top, bottom } = makeResolver();
    bottom.writeFile('/res/data/inner.txt', 'inner');
    top.writeFile('/res/data', 'flat');
    assert.equal(resolver.readFile('/res/data'), 'flat');
    assert.throws(() => resolver.readdir('/res/data'), (e) => codeOf(e) === 'ENOTDIR');
    assert.throws(() => resolver.readFile('/res/data/inner.txt'), (e) => codeOf(e) === 'ENOENT');
  });
});

describe('case rules specified by input', () => {
  it('case-sensitive: distinct names, exact lookups only', () => {
    const { resolver, top, bottom } = makeResolver(true);
    top.writeFile('/Docs/ReadMe.md', 'top');
    bottom.writeFile('/docs/readme.md', 'bottom');
    assert.deepEqual(resolver.readdir('/'), ['Docs', 'docs']);
    assert.equal(resolver.readFile('/Docs/ReadMe.md'), 'top');
    assert.equal(resolver.readFile('/docs/readme.md'), 'bottom');
    assert.throws(() => resolver.readFile('/DOCS/README.MD'), (e) => codeOf(e) === 'ENOENT');
  });

  it('case-insensitive: folded lookups, display names preserved', () => {
    const { resolver, top, bottom } = makeResolver(false);
    top.writeFile('/Docs/ReadMe.md', 'top');
    bottom.writeFile('/docs/readme.md', 'bottom');
    bottom.writeFile('/DOCS/Other.txt', 'other');
    assert.equal(resolver.readFile('/DOCS/README.MD'), 'top');
    assert.equal(resolver.readFile('/docs/other.TXT'), 'other');
    assert.deepEqual(resolver.readdir('/'), ['Docs']);
    assert.deepEqual(resolver.readdir('/docs'), ['Other.txt', 'ReadMe.md']);
    assert.equal(resolver.stat('/DOCS/README.md')?.layer, 'top');
  });

  it('case-insensitive tombstones shadow every casing below', () => {
    const { resolver, top, bottom } = makeResolver(false);
    bottom.writeFile('/Assets/Icons/home.svg', 'home');
    top.remove('/assets/icons');
    assert.throws(() => resolver.readFile('/ASSETS/ICONS/HOME.SVG'), (e) => codeOf(e) === 'ENOENT');
    assert.deepEqual(resolver.readdir('/'), ['Assets']);
    assert.deepEqual(resolver.readdir('/assets'), []);
  });
});

describe('readdir/readFile consistency', () => {
  it('every listed name resolves and every readable file is listed', () => {
    const { resolver, top, mid, bottom } = makeResolver();
    bottom.writeFile('/lib/core/a.txt', 'a');
    bottom.writeFile('/lib/core/b.txt', 'b');
    bottom.writeFile('/lib/extra/c.txt', 'c');
    mid.remove('/lib/extra');
    mid.writeFile('/lib/core/b.txt', 'b-mid');
    top.writeFile('/lib/core/d.txt', 'd');
    const walk = (dir: string): string[] =>
      resolver.readdir(dir).flatMap((name) => {
        const p = dir === '/' ? `/${name}` : `${dir}/${name}`;
        return resolver.stat(p)?.kind === 'dir' ? walk(p) : [p];
      });
    const files = walk('/');
    assert.deepEqual(files, ['/lib/core/a.txt', '/lib/core/b.txt', '/lib/core/d.txt']);
    for (const file of files) {
      assert.equal(typeof resolver.readFile(file), 'string');
    }
    assert.equal(resolver.readFile('/lib/core/b.txt'), 'b-mid');
  });
});

describe('immutable snapshots', () => {
  it('are isolated from later mutations of every layer', () => {
    const { resolver, top, bottom } = makeResolver();
    bottom.writeFile('/data/a.txt', 'A');
    bottom.writeFile('/data/b.txt', 'B');
    top.writeFile('/data/b.txt', 'B2');
    const snap = resolver.snapshot();

    resolver.writeFile('/data/c.txt', 'C');
    resolver.remove('/data/a.txt');
    resolver.writeFile('/data/b.txt', 'B3');
    bottom.writeFile('/data/d.txt', 'D');

    assert.equal(snap.readFile('/data/a.txt'), 'A');
    assert.equal(snap.readFile('/data/b.txt'), 'B2');
    assert.throws(() => snap.readFile('/data/c.txt'), (e) => codeOf(e) === 'ENOENT');
    assert.throws(() => snap.readFile('/data/d.txt'), (e) => codeOf(e) === 'ENOENT');
    assert.deepEqual(snap.readdir('/data'), ['a.txt', 'b.txt']);
    assert.deepEqual(resolver.readdir('/data'), ['b.txt', 'c.txt', 'd.txt']);
  });

  it('reject all writes with EFROZEN', () => {
    const { resolver } = makeResolver();
    resolver.writeFile('/x.txt', 'x');
    const snap = resolver.snapshot();
    assert.throws(() => snap.writeFile('/y.txt', 'y'), (e) => codeOf(e) === 'EFROZEN');
    assert.throws(() => snap.mkdir('/dir'), (e) => codeOf(e) === 'EFROZEN');
    assert.throws(() => snap.remove('/x.txt'), (e) => codeOf(e) === 'EFROZEN');
    assert.throws(() => snap.addLayer('late'), (e) => codeOf(e) === 'EFROZEN');
    const frozenLayer = snap.layers[0];
    assert.ok(frozenLayer);
    assert.throws(() => frozenLayer.writeFile('/z.txt', 'z'), (e) => codeOf(e) === 'EFROZEN');
  });

  it('snapshot of a snapshot stays consistent', () => {
    const { resolver } = makeResolver();
    resolver.writeFile('/keep.txt', 'keep');
    const snap1 = resolver.snapshot();
    resolver.remove('/keep.txt');
    const snap2 = snap1.snapshot();
    assert.equal(snap2.readFile('/keep.txt'), 'keep');
    assert.throws(() => resolver.readFile('/keep.txt'), (e) => codeOf(e) === 'ENOENT');
  });
});
