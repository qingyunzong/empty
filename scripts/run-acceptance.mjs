// Acceptance runner: executes the three acceptance scenarios against the real
// CLI and writes commands, exit codes and outputs into result.txt.
//
//   node scripts/run-acceptance.mjs
//
// Child stdio is redirected to files because this environment interferes with
// grandchild stdio pipes.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(root, 'src', 'cli.js');

const lines = [];
const emit = (text = '') => {
  lines.push(text);
  console.log(text);
};

const run = (args) => {
  const dir = mkdtempSync(join(tmpdir(), 'accept-'));
  const outPath = join(dir, 'out.txt');
  const errPath = join(dir, 'err.txt');
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  const res = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', outFd, errFd] });
  closeSync(outFd);
  closeSync(errFd);
  return {
    status: res.status,
    stdout: readFileSync(outPath, 'utf8'),
    stderr: readFileSync(errPath, 'utf8'),
  };
};

const show = (title, args) => {
  emit(`\n### ${title}`);
  emit(`$ node src/cli.js ${args.join(' ')}`);
  const res = run(args);
  emit(`exit code: ${res.status}`);
  if (res.stdout) emit(`stdout:\n${res.stdout.trimEnd()}`);
  if (res.stderr) emit(`stderr:\n${res.stderr.trimEnd()}`);
  return res;
};

const tmp = mkdtempSync(join(tmpdir(), 'accept-state-'));
const state = join(tmp, 'state.json');

emit('# Acceptance run');
emit(`date: ${new Date().toISOString()}`);
emit(`node: ${process.version}`);

emit('\n## Test suite: node --test');
{
  const dir = mkdtempSync(join(tmpdir(), 'accept-test-'));
  const outPath = join(dir, 'out.txt');
  const errPath = join(dir, 'err.txt');
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  const res = spawnSync(process.execPath, ['--test'], { cwd: root, stdio: ['ignore', outFd, errFd] });
  closeSync(outFd);
  closeSync(errFd);
  const stdout = readFileSync(outPath, 'utf8');
  const stderr = readFileSync(errPath, 'utf8');
  emit('$ node --test');
  emit(`exit code: ${res.status}`);
  const combined = `${stdout}\n${stderr}`;
  const summary = combined.split('\n').filter((l) => l.startsWith('# ')).join('\n');
  emit(`summary:\n${summary}`);
}

emit('\n## Scenario 1: tight capacity, multiple optima, lexicographic tie-break');
show('schedule scenario1-tie.json', ['schedule', '--file', 'examples/scenario1-tie.json']);

emit('\n## Scenario 2: due conflict proven infeasible with minimum subset');
show('schedule scenario2-infeasible.json', ['schedule', '--file', 'examples/scenario2-infeasible.json']);

emit('\n## Scenario 3: undo of a capacity cut restores the original optimum');
show('schedule scenario3-undo.json (baseline)', ['schedule', '--file', 'examples/scenario3-undo.json', '--state', state]);
show('apply capacity cut', ['apply', '--state', state, '--op', '{"op":"setCapacity","capacity":{"L1":[{"start":0,"end":4,"capacity":1}]}}']);
show('undo capacity cut', ['undo', '--state', state]);
show('redo capacity cut', ['redo', '--state', state]);

writeFileSync(join(root, 'result.txt'), `${lines.join('\n')}\n`);
console.log('\nwrote result.txt');
