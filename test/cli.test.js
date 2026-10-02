'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { baseRequest } = require('./helpers');

const CLI = path.join(__dirname, '..', 'cli.js');

// NOTE: this sandbox cannot pipe stdio between parent and child processes,
// so the CLI is exercised end-to-end via files: request JSON is written to
// disk, stdout is redirected to a file, and the exit code is captured.
function runCli(args, input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cli-'));
  const outFile = path.join(dir, 'stdout.json');
  const errFile = path.join(dir, 'stderr.txt');
  const codeFile = path.join(dir, 'exitcode');
  const cliArgs = [...args];
  if (input !== undefined) {
    const reqFile = path.join(dir, 'request.json');
    fs.writeFileSync(reqFile, JSON.stringify(input));
    cliArgs.push('--file', reqFile);
  }
  const quoted = [process.execPath, CLI, ...cliArgs].map((p) => `'${p}'`).join(' ');
  const shell = `${quoted} > '${outFile}' 2> '${errFile}'; echo $? > '${codeFile}'`;
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', shell], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', () => {
      const status = Number(fs.readFileSync(codeFile, 'utf8').trim());
      const stdout = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
      const stderr = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '';
      resolve({ status, stdout, stderr });
    });
  });
}

test('sample command reads JSON and writes certificate JSON to stdout', async () => {
  const result = await runCli(['sample'], baseRequest());
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.seed, 'audit-seed-1');
  assert.equal(output.version, 1);
  assert.equal(output.samples.length, 2);
  assert.equal(typeof output.merkleRoot, 'string');
  assert.ok(Array.isArray(output.invalidated));
  assert.ok(output.quotaUse.perStratum.retail);
});

test('failures exit with code 2 and print the error code as JSON', async () => {
  const request = baseRequest();
  delete request.seed;
  const result = await runCli(['sample'], request);
  assert.equal(result.status, 2);
  const error = JSON.parse(result.stdout);
  assert.equal(error.error.code, 'SEED_REQUIRED');
});

test('STRATA_MISSING exits 2 and lists gaps', async () => {
  const result = await runCli(['sample'], baseRequest({ strata: [{ id: 'nope', quota: 1 }] }));
  assert.equal(result.status, 2);
  const error = JSON.parse(result.stdout);
  assert.equal(error.error.code, 'STRATA_MISSING');
  assert.ok(error.error.details.gaps.length >= 1);
});

test('verify command validates a certificate and rejects tampering', async () => {
  const sampled = await runCli(['sample'], baseRequest());
  assert.equal(sampled.status, 0, sampled.stderr);
  const cert = JSON.parse(sampled.stdout);

  const ok = await runCli(['verify'], cert);
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(JSON.parse(ok.stdout).valid, true);

  const tampered = JSON.parse(JSON.stringify(cert));
  tampered.merkleRoot = '0'.repeat(64);
  const bad = await runCli(['verify'], tampered);
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stdout).valid, false);
});

test('state file enables incremental re-sampling across CLI invocations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cli-state-'));
  const statePath = path.join(dir, 'state.json');

  const first = await runCli(['sample', '--state', statePath], baseRequest());
  assert.equal(first.status, 0, first.stderr);
  assert.ok(fs.existsSync(statePath));

  const v2 = baseRequest({ version: 2, revocations: ['tx-retail-2'] });
  const second = await runCli(['sample', '--state', statePath], v2);
  assert.equal(second.status, 0, second.stderr);
  const out = JSON.parse(second.stdout);
  assert.equal(out.invalidated.length, 1);
  assert.equal(out.invalidated[0].stratum, 'retail');
  const wholesale = out.samples.find((s) => s.stratum === 'wholesale');
  assert.equal(wholesale.sampledAtVersion, 1);

  const verify = await runCli(['verify'], out);
  assert.equal(verify.status, 0);
  assert.equal(JSON.parse(verify.stdout).valid, true);
});

test('unknown command exits 2', async () => {
  const result = await runCli(['bogus'], {});
  assert.equal(result.status, 2);
});
