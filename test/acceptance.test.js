'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { RecipeEngine } = require('../src/engine');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const RESULTS = path.join(ROOT, 'test-results.txt');

fs.writeFileSync(
  RESULTS,
  [
    'test-results.txt',
    'Real stdout / stderr / exit codes captured from acceptance CLI runs.',
    `generated-at: ${new Date().toISOString()}`,
    `node: ${process.version}`,
    `cwd: ${ROOT}`,
    '',
  ].join('\n')
);

function record(label, cmdLine, res, extraFile) {
  const parts = [
    `===== ${label} =====`,
    `$ ${cmdLine}`,
    `exitCode: ${res.status}`,
    '--- stdout ---',
    res.stdout === '' ? '(empty)' : res.stdout.replace(/\n$/, ''),
    '--- stderr ---',
    res.stderr === '' ? '(empty)' : res.stderr.replace(/\n$/, ''),
  ];
  if (extraFile && fs.existsSync(extraFile)) {
    parts.push(`--- ${path.basename(extraFile)} ---`, fs.readFileSync(extraFile, 'utf8').replace(/\n$/, ''));
  }
  fs.appendFileSync(RESULTS, `${parts.join('\n')}\n\n`);
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-accept-'));
}

// ---------------------------------------------------------------------------
// Independent reference implementation: naive full fixed-point evaluation.
// Shares no code with src/engine.js; used to cross-check every engine step.
// ---------------------------------------------------------------------------

function refTokens(src) {
  const tokens = [];
  const re = /(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_.]*)|(\S)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[1] !== undefined) tokens.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ t: 'id', v: m[2] });
    else tokens.push({ t: 'sym', v: m[3] });
  }
  return tokens;
}

function refEval(src, lookup) {
  const tokens = refTokens(src);
  let pos = 0;
  function parseExpr() {
    let v = parseTerm();
    while (pos < tokens.length && (tokens[pos].v === '+' || tokens[pos].v === '-')) {
      const op = tokens[pos].v;
      pos += 1;
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function parseTerm() {
    let v = parseFactor();
    while (pos < tokens.length && (tokens[pos].v === '*' || tokens[pos].v === '/')) {
      const op = tokens[pos].v;
      pos += 1;
      const r = parseFactor();
      if (op === '/') {
        if (r === 0) {
          const e = new Error('division by zero');
          e.code = 'DIV_ZERO';
          throw e;
        }
        v /= r;
      } else {
        v *= r;
      }
    }
    return v;
  }
  function parseFactor() {
    const tk = tokens[pos];
    if (tk.v === '-') {
      pos += 1;
      return -parseFactor();
    }
    if (tk.v === '+') {
      pos += 1;
      return parseFactor();
    }
    if (tk.v === '(') {
      pos += 1;
      const v = parseExpr();
      if (tokens[pos].v !== ')') throw new Error('syntax');
      pos += 1;
      return v;
    }
    if (tk.t === 'num') {
      pos += 1;
      return tk.v;
    }
    if (tk.t === 'id') {
      pos += 1;
      const v = lookup(tk.v);
      if (v === undefined || v === null) throw new Error(`unknown ref ${tk.v}`);
      return v;
    }
    throw new Error('syntax');
  }
  const v = parseExpr();
  if (pos !== tokens.length) throw new Error('trailing tokens');
  return v;
}

function refDeps(defs, name) {
  if (defs[name].kind !== 'formula') return [];
  return refTokens(defs[name].expr)
    .filter((t) => t.t === 'id')
    .map((t) => t.v);
}

function referenceState(defs) {
  const names = Object.keys(defs);
  const depsOf = (n) => (defs[n] ? refDeps(defs, n).filter((d) => defs[d] !== undefined) : []);
  const cyclic = new Set();
  for (const n of names) {
    const stack = [...depsOf(n)];
    const seen = new Set();
    while (stack.length > 0) {
      const c = stack.pop();
      if (c === n) {
        cyclic.add(n);
        break;
      }
      if (!seen.has(c)) {
        seen.add(c);
        stack.push(...depsOf(c));
      }
    }
  }
  const values = {};
  const invalid = {};
  for (const n of cyclic) invalid[n] = 'cycle';
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of names) {
      if (invalid[n] !== undefined || values[n] !== undefined) continue;
      const def = defs[n];
      if (def.kind === 'const') {
        values[n] = def.value;
        changed = true;
        continue;
      }
      const deps = refDeps(defs, n);
      if (deps.some((d) => defs[d] === undefined)) {
        invalid[n] = 'unknown-dependency';
        changed = true;
        continue;
      }
      if (deps.some((d) => invalid[d] !== undefined)) {
        invalid[n] = 'invalid-upstream';
        changed = true;
        continue;
      }
      if (deps.every((d) => values[d] !== undefined)) {
        try {
          const v = refEval(def.expr, (x) => values[x]);
          if (!Number.isFinite(v)) invalid[n] = 'non-finite-result';
          else values[n] = v;
        } catch (e) {
          if (e && e.code === 'DIV_ZERO') invalid[n] = 'division-by-zero';
          else throw e;
        }
        changed = true;
      }
    }
  }
  return { values, invalid };
}

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function makeModel() {
  return { defs: {}, undo: [], redo: [] };
}

function modelApply(model, cmd) {
  if (cmd.op === 'upsert') {
    model.undo.push(clone(model.defs));
    model.redo = [];
    model.defs[cmd.name] =
      cmd.type === 'const' ? { kind: 'const', value: cmd.value } : { kind: 'formula', expr: cmd.expr };
  } else if (cmd.op === 'set') {
    model.undo.push(clone(model.defs));
    model.redo = [];
    model.defs[cmd.name] = { kind: 'const', value: cmd.value };
  } else if (cmd.op === 'remove') {
    if (model.defs[cmd.name] === undefined) return;
    model.undo.push(clone(model.defs));
    model.redo = [];
    delete model.defs[cmd.name];
  } else if (cmd.op === 'undo') {
    if (model.undo.length === 0) return;
    model.redo.push(clone(model.defs));
    model.defs = model.undo.pop();
  } else if (cmd.op === 'redo') {
    if (model.redo.length === 0) return;
    model.undo.push(clone(model.defs));
    model.defs = model.redo.pop();
  }
}

function assertMatchesReference(engine, defs, ctx) {
  const ref = referenceState(defs);
  const st = engine.finalState();
  assert.deepEqual(
    Object.keys(st.invalid).sort(),
    Object.keys(ref.invalid).sort(),
    `${ctx}: invalid tag sets differ`
  );
  for (const n of Object.keys(defs)) {
    if (ref.invalid[n] !== undefined) {
      assert.equal(st.invalid[n], ref.invalid[n], `${ctx}: invalid reason for ${n}`);
      assert.equal(st.values[n], null, `${ctx}: invalid tag ${n} must have null value`);
    } else {
      assert.equal(st.invalid[n], undefined, `${ctx}: ${n} should be valid`);
      assert.equal(st.values[n], ref.values[n], `${ctx}: value for ${n}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario A: multi-level recipe, randomised but deterministic; every step is
// cross-checked against the independent fixed-point reference, and the whole
// command stream is replayed through the real CLI.
// ---------------------------------------------------------------------------

test('A: multi-level updates match independent fixed-point reference (engine + CLI)', () => {
  let seed = 20261004;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  const constNames = [];
  const formulaNames = [];
  for (let i = 0; i < 25; i += 1) constNames.push(`c${i}`);
  for (let i = 0; i < 35; i += 1) formulaNames.push(`f${i}`);

  const upserts = [];
  for (const n of constNames) {
    upserts.push({ op: 'upsert', name: n, type: 'const', value: Math.floor(rnd() * 21) - 10 });
  }
  for (let i = 0; i < formulaNames.length; i += 1) {
    const pool = [...constNames, ...formulaNames.slice(0, i)];
    const d1 = pool[Math.floor(rnd() * pool.length)];
    const d2 = pool[Math.floor(rnd() * pool.length)];
    const op = ['+', '-', '*', '/'][Math.floor(rnd() * 4)];
    const k = Math.floor(rnd() * 5) + 1;
    const expr = rnd() < 0.5 ? `${d1} ${op} ${d2} + ${k}` : `(${d1} + ${k}) ${op} ${d2}`;
    upserts.push({ op: 'upsert', name: formulaNames[i], type: 'formula', expr });
  }
  for (let i = upserts.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [upserts[i], upserts[j]] = [upserts[j], upserts[i]];
  }

  const commands = [...upserts];
  for (let i = 0; i < 20; i += 1) {
    commands.push({
      op: 'set',
      name: constNames[Math.floor(rnd() * constNames.length)],
      value: Math.floor(rnd() * 41) - 20,
    });
  }
  for (let i = 0; i < 3; i += 1) {
    commands.push({ op: 'remove', name: constNames[Math.floor(rnd() * constNames.length)] });
  }
  commands.push({ op: 'undo' }, { op: 'undo' }, { op: 'undo' }, { op: 'undo' });
  commands.push({ op: 'redo' }, { op: 'redo' });
  commands.push({ op: 'commit' });

  const engine = new RecipeEngine();
  const model = makeModel();
  commands.forEach((cmd, idx) => {
    engine.execute(cmd);
    modelApply(model, cmd);
    assertMatchesReference(engine, model.defs, `step ${idx} (${cmd.op} ${cmd.name || ''})`);
  });

  const dir = tmpdir();
  const input = path.join(dir, 'commands.json');
  const output = path.join(dir, 'result.json');
  fs.writeFileSync(input, JSON.stringify({ commands }, null, 2));
  const res = runCli(['run', input, '-o', output]);
  record('scenario A: multi-level recipe vs reference (CLI run)', `node src/cli.js run ${input} -o ${output}`, res, output);

  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '');
  const result = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(result.versions.length, commands.length);
  result.versions.forEach((v, i) => {
    assert.equal(v.version, i + 1);
    assert.equal(v.certificate.seq, i + 1);
    assert.match(v.certificate.hash, /^[0-9a-f]{64}$/);
  });
  const finalEngine = engine.finalState();
  assert.deepEqual(result.final.values, finalEngine.values);
  assert.deepEqual(result.final.invalid, finalEngine.invalid);
  assert.equal(result.final.certificate.hash, finalEngine.certificate.hash);
});

// ---------------------------------------------------------------------------
// Scenario B: create a cycle -> downstream goes invalid; break the cycle ->
// recovery; undo restores the old (cyclic) topology; redo recovers again.
// An independent branch must never be polluted.
// ---------------------------------------------------------------------------

test('B: cycle invalidates downstream, breaking recovers, undo restores old topology', () => {
  const commands = [
    { op: 'upsert', name: 'iso', type: 'const', value: 7 },
    { op: 'upsert', name: 'iso2', type: 'formula', expr: 'iso * 3' },
    { op: 'upsert', name: 'a', type: 'const', value: 1 },
    { op: 'upsert', name: 'p', type: 'formula', expr: 'a + 1' },
    { op: 'upsert', name: 'q', type: 'formula', expr: 'p + 1' },
    { op: 'upsert', name: 'r', type: 'formula', expr: 'p * 2' },
    { op: 'upsert', name: 'a', type: 'formula', expr: 'q + 1' },
    { op: 'upsert', name: 'p', type: 'const', value: 5 },
    { op: 'undo' },
    { op: 'redo' },
    { op: 'commit' },
  ];

  const dir = tmpdir();
  const input = path.join(dir, 'commands.json');
  const output = path.join(dir, 'result.json');
  fs.writeFileSync(input, JSON.stringify({ commands }, null, 2));
  const res = runCli(['run', input, '-o', output]);
  record('scenario B: cycle / break / undo / redo (CLI run)', `node src/cli.js run ${input} -o ${output}`, res, output);

  assert.equal(res.status, 0, res.stderr);
  const result = JSON.parse(fs.readFileSync(output, 'utf8'));
  const v = result.versions;

  const cyclic = v[6];
  assert.deepEqual(cyclic.invalid, { a: 'cycle', p: 'cycle', q: 'cycle', r: 'invalid-upstream' });
  assert.equal(cyclic.values.iso, 7);
  assert.equal(cyclic.values.iso2, 21);
  assert.ok(!cyclic.recomputed.includes('iso'), 'independent branch must not be recomputed');
  assert.ok(!cyclic.recomputed.includes('iso2'), 'independent branch must not be recomputed');

  const broken = v[7];
  assert.deepEqual(broken.invalid, {});
  assert.deepEqual(broken.values, { a: 7, iso: 7, iso2: 21, p: 5, q: 6, r: 10 });
  assert.deepEqual(broken.diff.validated, ['a', 'p', 'q', 'r']);

  const undone = v[8];
  assert.deepEqual(undone.invalid, { a: 'cycle', p: 'cycle', q: 'cycle', r: 'invalid-upstream' });
  assert.deepEqual(undone.diff.invalidated, ['a', 'p', 'q', 'r']);

  const redone = v[9];
  assert.deepEqual(redone.invalid, {});
  assert.deepEqual(redone.values, { a: 7, iso: 7, iso2: 21, p: 5, q: 6, r: 10 });

  assert.equal(v[10].committed, true);
  assert.equal(result.final.committed, true);

  const engine = new RecipeEngine();
  const model = makeModel();
  commands.forEach((cmd, idx) => {
    engine.execute(cmd);
    modelApply(model, cmd);
    assertMatchesReference(engine, model.defs, `scenario B step ${idx}`);
  });
});

// ---------------------------------------------------------------------------
// Scenario C: parallel (diamond) dependencies and division-by-zero boundary,
// including 0/0, recovery by changing the denominator, and an unpolluted
// parallel branch.
// ---------------------------------------------------------------------------

test('C: diamond dependencies and division-by-zero boundary', () => {
  const commands = [
    { op: 'upsert', name: 'm', type: 'const', value: 8 },
    { op: 'upsert', name: 'b', type: 'formula', expr: 'm / 2' },
    { op: 'upsert', name: 'c', type: 'formula', expr: 'm - 2' },
    { op: 'upsert', name: 'd', type: 'formula', expr: 'b + c' },
    { op: 'upsert', name: 'e', type: 'formula', expr: 'd / b' },
    { op: 'upsert', name: 'z', type: 'formula', expr: 'b / (c - 6)' },
    { op: 'upsert', name: 'y', type: 'formula', expr: 'z + 1' },
    { op: 'upsert', name: 'zero', type: 'const', value: 0 },
    { op: 'upsert', name: 'zz', type: 'formula', expr: 'zero / zero' },
    { op: 'set', name: 'm', value: 10 },
    { op: 'set', name: 'zero', value: 4 },
  ];

  const dir = tmpdir();
  const input = path.join(dir, 'commands.json');
  fs.writeFileSync(input, JSON.stringify({ commands }, null, 2));
  const res = runCli(['run', input]);
  record('scenario C: diamond + division by zero (CLI run, stdout mode)', `node src/cli.js run ${input}`, res, null);

  assert.equal(res.status, 0, res.stderr);
  const result = JSON.parse(res.stdout);
  const v = result.versions;

  assert.deepEqual(v[3].values, { b: 4, c: 6, d: 10, m: 8 });
  assert.deepEqual(v[4].values.e, 2.5);

  const div0 = v[5];
  assert.equal(div0.invalid.z, 'division-by-zero');
  assert.equal(div0.values.b, 4);
  assert.equal(div0.values.e, 2.5);

  const downstream = v[6];
  assert.equal(downstream.invalid.y, 'invalid-upstream');
  assert.equal(downstream.values.e, 2.5);

  const zeroOverZero = v[8];
  assert.equal(zeroOverZero.invalid.zz, 'division-by-zero');

  const recovered = v[9];
  assert.equal(recovered.invalid.z, undefined);
  assert.equal(recovered.invalid.y, undefined);
  assert.equal(recovered.values.z, 2.5);
  assert.equal(recovered.values.y, 3.5);
  assert.equal(recovered.values.d, 13);
  assert.deepEqual(recovered.diff.validated, ['y', 'z']);

  const healed = v[10];
  assert.equal(healed.invalid.zz, undefined);
  assert.equal(healed.values.zz, 1);

  const engine = new RecipeEngine();
  const model = makeModel();
  commands.forEach((cmd, idx) => {
    engine.execute(cmd);
    modelApply(model, cmd);
    assertMatchesReference(engine, model.defs, `scenario C step ${idx}`);
  });
});

// ---------------------------------------------------------------------------
// Scenario D: error handling - invalid JSON and unreadable files exit 1 with
// {error, code, message}; command-level errors are isolated per version.
// ---------------------------------------------------------------------------

test('D: invalid JSON / unreadable file exit 1 with {error,code,message}', () => {
  const dir = tmpdir();

  const badJson = path.join(dir, 'bad.json');
  fs.writeFileSync(badJson, '{ "commands": [ ');
  const resBad = runCli(['run', badJson, '-o', path.join(dir, 'out.json')]);
  record('scenario D1: invalid JSON input', `node src/cli.js run ${badJson} -o out.json`, resBad, null);
  assert.equal(resBad.status, 1);
  const badBody = JSON.parse(resBad.stdout);
  assert.equal(badBody.error, true);
  assert.equal(badBody.code, 'INVALID_JSON');
  assert.equal(typeof badBody.message, 'string');
  assert.ok(!fs.existsSync(path.join(dir, 'out.json')), 'no result file on failure');

  const missing = path.join(dir, 'missing.json');
  const resMissing = runCli(['run', missing]);
  record('scenario D2: unreadable input file', `node src/cli.js run ${missing}`, resMissing, null);
  assert.equal(resMissing.status, 1);
  const missingBody = JSON.parse(resMissing.stdout);
  assert.equal(missingBody.error, true);
  assert.equal(missingBody.code, 'FILE_UNREADABLE');
  assert.equal(typeof missingBody.message, 'string');

  const mixed = path.join(dir, 'mixed.json');
  fs.writeFileSync(
    mixed,
    JSON.stringify([
      { op: 'upsert', name: 'a', type: 'const', value: 1 },
      { op: 'upsert', name: 'bad', type: 'formula', expr: '1 +' },
      { op: 'set', name: 'a', value: 2 },
      { op: 'unknown-op' },
      { op: 'remove', name: 'ghost' },
    ])
  );
  const resMixed = runCli(['run', mixed]);
  record('scenario D3: command-level errors isolated per version', `node src/cli.js run ${mixed}`, resMixed, null);
  assert.equal(resMixed.status, 0);
  const mixedResult = JSON.parse(resMixed.stdout);
  assert.deepEqual(
    mixedResult.versions.map((x) => x.status),
    ['ok', 'error', 'ok', 'error', 'noop']
  );
  assert.equal(mixedResult.versions[1].message.includes('invalid formula'), true);
  assert.equal(mixedResult.versions[3].message.includes('unknown op'), true);
  assert.deepEqual(mixedResult.final.values, { a: 2 });
});
