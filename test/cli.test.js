import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const CLI = new URL('../src/cli.js', import.meta.url).pathname;

// Run the CLI through a shell with output redirected to files. (Piped
// stdio to grandchild processes is unreliable in some sandboxes.)
function runCli(dir, args) {
  const out = join(dir, 'stdout.txt');
  const err = join(dir, 'stderr.txt');
  const code = join(dir, 'code.txt');
  const quoted = [CLI, ...args].map((a) => `'${String(a).replaceAll("'", "'\\''")}'`).join(' ');
  spawnSync('bash', ['-c', `node ${quoted} >'${out}' 2>'${err}'; echo $? >'${code}'`]);
  return {
    status: Number(readFileSync(code, 'utf8').trim()),
    stdout: readFileSync(out, 'utf8'),
    stderr: readFileSync(err, 'utf8'),
  };
}

const writeEvents = (dir, name, events) => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(events));
  return path;
};

describe('CLI', () => {
  it('ingest + query round-trip exits 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptime-'));
    const db = join(dir, 'state.json');
    const file = writeEvents(dir, 'events.json', [
      { id: 'e1', device: 'A', ts: 10, state: 'down', node: 'n1', clock: { n1: 1 } },
      { id: 'e2', device: 'A', ts: 20, state: 'up', node: 'n1', clock: { n1: 2 } },
    ]);
    const ingested = runCli(dir, ['ingest', '--db', db, '--file', file]);
    assert.equal(ingested.status, 0, ingested.stderr);
    assert.deepEqual(JSON.parse(ingested.stdout).accepted, ['e1', 'e2']);

    const queried = runCli(dir, ['query', '--db', db, '--watermark', '40']);
    assert.equal(queried.status, 0, queried.stderr);
    const report = JSON.parse(queried.stdout);
    assert.equal(report.devices.A.status, 'ok');
    assert.equal(report.devices.A.downtime, 10);
  });

  it('schema errors exit 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptime-'));
    const db = join(dir, 'state.json');
    const file = writeEvents(dir, 'bad.json', [
      { id: 'e1', device: 'A', ts: 10, state: 'sideways', node: 'n1', clock: {} },
    ]);
    const result = runCli(dir, ['ingest', '--db', db, '--file', file]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /schema error/);
  });

  it('diff exits 0 and shows added events and corrections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptime-'));
    const dbA = join(dir, 'a.json');
    const dbB = join(dir, 'b.json');
    const f1 = writeEvents(dir, 'e1.json', [
      { id: 'e1', device: 'A', ts: 30, state: 'up', node: 'n1', clock: { n1: 1 } },
    ]);
    const f2 = writeEvents(dir, 'e2.json', [
      { id: 'e2', device: 'A', ts: 10, state: 'down', node: 'n2', clock: { n2: 1 } },
    ]);
    assert.equal(runCli(dir, ['ingest', '--db', dbA, '--file', f1]).status, 0);
    writeFileSync(dbB, readFileSync(dbA, 'utf8'));
    assert.equal(runCli(dir, ['ingest', '--db', dbB, '--file', f2]).status, 0);
    const diff = runCli(dir, ['diff', dbA, dbB]);
    assert.equal(diff.status, 0, diff.stderr);
    const parsed = JSON.parse(diff.stdout);
    assert.deepEqual(parsed.addedEvents.map((e) => e.id), ['e2']);
    assert.deepEqual(parsed.addedCorrections.map((c) => c.eventId), ['e2']);
  });

  it('unknown command exits 2', () => {
    assert.equal(runCli(mkdtempSync(join(tmpdir(), 'uptime-')), ['bogus']).status, 2);
  });
});
