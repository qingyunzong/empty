'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Ledger, runToollife, ToolLifeError } = require('../src/toollife');

const TOOLS = {
  tools: [
    { tool_id: 'T1', max_life: 100, materials: { steel: 2, aluminum: 1 } },
    { tool_id: 'T2', max_life: 50, materials: { steel: 5 } },
  ],
};

// ---------- acceptance 1: enumerate legal undo sets for n <= 10 ----------

test('exhaustive undo subsets for n<=10 cuts match reference remaining life', () => {
  for (let n = 1; n <= 10; n += 1) {
    const deductions = Array.from({ length: n }, (_, i) => (i % 5) + 3); // 3..7
    const totalCuts = deductions.reduce((a, b) => a + b, 0);

    for (let mask = 0; mask < (1 << n); mask += 1) {
      const undoSet = [];
      for (let i = 0; i < n; i += 1) if (mask & (1 << i)) undoSet.push(i);

      const operations = deductions.map((d, i) => ({
        op_id: `op${i}`, type: 'cut', tool_id: 'T1', material: 'aluminum', units: d,
      }));
      const undos = undoSet.map((i, k) => ({ undo_id: `u${k}`, op_id: `op${i}` }));
      const ledger = runToollife(TOOLS, operations, undos);

      const undoneSum = undoSet.reduce((acc, i) => acc + deductions[i], 0);
      const expected = 100 - (totalCuts - undoneSum);
      assert.equal(
        ledger.state().tools.T1.remaining_life, expected,
        `n=${n} mask=${mask.toString(2)} final life mismatch`,
      );

      // every undo is applied or compensated exactly once; compensation is paired
      const undoRecords = ledger.history.filter((h) => h.kind === 'undo');
      assert.equal(undoRecords.length, undoSet.length);
      for (const rec of undoRecords) {
        assert.ok(rec.result === 'applied' || rec.result === 'compensated');
        if (rec.result === 'compensated') {
          const comp = ledger.history.find(
            (h) => h.kind === 'compensate_op' && h.op_id === rec.compensate_op_id,
          );
          assert.ok(comp, `missing compensate_op for ${rec.undo_id}`);
          assert.equal(comp.reverses, rec.op_id);
        }
      }
      const reversalsPerOp = new Map();
      for (const rec of undoRecords) {
        reversalsPerOp.set(rec.op_id, (reversalsPerOp.get(rec.op_id) || 0) + 1);
      }
      for (const count of reversalsPerOp.values()) assert.equal(count, 1);
    }
  }
});

test('undo of latest cut is direct; earlier cut with active successors is compensated', () => {
  const ledger = runToollife(TOOLS, [
    { op_id: 'c1', type: 'cut', tool_id: 'T1', material: 'steel', units: 10 },
    { op_id: 'c2', type: 'cut', tool_id: 'T1', material: 'steel', units: 10 },
  ], [
    { undo_id: 'u1', op_id: 'c2' },
    { undo_id: 'u2', op_id: 'c1' },
  ]);
  const [u1, u2] = ledger.history.filter((h) => h.kind === 'undo');
  assert.equal(u1.result, 'applied'); // c2 was latest -> direct undo
  assert.equal(u2.result, 'applied'); // c1 latest after c2 undone -> direct undo
  assert.equal(ledger.state().tools.T1.remaining_life, 100);
});

// ---------- acceptance 2: cut -> regrind -> undo cut is compensated ----------

test('cut then regrind then undo cut: direct undo refused, compensate_op emitted', () => {
  const ledger = runToollife(TOOLS, [
    { op_id: 'c1', type: 'cut', tool_id: 'T1', material: 'steel', units: 10 }, // -20 -> 80
    { op_id: 'r1', type: 'regrind', tool_id: 'T1', amount: 5 },                // -> 85
  ], [
    { undo_id: 'u1', op_id: 'c1' },
  ]);

  const undo = ledger.history.find((h) => h.kind === 'undo');
  assert.equal(undo.result, 'compensated');
  assert.deepEqual(undo.blocked_by, ['r1']);

  const comp = ledger.history.find((h) => h.kind === 'compensate_op');
  assert.ok(comp, 'compensate_op must exist');
  assert.equal(comp.op_id, 'comp:u1');
  assert.equal(comp.reverses, 'c1');
  assert.equal(comp.amount, 20);

  // life as if c1 never happened: 100 + 5(regrind) = 105 -> capped? no: 100-20+5+20 = 105
  assert.equal(ledger.state().tools.T1.remaining_life, 105);
});

// ---------- acceptance 3: idempotent replay of ops and undos ----------

test('replayed op_id is NOOP; repeated undo of same op is NOOP the second time', () => {
  const ledger = runToollife(TOOLS, [
    { op_id: 'c1', type: 'cut', tool_id: 'T1', material: 'steel', units: 10 },
    { op_id: 'c1', type: 'cut', tool_id: 'T1', material: 'steel', units: 10 }, // replay
  ], [
    { undo_id: 'u1', op_id: 'c1' },
    { undo_id: 'u1', op_id: 'c1' }, // same undo_id again
    { undo_id: 'u2', op_id: 'c1' }, // different undo_id, same op
  ]);

  const ops = ledger.history.filter((h) => h.kind === 'op');
  assert.equal(ops[0].result, 'applied');
  assert.equal(ops[1].result, 'noop');
  assert.equal(ops[1].reason, 'duplicate op_id');

  const undos = ledger.history.filter((h) => h.kind === 'undo');
  assert.equal(undos[0].result, 'applied');
  assert.equal(undos[1].result, 'noop');
  assert.equal(undos[1].reason, 'duplicate undo_id');
  assert.equal(undos[2].result, 'noop');
  assert.equal(undos[2].reason, 'op already undone or compensated');

  // exactly one reversal happened
  assert.equal(ledger.state().tools.T1.remaining_life, 100);
});

test('compensation cannot be applied twice for the same op', () => {
  const ledger = runToollife(TOOLS, [
    { op_id: 'c1', type: 'cut', tool_id: 'T1', material: 'steel', units: 10 },
    { op_id: 'c2', type: 'cut', tool_id: 'T1', material: 'steel', units: 10 },
  ], [
    { undo_id: 'u1', op_id: 'c1' }, // compensated (c2 blocks)
    { undo_id: 'u2', op_id: 'c1' }, // already compensated -> noop
  ]);
  const undos = ledger.history.filter((h) => h.kind === 'undo');
  assert.equal(undos[0].result, 'compensated');
  assert.equal(undos[1].result, 'noop');
  const comps = ledger.history.filter((h) => h.kind === 'compensate_op');
  assert.equal(comps.length, 1);
  assert.equal(ledger.state().tools.T1.remaining_life, 80); // 100 - 20 (c2 only)
});

// ---------- acceptance 4: OVERUSE forces, then blocks ----------

test('cut driving life negative is forced with OVERUSE; further cut blocked until regrind or setup', () => {
  const ledger = new Ledger(TOOLS);
  ledger.applyOperation({ op_id: 'c1', type: 'cut', tool_id: 'T2', material: 'steel', units: 9 });  // 50-45=5
  const forced = ledger.applyOperation({ op_id: 'c2', type: 'cut', tool_id: 'T2', material: 'steel', units: 2 }); // 5-10=-5
  assert.equal(forced.result, 'applied');
  assert.equal(forced.flag, 'OVERUSE');
  assert.equal(ledger.state().tools.T2.status, 'OVERUSE');
  assert.equal(ledger.state().tools.T2.remaining_life, -5);

  const blocked = ledger.applyOperation({ op_id: 'c3', type: 'cut', tool_id: 'T2', material: 'steel', units: 1 });
  assert.equal(blocked.result, 'rejected');
  assert.match(blocked.reason, /OVERUSE/);
  assert.equal(ledger.state().tools.T2.remaining_life, -5); // unchanged

  // regrind not enough to recover -> still blocked
  ledger.applyOperation({ op_id: 'r1', type: 'regrind', tool_id: 'T2', amount: 3 }); // -2
  const stillBlocked = ledger.applyOperation({ op_id: 'c4', type: 'cut', tool_id: 'T2', material: 'steel', units: 1 });
  assert.equal(stillBlocked.result, 'rejected');

  // regrind past zero -> cut allowed again
  ledger.applyOperation({ op_id: 'r2', type: 'regrind', tool_id: 'T2', amount: 10 }); // 8
  const ok = ledger.applyOperation({ op_id: 'c5', type: 'cut', tool_id: 'T2', material: 'steel', units: 1 });
  assert.equal(ok.result, 'applied');
  assert.equal(ledger.state().tools.T2.remaining_life, 3);
});

test('setup (replace) resets an OVERUSE tool to full life', () => {
  const ledger = new Ledger(TOOLS);
  ledger.applyOperation({ op_id: 'c1', type: 'cut', tool_id: 'T2', material: 'steel', units: 11 }); // -5 OVERUSE
  assert.equal(ledger.state().tools.T2.status, 'OVERUSE');
  ledger.applyOperation({ op_id: 's1', type: 'setup', tool_id: 'T2' });
  assert.equal(ledger.state().tools.T2.remaining_life, 50);
  assert.equal(ledger.state().tools.T2.status, 'OK');
  const ok = ledger.applyOperation({ op_id: 'c2', type: 'cut', tool_id: 'T2', material: 'steel', units: 1 });
  assert.equal(ok.result, 'applied');
});

// ---------- regrind cap & material coefficient ----------

test('regrind never exceeds max_life; cut uses per-material coefficient', () => {
  const ledger = new Ledger(TOOLS);
  ledger.applyOperation({ op_id: 'c1', type: 'cut', tool_id: 'T1', material: 'steel', units: 10 });    // -20
  ledger.applyOperation({ op_id: 'c2', type: 'cut', tool_id: 'T1', material: 'aluminum', units: 10 }); // -10
  assert.equal(ledger.state().tools.T1.remaining_life, 70);
  const reg = ledger.applyOperation({ op_id: 'r1', type: 'regrind', tool_id: 'T1', amount: 999 });
  assert.equal(reg.restored, 30);
  assert.equal(ledger.state().tools.T1.remaining_life, 100);
});

// ---------- errors ----------

test('unknown tool raises ToolLifeError with code 2', () => {
  const ledger = new Ledger(TOOLS);
  assert.throws(
    () => ledger.applyOperation({ op_id: 'x', type: 'cut', tool_id: 'NOPE', material: 'steel' }),
    (err) => err instanceof ToolLifeError && err.code === 2,
  );
});

// ---------- CLI end-to-end ----------

function writeInputs(dir, { tools, operations, undos }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tools.json'), JSON.stringify(tools));
  fs.writeFileSync(path.join(dir, 'operations.jsonl'), operations.map((o) => JSON.stringify(o)).join('\n') + '\n');
  if (undos) {
    fs.writeFileSync(path.join(dir, 'undo.jsonl'), undos.map((u) => JSON.stringify(u)).join('\n') + '\n');
  }
}

const CLI = path.join(__dirname, '..', 'cli.js');

test('CLI: happy path writes tools_state.json and history.jsonl', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'toollife-'));
  const inDir = path.join(tmp, 'in');
  const outDir = path.join(tmp, 'out');
  writeInputs(inDir, {
    tools: TOOLS,
    operations: [
      { op_id: 'c1', type: 'cut', tool_id: 'T1', material: 'steel', units: 10 },
      { op_id: 'c2', type: 'cut', tool_id: 'T1', material: 'aluminum', units: 5 },
    ],
    undos: [{ undo_id: 'u1', op_id: 'c2' }],
  });

  const res = spawnSync(process.execPath, [CLI, 'toollife', '--in', inDir, '--out', outDir], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);

  const state = JSON.parse(fs.readFileSync(path.join(outDir, 'tools_state.json'), 'utf8'));
  assert.equal(state.tools.T1.remaining_life, 80);
  assert.equal(state.tools.T1.status, 'OK');
  assert.equal(state.tools.T2.remaining_life, 50);

  const history = fs.readFileSync(path.join(outDir, 'history.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((h) => h.seq), [1, 2, 3]);
  assert.equal(history[2].kind, 'undo');
  assert.equal(history[2].result, 'applied');
});

test('CLI: unknown tool exits with code 2', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'toollife-'));
  const inDir = path.join(tmp, 'in');
  const outDir = path.join(tmp, 'out');
  writeInputs(inDir, {
    tools: TOOLS,
    operations: [{ op_id: 'c1', type: 'cut', tool_id: 'GHOST', material: 'steel', units: 1 }],
  });

  const res = spawnSync(process.execPath, [CLI, 'toollife', '--in', inDir, '--out', outDir], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown tool: GHOST/);
  assert.ok(!fs.existsSync(path.join(outDir, 'tools_state.json')), 'no state written on fatal input error');
});
