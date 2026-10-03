'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../cli');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clrscan-'));
  const file = path.join(dir, 'file.jsonl');
  const rules = path.join(dir, 'rules.json');
  fs.writeFileSync(file, [
    JSON.stringify({ clearingNo: 'C1', counterparty: 'ACME', currency: 'CNY', amount: '10', memo: 'normal' }),
    JSON.stringify({ clearingNo: 'C2', counterparty: 'BO', currency: 'USD', amount: '99999', memo: 'urgent split' }),
    '',
  ].join('\n'));
  fs.writeFileSync(rules, JSON.stringify({
    exact: [{ id: 'E1', pattern: 'urgent' }, { id: 'E2', pattern: 'split' }],
    regex: [{ id: 'R1', field: 'amount', pattern: '[0-9]{5,}' }],
  }));
  return { dir, file, rules };
}

function collect() {
  const lines = [];
  return { lines, io: { write: (l) => lines.push(l) } };
}

test('CLI: scan file.jsonl rules.json prints hits/proof/stats', async () => {
  const { file, rules } = setup();
  const { lines, io } = collect();
  await main(['scan', file, rules], io);
  const r = JSON.parse(lines[0]);
  assert.ok(Array.isArray(r.hits));
  assert.equal(r.hits.length, 3);
  assert.deepEqual(r.hits.map((h) => h.ruleId), ['R1', 'E1', 'E2']); // sorted by start, length, ruleId
  assert.equal(r.proof.version, 1);
  assert.equal(r.proof.lineCount, 2);
  assert.equal(r.stats.lines, 2);
});

test('CLI exec: load/patch/scan over JSONL commands, BAD_PATCH keeps file intact', async () => {
  const { file, rules } = setup();
  const cmds = [
    JSON.stringify({ cmd: 'load', file }),
    JSON.stringify({ cmd: 'scan' }),
    JSON.stringify({ cmd: 'patch', line: 1, text: JSON.stringify({ clearingNo: 'C2', counterparty: 'BO', currency: 'USD', amount: '5', memo: 'calm now' }) }),
    JSON.stringify({ cmd: 'patch', line: 9, text: '{}' }),
    JSON.stringify({ cmd: 'patch', line: 0, text: 'not json' }),
    JSON.stringify({ cmd: 'scan' }),
  ].join('\n');
  const { lines, io } = collect();
  await main(['exec', rules], { ...io, stdin: cmds });
  const out = lines.map(JSON.parse);
  assert.deepEqual(out[0], { ok: true, lines: 2 });
  assert.equal(out[1].hits.length, 3);
  assert.equal(out[2].ok, true);
  assert.deepEqual(out[2].window, { start: 1, end: 1 });
  assert.equal(out[2].contextIntact, true);
  assert.equal(out[3].error, 'BAD_PATCH');
  assert.equal(out[4].error, 'BAD_PATCH');
  assert.equal(out[5].hits.length, 0);
  // failed patches left state consistent: verify own proof
  const verifyIo = collect();
  await main(['exec', rules], {
    ...verifyIo.io,
    stdin: [JSON.stringify({ cmd: 'load', file }), JSON.stringify({ cmd: 'scan' })].join('\n'),
  });
  const fresh = JSON.parse(verifyIo.lines[1]);
  assert.equal(fresh.hits.length, 3); // file on disk untouched by patches
});

test('CLI exec: verify ok and PROOF_MISMATCH on tamper', async () => {
  const { file, rules } = setup();
  const scanIo = collect();
  await main(['scan', file, rules], scanIo.io);
  const proof = JSON.parse(scanIo.lines[0]).proof;
  const tampered = JSON.parse(JSON.stringify(proof));
  tampered.hits[0].start += 1;
  const cmds = [
    JSON.stringify({ cmd: 'load', file }),
    JSON.stringify({ cmd: 'verify', proof }),
    JSON.stringify({ cmd: 'verify', proof: tampered }),
  ].join('\n');
  const { lines, io } = collect();
  await main(['exec', rules], { ...io, stdin: cmds });
  const out = lines.map(JSON.parse);
  assert.deepEqual(out[1], { ok: true, hits: 3 });
  assert.equal(out[2].error, 'PROOF_MISMATCH');
});
