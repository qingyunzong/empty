'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const WINDOW_MS = 5 * 60 * 1000;
const T0 = 1_700_000_000_000;
const W0 = Math.floor(T0 / WINDOW_MS) * WINDOW_MS;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'joiner-test-'));
}

// Note: this sandbox drops pipe writes to a spawned child's stdin, so the
// tests feed input through --input files (the CLI still defaults to stdin).
function runCli(args, input) {
  const dir = tmpdir();
  const finalArgs = [...args];
  if (input !== null) {
    const inputPath = path.join(dir, 'input.jsonl');
    fs.writeFileSync(inputPath, input);
    finalArgs.push('--input', inputPath);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...finalArgs]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end();
  });
}

function stdoutLines(result) {
  return result.stdout.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

const SCENARIO = [
  { type: 'EVENT', event: 'QC_RESULT', op: 'UPSERT', sampleId: 'S1', eventTime: W0 + 2000 },
  { type: 'EVENT', event: 'SAMPLE_ACQUIRED', op: 'UPSERT', sampleId: 'S1', eventTime: W0 + 1000 },
  { type: 'EVENT', event: 'SAMPLE_ACQUIRED', op: 'UPSERT', sampleId: 'S2', eventTime: W0 + 3000 },
  { type: 'EVENT', event: 'QC_RESULT', op: 'RETRACT', sampleId: 'S1', eventTime: W0 + 2000 },
  { type: 'EVENT', event: 'QC_RESULT', op: 'UPSERT', sampleId: 'S1', eventTime: W0 + 4000 },
  { type: 'WATERMARK', time: W0 + WINDOW_MS },
  { type: 'EVENT', event: 'SAMPLE_ACQUIRED', op: 'UPSERT', sampleId: 'S3', eventTime: W0 + 500 },
];
const SCENARIO_INPUT = SCENARIO.map((r) => JSON.stringify(r)).join('\n') + '\n';

test('clean run: out-of-order join, withdraw cascade, expire, late', async () => {
  const dir = tmpdir();
  const result = await runCli(['--state', path.join(dir, 'state.log')], SCENARIO_INPUT);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const out = stdoutLines(result);
  assert.deepEqual(out.map((o) => o.type), ['JOINED', 'WITHDRAW', 'JOINED', 'EXPIRED_UNJOINED', 'LATE']);
  assert.equal(out[0].sampleId, 'S1');
  assert.equal(out[1].sampleId, 'S1');
  assert.equal(out[2].sampleId, 'S1');
  assert.equal(out[3].sampleId, 'S2');
  assert.equal(out[3].side, 'SAMPLE_ACQUIRED');
  assert.equal(out[4].record.sampleId, 'S3');
});

test('crash after Nth record, recovery output matches clean run exactly', async () => {
  const dir = tmpdir();
  const clean = await runCli(['--state', path.join(dir, 'clean.log')], SCENARIO_INPUT);
  assert.equal(clean.status, 0, clean.stderr);

  for (const crashAfter of [1, 2, 3, 4, 5, 6, 7]) {
    const statePath = path.join(dir, `crash-${crashAfter}.log`);
    const crashed = await runCli(['--state', statePath, '--crashAfter', String(crashAfter)], SCENARIO_INPUT);
    assert.equal(crashed.status, 101, `crashAfter=${crashAfter}`);
    assert.equal(crashed.stderr, '');

    const recovered = await runCli(['--state', statePath, '--recover'], SCENARIO_INPUT);
    assert.equal(recovered.status, 0, `recover after crashAfter=${crashAfter}: ${recovered.stderr}`);
    assert.equal(recovered.stderr, '');

    assert.equal(
      crashed.stdout + recovered.stdout,
      clean.stdout,
      `combined output for crashAfter=${crashAfter} must equal clean run`
    );
  }
});

test('recovery without prior crash replays nothing new', async () => {
  const dir = tmpdir();
  const statePath = path.join(dir, 'state.log');
  const first = await runCli(['--state', statePath], SCENARIO_INPUT);
  assert.equal(first.status, 0);
  const second = await runCli(['--state', statePath, '--recover'], '');
  assert.equal(second.status, 0);
  assert.equal(second.stdout, '');
});

test('malformed input exits 2 with MALFORMED on stderr', async () => {
  const dir = tmpdir();
  const input = JSON.stringify(SCENARIO[0]) + '\nnot-json\n';
  const result = await runCli(['--state', path.join(dir, 'state.log')], input);
  assert.equal(result.status, 2);
  const err = JSON.parse(result.stderr);
  assert.equal(err.error, 'MALFORMED');
  // The malformed line must not be persisted; only the valid record is.
  const logLines = fs.readFileSync(path.join(dir, 'state.log'), 'utf8').trim().split('\n');
  assert.equal(logLines.length, 2); // in + commit for the first record only
});

test('unknown retract exits 2 with UNKNOWN_RETRACT', async () => {
  const dir = tmpdir();
  const input = JSON.stringify({ type: 'EVENT', event: 'QC_RESULT', op: 'RETRACT', sampleId: 'X', eventTime: W0 + 1 }) + '\n';
  const result = await runCli(['--state', path.join(dir, 'state.log')], input);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).error, 'UNKNOWN_RETRACT');
});

test('corrupt state log exits 2 with DURABLE_STATE_CORRUPT', async () => {
  const dir = tmpdir();
  const statePath = path.join(dir, 'state.log');
  fs.writeFileSync(statePath, '{"seq":1,"kind":"in","record":{}}\nGARBAGE\n');
  const result = await runCli(['--state', statePath, '--recover'], '');
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).error, 'DURABLE_STATE_CORRUPT');
});

test('recover with missing state log exits 2 with DURABLE_STATE_CORRUPT', async () => {
  const dir = tmpdir();
  const result = await runCli(['--state', path.join(dir, 'missing.log'), '--recover'], '');
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).error, 'DURABLE_STATE_CORRUPT');
});

test('missing --state exits 2 with MALFORMED', async () => {
  const result = await runCli([], '');
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).error, 'MALFORMED');
});
