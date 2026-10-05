import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as process from 'node:process';

const CLI = new URL('../src/cli.js', import.meta.url).pathname;

interface RunResult {
  code: number | null;
  stderr: string;
}

// Note: this sandbox cannot read a spawned child's stdout pipe, so the CLI
// is exercised through --out files; exit codes and stderr still come back.
function run(args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin?.end(input);
  });
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'merge3-'));
  const write = (name: string, lines: string[]) => {
    const file = join(dir, name);
    writeFileSync(file, lines.join('\n') + '\n');
    return file;
  };
  return { dir, write };
}

test('clean merge exits 0 and writes the merged document', async () => {
  const { dir, write } = fixture();
  const base = write('base.txt', ['l1', 'l2', 'l3']);
  const ours = write('ours.txt', ['L1', 'l2', 'l3']);
  const theirs = write('theirs.txt', ['l1', 'l2', 'L3']);
  const out = join(dir, 'merged.txt');
  const r = await run([base, ours, theirs, '--out', out]);
  assert.equal(r.code, 0);
  assert.equal(readFileSync(out, 'utf8'), ['L1', 'l2', 'L3'].join('\n') + '\n');
});

test('conflicting merge exits 1 and emits markers preserving both branches', async () => {
  const { dir, write } = fixture();
  const base = write('base.txt', ['a', 'b']);
  const ours = write('ours.txt', ['a', 'X', 'b']);
  const theirs = write('theirs.txt', ['a', 'Y', 'b']);
  const out = join(dir, 'merged.txt');
  const r = await run([base, ours, theirs, '--out', out]);
  assert.equal(r.code, 1);
  assert.match(readFileSync(out, 'utf8'), /<<<<<<< ours\nX\n\|\|\|\|\|\|\| base\n=======\nY\n>>>>>>> theirs/);
});

test('--json writes a reversible result; revert reconstructs all three inputs', async () => {
  const { dir, write } = fixture();
  const base = write('base.txt', ['h1', 'h2', 'h3', 'h4']);
  const toRevert: Array<['base' | 'ours' | 'theirs', string]> = [
    ['base', base],
  ];
  const ours = write('ours.txt', ['h1', 'O2', 'O3', 'h4']);
  const theirs = write('theirs.txt', ['h1', 'h2', 'T3', 'T4']);
  toRevert.push(['ours', ours], ['theirs', theirs]);
  const json = join(dir, 'result.json');
  const merged = join(dir, 'merged.txt');
  const r = await run(['merge', base, ours, theirs, '--json', json, '--out', merged]);
  assert.equal(r.code, 1);
  const result = JSON.parse(readFileSync(json, 'utf8'));
  assert.equal(result.clean, false);
  assert.equal(result.conflictCount, 1);
  for (const [side, file] of toRevert) {
    const out = join(dir, `reverted-${side}.txt`);
    const back = await run(['revert', '--result', json, '--side', side, '--merged', merged, '--out', out]);
    assert.equal(back.code, 0, `revert --side ${side} exit code`);
    assert.equal(readFileSync(out, 'utf8'), readFileSync(file, 'utf8'), `revert --side ${side}`);
  }
});

test('revert reads the merged document from stdin when --merged is omitted', async () => {
  const { dir, write } = fixture();
  const base = write('base.txt', ['one', 'two']);
  const ours = write('ours.txt', ['ONE', 'two']);
  const theirs = write('theirs.txt', ['one', 'TWO']);
  const json = join(dir, 'result.json');
  const merged = join(dir, 'merged.txt');
  const r = await run([base, ours, theirs, '--json', json, '--out', merged]);
  assert.equal(r.code, 0);
  const out = join(dir, 'reverted.txt');
  const back = await run(
    ['revert', '--result', json, '--side', 'theirs', '--out', out],
    readFileSync(merged, 'utf8'),
  );
  assert.equal(back.code, 0);
  assert.equal(readFileSync(out, 'utf8'), readFileSync(theirs, 'utf8'));
});

test('custom labels are used in conflict markers', async () => {
  const { dir, write } = fixture();
  const base = write('base.txt', ['a']);
  const ours = write('ours.txt', ['b']);
  const theirs = write('theirs.txt', ['c']);
  const out = join(dir, 'merged.txt');
  const r = await run([base, ours, theirs, '--out', out, '--label-ours', 'HEAD', '--label-theirs', 'feature']);
  assert.equal(r.code, 1);
  const text = readFileSync(out, 'utf8');
  assert.match(text, /<<<<<<< HEAD/);
  assert.match(text, />>>>>>> feature/);
});

test('usage errors exit 2', async () => {
  assert.equal((await run([])).code, 2);
  assert.equal((await run(['only-one-file'])).code, 2);
  assert.equal((await run(['revert', '--side', 'bogus'])).code, 2);
});
