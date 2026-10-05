import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, ConfigLoader, loadConfig } from '../src/loader.js';

function captureError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${error}`);
    return error as ConfigError;
  }
  assert.fail('expected the call to throw');
}

describe('basic loading', () => {
  it('loads a single file without includes', () => {
    const { config, provenance } = loadConfig('app.json', {
      'app.json': JSON.stringify({ name: 'app', debug: false }),
    });
    assert.deepEqual(config, { name: 'app', debug: false });
    assert.deepEqual(provenance.get('name'), ['app.json']);
    assert.deepEqual(provenance.get('debug'), ['app.json']);
  });

  it('accepts a Map as the virtual file table', () => {
    const files = new Map([['app.json', JSON.stringify({ a: 1 })]]);
    const { config } = new ConfigLoader(files).load('app.json');
    assert.deepEqual(config, { a: 1 });
  });
});

describe('relative includes', () => {
  it('resolves includes relative to the including file', () => {
    const { config, provenance } = loadConfig('config/app.json', {
      'config/app.json': JSON.stringify({
        include: ['./base.json', '../shared/common.json'],
        name: 'app',
      }),
      'config/base.json': JSON.stringify({ timeout: 30 }),
      'shared/common.json': JSON.stringify({ locale: 'zh-CN' }),
    });
    assert.deepEqual(config, { timeout: 30, locale: 'zh-CN', name: 'app' });
    assert.deepEqual(provenance.get('timeout'), ['config/base.json']);
    assert.deepEqual(provenance.get('locale'), ['shared/common.json']);
    assert.deepEqual(provenance.get('name'), ['config/app.json']);
  });

  it('normalizes ".." segments in include paths', () => {
    const { config } = loadConfig('a/b/app.json', {
      'a/b/app.json': JSON.stringify({ include: '../c/base.json' }),
      'a/c/base.json': JSON.stringify({ x: 1 }),
    });
    assert.deepEqual(config, { x: 1 });
  });
});

describe('override semantics and provenance', () => {
  it('own keys override included keys and the chain records both files', () => {
    const { config, provenance } = loadConfig('app.json', {
      'app.json': JSON.stringify({
        include: 'base.json',
        server: { port: 8080 },
      }),
      'base.json': JSON.stringify({
        server: { host: 'localhost', port: 80 },
      }),
    });
    assert.deepEqual(config, { server: { host: 'localhost', port: 8080 } });
    // Overridden leaf: full source chain from base to override.
    assert.deepEqual(provenance.get('server.port'), ['base.json', 'app.json']);
    // Untouched leaf: single source.
    assert.deepEqual(provenance.get('server.host'), ['base.json']);
  });

  it('later includes override earlier ones, chain preserves order', () => {
    const { config, provenance } = loadConfig('app.json', {
      'app.json': JSON.stringify({ include: ['one.json', 'two.json'] }),
      'one.json': JSON.stringify({ level: 'info' }),
      'two.json': JSON.stringify({ level: 'debug' }),
    });
    assert.equal(config.level, 'debug');
    assert.deepEqual(provenance.get('level'), ['one.json', 'two.json']);
  });

  it('replacing an object with a scalar drops stale leaf provenance', () => {
    const { config, provenance } = loadConfig('app.json', {
      'app.json': JSON.stringify({ include: 'base.json', server: 'disabled' }),
      'base.json': JSON.stringify({ server: { host: 'localhost', port: 80 } }),
    });
    assert.deepEqual(config, { server: 'disabled' });
    assert.deepEqual(provenance.get('server'), ['app.json']);
    assert.equal(provenance.get('server.host'), undefined);
    assert.equal(provenance.get('server.port'), undefined);
  });
});

describe('array append', () => {
  it('concatenates arrays across includes and the including file', () => {
    const { config, provenance } = loadConfig('app.json', {
      'app.json': JSON.stringify({
        include: ['a.json', 'b.json'],
        plugins: ['app'],
      }),
      'a.json': JSON.stringify({ plugins: ['a1', 'a2'] }),
      'b.json': JSON.stringify({ plugins: ['b1'] }),
    });
    assert.deepEqual(config.plugins, ['a1', 'a2', 'b1', 'app']);
    assert.deepEqual(provenance.get('plugins'), [
      'a.json',
      'b.json',
      'app.json',
    ]);
  });

  it('appends arrays nested inside merged objects', () => {
    const { config, provenance } = loadConfig('app.json', {
      'app.json': JSON.stringify({
        include: 'base.json',
        server: { tags: ['prod'] },
      }),
      'base.json': JSON.stringify({ server: { tags: ['base'] } }),
    });
    assert.deepEqual(config.server, { tags: ['base', 'prod'] });
    assert.deepEqual(provenance.get('server.tags'), ['base.json', 'app.json']);
  });
});

describe('diamond includes', () => {
  const files = {
    'a.json': JSON.stringify({
      include: ['b.json', 'c.json'],
      name: 'app',
      tags: ['a'],
    }),
    'b.json': JSON.stringify({ include: 'd.json', tags: ['b'] }),
    'c.json': JSON.stringify({ include: 'd.json', tags: ['c'] }),
    'd.json': JSON.stringify({ name: 'base', tags: ['d'] }),
  };

  it('loads shared dependencies once per inclusion without a cycle error', () => {
    const { config } = loadConfig('a.json', files);
    // d.json is included twice (via b and via c): its effects apply twice.
    assert.equal(config.name, 'app');
    assert.deepEqual(config.tags, ['d', 'b', 'd', 'c', 'a']);
  });

  it('records every contribution in the provenance chain', () => {
    const { provenance } = loadConfig('a.json', files);
    assert.deepEqual(provenance.get('name'), ['d.json', 'd.json', 'a.json']);
    assert.deepEqual(provenance.get('tags'), [
      'd.json',
      'b.json',
      'd.json',
      'c.json',
      'a.json',
    ]);
  });
});

describe('cycle detection (current recursion stack only)', () => {
  it('rejects a direct cycle with the full include path', () => {
    const error = captureError(() =>
      loadConfig('a.json', {
        'a.json': JSON.stringify({ include: 'b.json' }),
        'b.json': JSON.stringify({ include: 'a.json' }),
      }),
    );
    assert.match(error.message, /Circular include detected/);
    assert.match(error.message, /a\.json -> b\.json -> a\.json/);
    assert.deepEqual(error.includePath, ['a.json', 'b.json', 'a.json']);
  });

  it('rejects a self-include', () => {
    const error = captureError(() =>
      loadConfig('self.json', {
        'self.json': JSON.stringify({ include: 'self.json' }),
      }),
    );
    assert.deepEqual(error.includePath, ['self.json', 'self.json']);
  });

  it('allows the same file on sibling branches (not a cycle)', () => {
    const { config } = loadConfig('root.json', {
      'root.json': JSON.stringify({ include: ['x.json', 'y.json'] }),
      'x.json': JSON.stringify({ include: 'shared.json', x: 1 }),
      'y.json': JSON.stringify({ include: 'shared.json', y: 2 }),
      'shared.json': JSON.stringify({ s: true }),
    });
    assert.deepEqual(config, { s: true, x: 1, y: 2 });
  });
});

describe('error reporting with full include path', () => {
  it('reports missing files with the chain from entry to failure', () => {
    const error = captureError(() =>
      loadConfig('app.json', {
        'app.json': JSON.stringify({ include: 'sub/b.json' }),
        'sub/b.json': JSON.stringify({ include: '../missing.json' }),
      }),
    );
    assert.match(error.message, /Config file not found: missing\.json/);
    assert.match(
      error.message,
      /include path: app\.json -> sub\/b\.json -> missing\.json/,
    );
    assert.deepEqual(error.includePath, ['app.json', 'sub/b.json', 'missing.json']);
  });

  it('reports invalid JSON with the include path', () => {
    const error = captureError(() =>
      loadConfig('app.json', {
        'app.json': JSON.stringify({ include: 'broken.json' }),
        'broken.json': '{ not json',
      }),
    );
    assert.match(error.message, /Invalid JSON in broken\.json/);
    assert.deepEqual(error.includePath, ['app.json', 'broken.json']);
  });

  it('rejects non-object config files', () => {
    assert.throws(
      () => loadConfig('app.json', { 'app.json': '[1, 2, 3]' }),
      /must contain a JSON object/,
    );
  });

  it('rejects malformed include directives', () => {
    const error = captureError(() =>
      loadConfig('app.json', {
        'app.json': JSON.stringify({ include: 42 }),
      }),
    );
    assert.match(error.message, /"include" must be a string or an array/);
    assert.deepEqual(error.includePath, ['app.json']);
  });
});
