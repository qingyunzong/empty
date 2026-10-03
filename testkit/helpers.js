'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../cli.js');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cert-'));
  return {
    dir,
    path(name) { return path.join(dir, name); },
    writeJson(name, value) { fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2)); },
    writeJsonl(name, records) {
      fs.writeFileSync(path.join(dir, name), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    },
    appendJsonl(name, record) {
      fs.appendFileSync(path.join(dir, name), JSON.stringify(record) + '\n');
    },
    readJsonl(name) {
      return fs.readFileSync(path.join(dir, name), 'utf8')
        .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    },
    readRaw(name) { return fs.readFileSync(path.join(dir, name), 'utf8'); },
    writeRaw(name, text) { fs.writeFileSync(path.join(dir, name), text); },
  };
}

// In-process CLI invocation (sandbox forbids spawning child processes).
function runCli(ws, command) {
  const result = { stdout: '', stderr: '' };
  const status = run([
    command,
    '--lots', ws.path('lots.json'),
    '--tests', ws.path('tests.jsonl'),
    '--policy', ws.path('policy.json'),
    '--cert', ws.path('cert.jsonl'),
  ], {
    stdout: (s) => { result.stdout += s; },
    stderr: (s) => { result.stderr += s; },
  });
  return { status, stdout: result.stdout, stderr: result.stderr };
}

const BASE_POLICY = {
  families: { meals: 1, bakery: 2, infant: 3 },
  versions: [
    {
      version: 1,
      rules: [
        { id: 'R1', severity: 1, action: 'release' },
        { id: 'R2', severity: 2, action: 'hold' },
        { id: 'R3', severity: 3, action: 'recall' },
      ],
    },
    {
      version: 2,
      rules: [
        { id: 'R4', severity: 2, action: 'release' },
        { id: 'R5', severity: 3, action: 'release' },
      ],
    },
  ],
};

module.exports = { makeWorkspace, runCli, BASE_POLICY };
