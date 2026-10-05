'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli.js');

// Runs the CLI in a subprocess. Output is captured via shell redirection
// because this environment does not allow piping from spawned node processes.
function runCli(args, { input } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biobank-cli-'));
  const outPath = path.join(dir, 'stdout.txt');
  const errPath = path.join(dir, 'stderr.txt');
  const codePath = path.join(dir, 'code.txt');
  let cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)}`;
  for (const a of args) cmd += ` ${JSON.stringify(a)}`;
  if (input !== undefined) {
    const inPath = path.join(dir, 'stdin.txt');
    fs.writeFileSync(inPath, input);
    cmd += ` < ${JSON.stringify(inPath)}`;
  }
  cmd += ` > ${JSON.stringify(outPath)} 2> ${JSON.stringify(errPath)}; echo $? > ${JSON.stringify(codePath)}`;
  spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
  return {
    status: Number(fs.readFileSync(codePath, 'utf8').trim()),
    stdout: fs.readFileSync(outPath, 'utf8'),
    stderr: fs.readFileSync(errPath, 'utf8'),
    dir,
  };
}

function stdoutLines(res) {
  const t = res.stdout.trim();
  return t === '' ? [] : t.split('\n').map((l) => JSON.parse(l));
}

function stderrJson(res) {
  const t = res.stderr.trim();
  return t === '' ? [] : t.split('\n').map((l) => JSON.parse(l));
}

module.exports = { runCli, stdoutLines, stderrJson, CLI };
