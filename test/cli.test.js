import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../bin/corp.js';

function setup(ca, lots) {
  const dir = mkdtempSync(join(tmpdir(), 'corp-'));
  const caFile = join(dir, 'actions.ca');
  const lotsFile = join(dir, 'lots.json');
  writeFileSync(caFile, ca);
  writeFileSync(lotsFile, JSON.stringify(lots));
  return { caFile, lotsFile };
}

function run(argv) {
  const out = [];
  const err = [];
  const code = main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('corp apply prints positions and ledger', () => {
  const { caFile, lotsFile } = setup(
    `action S1 { security AAPL kind split ratio 1/2 exdate 2024-06-10 version 1 }
apply S1
sell AAPL 150 on 2024-06-20
reverse S1`,
    { cash: '0', lots: [{ id: 'L1', security: 'AAPL', qty: '100', date: '2024-01-05' }] },
  );
  const { code, stdout } = run(['apply', caFile, lotsFile, '--ledger']);
  assert.equal(code, 0);
  assert.match(stdout, /== Ledger ==/);
  assert.match(stdout, /APPLY S1 split AAPL v1/);
  assert.match(stdout, /REVERSE S1#rev1 inverse-of=S1/);
  assert.match(stdout, /RECEIVABLE AAPL -50/);
  assert.match(stdout, /== Positions ==\n\(none\)/);
});

test('corp apply exits 1 with E_RATIO on illegal ratio', () => {
  const { caFile, lotsFile } = setup(
    'action S1 { security AAPL kind split ratio 2 exdate 2024-06-10 version 1 }',
    { lots: [] },
  );
  const { code, stderr } = run(['apply', caFile, lotsFile]);
  assert.equal(code, 1);
  assert.match(stderr, /E_RATIO/);
});

test('corp apply exits 1 with E_LOT on oversell', () => {
  const { caFile, lotsFile } = setup('sell AAPL 10 on 2024-06-20', {
    lots: [{ id: 'L1', security: 'AAPL', qty: '5', date: '2024-01-05' }],
  });
  const { code, stderr } = run(['apply', caFile, lotsFile]);
  assert.equal(code, 1);
  assert.match(stderr, /E_LOT/);
});

test('corp compile dumps bytecode', () => {
  const { caFile } = setup(
    `action S1 { security AAPL kind split ratio 1/2 exdate 2024-06-10 version 1 }
apply S1`,
    { lots: [] },
  );
  const { code, stdout } = run(['compile', caFile]);
  assert.equal(code, 0);
  const instructions = JSON.parse(stdout);
  assert.equal(instructions.length, 1);
  assert.equal(instructions[0].op, 'APPLY');
  assert.equal(instructions[0].action.ratio, '0.5');
});

test('usage error exits 2', () => {
  const { code, stderr } = run(['apply']);
  assert.equal(code, 2);
  assert.match(stderr, /usage: corp/);
});
