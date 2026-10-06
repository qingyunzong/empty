import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const WINDOW_MS = 5 * 60 * 1000;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'joiner-test-'));
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

// Feed records through stdin via a temp file (portable across environments).
function runCli(args, input) {
  const dir = tmpdir();
  const inputPath = path.join(dir, 'input.ndjson');
  const stdoutPath = path.join(dir, 'stdout.txt');
  const stderrPath = path.join(dir, 'stderr.txt');
  fs.writeFileSync(inputPath, input);
  const cmd = [process.execPath, CLI, ...args].map(shQuote).join(' ') + ` < ${shQuote(inputPath)}`;
  const res = spawnSync('sh', ['-c', `${cmd} > ${shQuote(stdoutPath)} 2> ${shQuote(stderrPath)}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: res.status,
    stdout: fs.readFileSync(stdoutPath, 'utf8'),
    stderr: fs.readFileSync(stderrPath, 'utf8'),
  };
}

// A scenario covering: out-of-order join, retract cascade WITHDRAW, re-join,
// unmatched expiry at watermark close, and LATE records after close.
const SCENARIO = [
  { type: 'UPSERT', eventType: 'SAMPLE_ACQUIRED', eventId: 'e1', sampleId: 's1', eventTime: 1000 },
  { type: 'UPSERT', eventType: 'QC_RESULT', eventId: 'q1', sampleId: 's1', eventTime: 60000 },
  { type: 'UPSERT', eventType: 'QC_RESULT', eventId: 'q2', sampleId: 's2', eventTime: 120000 },
  { type: 'UPSERT', eventType: 'SAMPLE_ACQUIRED', eventId: 'e2', sampleId: 's2', eventTime: 2000 },
  { type: 'RETRACT', eventType: 'SAMPLE_ACQUIRED', eventId: 'e2', eventTime: 2000 },
  { type: 'UPSERT', eventType: 'SAMPLE_ACQUIRED', eventId: 'e3', sampleId: 's2', eventTime: 3000 },
  { type: 'UPSERT', eventType: 'QC_RESULT', eventId: 'q9', sampleId: 's9', eventTime: 250000 },
  { type: 'UPSERT', eventType: 'SAMPLE_ACQUIRED', eventId: 'e8', sampleId: 's8', eventTime: WINDOW_MS + 1000 },
  { type: 'WATERMARK', time: WINDOW_MS },
  { type: 'UPSERT', eventType: 'SAMPLE_ACQUIRED', eventId: 'e7', sampleId: 's7', eventTime: 299999 },
  { type: 'RETRACT', eventType: 'QC_RESULT', eventId: 'q9', eventTime: 250000 },
  { type: 'UPSERT', eventType: 'QC_RESULT', eventId: 'q8', sampleId: 's8', eventTime: WINDOW_MS + 2000 },
  { type: 'WATERMARK', time: 2 * WINDOW_MS },
];
const SCENARIO_INPUT = SCENARIO.map((r) => JSON.stringify(r)).join('\n') + '\n';

function parseLines(text) {
  return text.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

test('acceptance: out-of-order join, retract cascade, expiry and late records', () => {
  const dir = tmpdir();
  const res = runCli(['--state', path.join(dir, 'state.log')], SCENARIO_INPUT);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '');
  const out = parseLines(res.stdout);
  const types = out.map((o) => o.type);
  assert.deepEqual(types, [
    'JOINED',            // e1 x q1 (s1)
    'JOINED',            // e2 x q2 (s2, qc arrived first)
    'WITHDRAW',          // e2 retracted before close
    'JOINED',            // e3 x q2 (re-judged)
    'EXPIRED_UNJOINED',  // q9 never matched, window closed by watermark
    'LATE',              // e7 upsert after window 0 closed
    'LATE',              // q9 retract after window 0 closed
    'JOINED',            // e8 x q8 (s8, second window)
  ]);
  assert.equal(out[1].sampleEventId, 'e2');
  assert.equal(out[1].qcEventId, 'q2');
  assert.equal(out[2].type, 'WITHDRAW');
  assert.equal(out[2].sampleEventId, 'e2');
  assert.equal(out[4].eventId, 'q9');
  assert.equal(out[4].side, 'QC_RESULT');
});

test('acceptance: crash after Nth record, recovery output identical to normal run', () => {
  const dir = tmpdir();
  const normal = runCli(['--state', path.join(dir, 'normal.log')], SCENARIO_INPUT);
  assert.equal(normal.status, 0, normal.stderr);

  const crashPoints = [1, 3, 5, 9, SCENARIO.length];
  for (const n of crashPoints) {
    const statePath = path.join(dir, `crash-${n}.log`);
    const crashed = runCli(['--state', statePath, '--crashAfter', String(n)], SCENARIO_INPUT);
    assert.equal(crashed.status, 101, `crashAfter=${n}: expected exit 101, got ${crashed.status}`);
    const recovered = runCli(['--state', statePath, '--recover'], SCENARIO_INPUT);
    assert.equal(recovered.status, 0, `crashAfter=${n}: recover failed: ${recovered.stderr}`);
    assert.equal(
      crashed.stdout + recovered.stdout,
      normal.stdout,
      `crashAfter=${n}: combined output must equal the no-crash output`,
    );
  }
});

test('acceptance: crashAfter beyond the record count never crashes', () => {
  const dir = tmpdir();
  const res = runCli(['--state', path.join(dir, 'state.log'), '--crashAfter', '999'], SCENARIO_INPUT);
  assert.equal(res.status, 0, res.stderr);
  const normal = runCli(['--state', path.join(dir, 'normal.log')], SCENARIO_INPUT);
  assert.equal(res.stdout, normal.stdout);
});

test('error: malformed input exits 2 with MALFORMED on stderr', () => {
  const dir = tmpdir();
  for (const input of ['not json\n', '{"type":"WATERMARK"}\n', '{"type":"UPSERT"}\n']) {
    const res = runCli(['--state', path.join(dir, 'state.log')], input);
    assert.equal(res.status, 2, `input=${input.trim()}`);
    const err = JSON.parse(res.stderr);
    assert.equal(err.error, 'MALFORMED');
  }
});

test('error: retract of unknown event exits 2 with UNKNOWN_RETRACT', () => {
  const dir = tmpdir();
  const input = JSON.stringify({ type: 'RETRACT', eventType: 'SAMPLE_ACQUIRED', eventId: 'ghost', eventTime: 1000 }) + '\n';
  const res = runCli(['--state', path.join(dir, 'state.log')], input);
  assert.equal(res.status, 2);
  const err = JSON.parse(res.stderr);
  assert.equal(err.error, 'UNKNOWN_RETRACT');
});

test('error: corrupt state log exits 2 with DURABLE_STATE_CORRUPT', () => {
  const dir = tmpdir();
  const garbage = path.join(dir, 'garbage.log');
  fs.writeFileSync(garbage, 'this is not json\n');
  let res = runCli(['--state', garbage, '--recover'], '');
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stderr).error, 'DURABLE_STATE_CORRUPT');

  const missing = path.join(dir, 'missing.log');
  res = runCli(['--state', missing, '--recover'], '');
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stderr).error, 'DURABLE_STATE_CORRUPT');

  // record without committed results followed by another record
  const dangling = path.join(dir, 'dangling.log');
  fs.writeFileSync(dangling, [
    JSON.stringify({ kind: 'record', seq: 1, record: { type: 'WATERMARK', time: 1 } }),
    JSON.stringify({ kind: 'record', seq: 2, record: { type: 'WATERMARK', time: 2 } }),
    '',
  ].join('\n'));
  res = runCli(['--state', dangling, '--recover'], '');
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stderr).error, 'DURABLE_STATE_CORRUPT');
});
