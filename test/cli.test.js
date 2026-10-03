import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function run(args) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const VALID = `
recipe "cli-sample";
ingredient corn { cost 3.2 CNY/kg; stock 10 kg; allergen 1; protein 90000 ppm; }
ingredient soy { cost 4.8 CNY/kg; stock 5 kg; allergen 3; protein 400000 ppm; }
total 1 kg;
step 100 g;
budget 5 CNY;
constraint corn.protein * corn.grams + soy.protein * soy.grams >= 200000 ppm * (corn.grams + soy.grams);
minimize corn.grams * corn.cost + soy.grams * soy.cost;
`;

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'recipe-cli-'));
  return fn(dir);
}

test('optimize writes a plan with grams, cost, margins and certificate; exit 0', () => {
  withTemp((dir) => {
    const dsl = join(dir, 'r.dsl');
    const out = join(dir, 'plan.json');
    writeFileSync(dsl, VALID);
    const r = run(['optimize', dsl, '--json', out]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(out));
    const plan = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(plan.status, 'OPTIMAL');
    assert.deepEqual(plan.ingredients.map((i) => [i.name, i.grams]), [['corn', 600], ['soy', 400]]);
    assert.equal(plan.cost, '3.84');
    assert.equal(plan.total_grams, 1000);
    assert.equal(plan.constraints.length, 1);
    assert.equal(plan.constraints[0].margin, '14');
    assert.match(plan.certificate, /^[0-9a-f]{64}$/);
  });
});

test('certificate is deterministic across runs', () => {
  withTemp((dir) => {
    const dsl = join(dir, 'r.dsl');
    writeFileSync(dsl, VALID);
    const a = run(['optimize', dsl, '--json', join(dir, 'a.json')]);
    const b = run(['optimize', dsl, '--json', join(dir, 'b.json')]);
    const pa = JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8'));
    const pb = JSON.parse(readFileSync(join(dir, 'b.json'), 'utf8'));
    assert.equal(pa.certificate, pb.certificate);
    assert.equal(a.code, 0);
    assert.equal(b.code, 0);
  });
});

test('verify accepts a genuine plan; exit 0', () => {
  withTemp((dir) => {
    const dsl = join(dir, 'r.dsl');
    const out = join(dir, 'plan.json');
    writeFileSync(dsl, VALID);
    run(['optimize', dsl, '--json', out]);
    const r = run(['verify', out]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /OK/);
  });
});

test('verify rejects a tampered plan; exit 1', () => {
  withTemp((dir) => {
    const dsl = join(dir, 'r.dsl');
    const out = join(dir, 'plan.json');
    writeFileSync(dsl, VALID);
    run(['optimize', dsl, '--json', out]);
    const plan = JSON.parse(readFileSync(out, 'utf8'));
    plan.ingredients[0].grams = 700;
    writeFileSync(out, JSON.stringify(plan, null, 2));
    const r = run(['verify', out]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /certificate mismatch/);
  });
});

test('optimize reports INFEASIBLE on stdout; exit 1', () => {
  withTemp((dir) => {
    const dsl = join(dir, 'r.dsl');
    writeFileSync(dsl, `ingredient a { cost 1 CNY/kg; stock 10 g; }\ntotal 1 kg;\nminimize a.grams * a.cost;\n`);
    const r = run(['optimize', dsl]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /"INFEASIBLE"/);
  });
});

test('optimize reports OVER_BUDGET with min cost and budget; exit 1', () => {
  withTemp((dir) => {
    const dsl = join(dir, 'r.dsl');
    writeFileSync(dsl, `ingredient a { cost 2 CNY/kg; stock 1 kg; }\ntotal 100 g;\nbudget 0.19 CNY;\nminimize a.grams * a.cost;\n`);
    const r = run(['optimize', dsl]);
    assert.equal(r.code, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.status, 'OVER_BUDGET');
    assert.equal(out.min_cost, '0.2');
    assert.equal(out.budget, '0.19');
  });
});

test('diagnostics carry file:line:col and exit 2', () => {
  withTemp((dir) => {
    const dsl = join(dir, 'bad.dsl');
    writeFileSync(dsl, `ingredient a { cost 1 CNY/kg; stock 1 kg; }\ntotal 1 kg + 3 ppm;\nminimize a.grams * a.cost;\n`);
    const r = run(['optimize', dsl]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /bad\.dsl:2:12: error: dimension mismatch/);
  });
});

test('macro cycle through the CLI exits 2 with the cycle in the message', () => {
  withTemp((dir) => {
    const dsl = join(dir, 'cycle.dsl');
    writeFileSync(dsl, `ingredient a { cost 1 CNY/kg; stock 1 kg; }\nmacro x = y;\nmacro y = x;\ntotal 1 kg;\nconstraint a.grams >= x * 1 g;\nminimize a.grams * a.cost;\n`);
    const r = run(['optimize', dsl]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /cycle\.dsl:5:23: error: macro expansion cycle detected: x -> y -> x/);
  });
});

test('undeclared ingredient through the CLI exits 2', () => {
  withTemp((dir) => {
    const dsl = join(dir, 'ghost.dsl');
    writeFileSync(dsl, `ingredient a { cost 1 CNY/kg; stock 1 kg; }\ntotal 1 kg;\nconstraint ghost.grams >= 1 g;\nminimize a.grams * a.cost;\n`);
    const r = run(['optimize', dsl]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /ghost\.dsl:3:12: error: undeclared ingredient 'ghost'/);
  });
});

test('missing input file is a diagnostic; exit 2', () => {
  const r = run(['optimize', '/nonexistent/recipe.dsl']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cannot read file/);
});

test('verify on malformed JSON exits 2', () => {
  withTemp((dir) => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    const r = run(['verify', bad]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /invalid JSON/);
  });
});
