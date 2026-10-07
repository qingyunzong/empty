import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { interpretAll } from '../src/interpreter.js';
import { formatValue, isErr } from '../src/value.js';

/** mulberry32：确定性伪随机数发生器。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLS = 6;
const ROWS = 6;
const CELLS: string[] = [];
for (let r = 1; r <= ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    CELLS.push(String.fromCharCode(65 + c) + r);
  }
}

function genFormula(rand: () => number, depth: number): string {
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
  if (depth === 0 || rand() < 0.35) {
    if (rand() < 0.5) return String(Math.floor(rand() * 10));
    return pick(CELLS);
  }
  if (rand() < 0.2) {
    return `IF(${genFormula(rand, depth - 1)}, ${genFormula(rand, depth - 1)}, ${genFormula(rand, depth - 1)})`;
  }
  const op = pick(['+', '-', '*', '/']);
  return `${genFormula(rand, depth - 1)} ${op} ${genFormula(rand, depth - 1)}`;
}

/** 题设：引用构成 DAG。会产生环的编辑不属于对照域，跳过（环检测由单元测试覆盖）。 */
function createsCycle(formulas: Map<string, string>): boolean {
  const full = interpretAll(formulas);
  for (const v of full.values.values()) {
    if (isErr(v) && v.kind === '#CYCLE!') return true;
  }
  return false;
}

/** 把引擎与全表解释器的（值, 依赖）快照对齐成可比较的形式。 */
function snapshot(engine: Engine, formulas: Map<string, string>): string[] {
  const full = interpretAll(formulas);
  const addrs = new Set<string>([...engine.addresses(), ...full.values.keys()]);
  const rows: string[] = [];
  for (const addr of [...addrs].sort()) {
    const ev = formatValue(engine.getValue(addr));
    const fv = full.values.has(addr) ? formatValue(full.values.get(addr)!) : 'INT 0';
    const ed = engine.getDeps(addr).join(',');
    const fd = (full.deps.get(addr) ?? []).join(',');
    rows.push(`${addr}: engine=${ev} full=${fv} | deps engine=[${ed}] full=[${fd}]`);
  }
  return rows;
}

function runFuzz(seed: number, edits: number): void {
  const rand = rng(seed);
  const engine = new Engine();
  const formulas = new Map<string, string>();
  let applied = 0;
  let skippedCycles = 0;

  for (let step = 0; step < edits; step++) {
    const addr = CELLS[Math.floor(rand() * CELLS.length)];
    const clear = rand() < 0.08;
    const f = clear ? '' : genFormula(rand, 3);

    const next = new Map(formulas);
    if (clear) next.delete(addr);
    else next.set(addr, f);
    if (createsCycle(next)) {
      skippedCycles++;
      continue;
    }

    engine.setFormula(addr, f);
    formulas.clear();
    for (const [k, v] of next) formulas.set(k, v);
    applied++;

    const full = interpretAll(formulas);
    const addrs = new Set<string>([...engine.addresses(), ...full.values.keys()]);
    for (const a of addrs) {
      const ev = engine.getValue(a);
      const fv = full.values.get(a) ?? { ok: true as const, v: 0 };
      const ed = engine.getDeps(a);
      const fd = full.deps.get(a) ?? [];
      const same =
        formatValue(ev) === formatValue(fv) && ed.join(',') === fd.join(',');
      if (!same) {
        assert.fail(
          `seed=${seed} step=${step} 地址 ${a} 不一致\n` +
            snapshot(engine, formulas).join('\n'),
        );
      }
    }
  }
  assert.ok(applied > 0, '应当至少应用一次编辑');
  // 输出统计，便于了解模糊测试覆盖面。
  console.log(`seed=${seed}: 应用 ${applied} 次编辑，跳过成环编辑 ${skippedCycles} 次`);
}

test('差分模糊测试：增量引擎 vs 全表解释器（DAG 域）', () => {
  const seeds = [1, 2, 3, 42, 2024, 31337];
  for (const seed of seeds) {
    runFuzz(seed, 200);
  }
});
