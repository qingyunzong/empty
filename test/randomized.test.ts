import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
  syncImport,
  type Cell,
  type FieldResolution,
  type FieldValue,
  type MergeMode,
  type ProjectFields,
  type Snapshot,
} from "../src/index.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROJECT_POOL = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
const FIELD_POOL = ["name", "owner", "status", "priority", "budget", "active", "deadline"];
const VALUE_POOL: FieldValue[] = ["red", "blue", "ops", "dev", 0, 1, 2, 42, true, false, null];

function randOf<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function randomSnapshot(rng: () => number): Snapshot {
  const snap: Snapshot = {};
  for (const p of PROJECT_POOL) {
    if (rng() < 0.7) {
      const fields: ProjectFields = {};
      for (const f of FIELD_POOL) {
        if (rng() < 0.6) fields[f] = randOf(rng, VALUE_POOL);
      }
      snap[p] = fields;
    }
  }
  return snap;
}

function randomEdits(rng: () => number, snap: Snapshot): Snapshot {
  const out = structuredClone(snap);
  const edits = 1 + Math.floor(rng() * 6);
  for (let i = 0; i < edits; i++) {
    const p = randOf(rng, PROJECT_POOL);
    const f = randOf(rng, FIELD_POOL);
    const roll = rng();
    if (roll < 0.45) {
      (out[p] ??= {})[f] = randOf(rng, VALUE_POOL);
    } else if (roll < 0.7) {
      const fields = out[p];
      if (fields !== undefined) delete fields[f];
    } else if (roll < 0.85) {
      delete out[p];
    } else {
      out[p] ??= {};
    }
  }
  return out;
}

function randomResolutions(rng: () => number, snaps: Snapshot[]): FieldResolution[] {
  const res: FieldResolution[] = [];
  const seen = new Set<string>();
  for (const snap of snaps) {
    for (const [p, fields] of Object.entries(snap)) {
      for (const f of Object.keys(fields)) {
        const key = `${p} ${f}`;
        if (!seen.has(key) && rng() < 0.3) {
          seen.add(key);
          const pick = randOf(rng, ["source", "target", "value"] as const);
          res.push(
            pick === "value"
              ? { project: p, field: f, pick, value: randOf(rng, VALUE_POOL) }
              : { project: p, field: f, pick }
          );
        }
      }
    }
  }
  return res;
}

type OCell = { present: boolean; value?: FieldValue };

function ocell(fields: ProjectFields | undefined, key: string): OCell {
  return fields !== undefined && Object.prototype.hasOwnProperty.call(fields, key)
    ? { present: true, value: fields[key] }
    : { present: false };
}

function oeq(a: OCell, b: OCell): boolean {
  return a.present === b.present && (!a.present || a.value === b.value);
}

interface OracleOutcome {
  applied: boolean;
  unresolved: string[];
  result?: Snapshot;
  itemStatus: Map<string, string>;
  itemFinals: Map<string, Map<string, OCell>>;
  usedKeys: Set<string>;
}

function oracle(
  base: Snapshot,
  source: Snapshot,
  target: Snapshot,
  mode: MergeMode,
  resolutions: FieldResolution[]
): OracleOutcome {
  const resMap = new Map(resolutions.map((r) => [`${r.project} ${r.field}`, r]));
  const usedKeys = new Set<string>();
  const unresolved: string[] = [];
  const itemStatus = new Map<string, string>();
  const itemFinals = new Map<string, Map<string, OCell>>();

  for (const p of Object.keys(source).sort()) {
    const fieldNames = new Set([
      ...Object.keys(base[p] ?? {}),
      ...Object.keys(source[p] ?? {}),
    ]);
    const finals = new Map<string, OCell>();
    let hasUnresolved = false;
    let changed = false;
    let mergedVia = false;

    for (const f of [...fieldNames].sort()) {
      const b = ocell(base[p], f);
      const s = ocell(source[p], f);
      const t = ocell(target[p], f);
      const key = `${p} ${f}`;
      let final: OCell;
      if (oeq(s, t)) {
        final = s;
      } else if (oeq(t, b)) {
        final = s;
      } else {
        const r = resMap.get(key);
        if (r !== undefined) {
          usedKeys.add(key);
          mergedVia = true;
          final =
            r.pick === "source" ? s : r.pick === "target" ? t : { present: true, value: r.value };
        } else if (mode === "auto" && oeq(s, b)) {
          final = t;
          mergedVia = true;
        } else {
          final = { present: false };
          hasUnresolved = true;
          unresolved.push(key);
        }
      }
      finals.set(f, final);
      if (!hasUnresolved && !oeq(final, b)) changed = true;
    }

    itemFinals.set(p, finals);
    itemStatus.set(
      p,
      hasUnresolved
        ? "conflict"
        : !Object.prototype.hasOwnProperty.call(base, p)
          ? "added"
          : mergedVia
            ? "merged"
            : changed
              ? "updated"
              : "unchanged"
    );
  }

  const applied = unresolved.length === 0;
  let result: Snapshot | undefined;
  if (applied) {
    result = structuredClone(target);
    for (const [p, finals] of itemFinals) {
      for (const [f, cell] of finals) {
        if (cell.present) {
          (result[p] ??= {})[f] = cell.value ?? null;
        } else {
          const fields = result[p];
          if (fields !== undefined) delete fields[f];
        }
      }
    }
  }
  return { applied, unresolved, result, itemStatus, itemFinals, usedKeys };
}

function cellOf(c: Cell): OCell {
  return c.present ? { present: true, value: c.value } : { present: false };
}

const ITERATIONS = 300;

describe("随机编辑对照独立规则", () => {
  for (const mode of ["strict", "auto"] as const) {
    test(`模式 ${mode}: ${ITERATIONS} 轮随机快照/编辑/决议与独立规则一致`, () => {
      for (let seed = 1; seed <= ITERATIONS; seed++) {
        const rng = mulberry32(seed * 7919 + (mode === "auto" ? 1 : 0));
        const base = randomSnapshot(rng);
        const source = randomEdits(rng, base);
        const target = randomEdits(rng, base);
        const resolutions = randomResolutions(rng, [base, source, target]);

        const report = syncImport(base, source, target, { mode, resolutions });
        const expected = oracle(base, source, target, mode, resolutions);
        const ctx = `seed=${seed} mode=${mode}`;

        assert.equal(report.applied, expected.applied, `applied 不一致 ${ctx}`);
        assert.deepEqual(
          report.unresolvedConflicts.map((c) => `${c.project} ${c.field}`).sort(),
          [...expected.unresolved].sort(),
          `未解冲突集合不一致 ${ctx}`
        );
        assert.deepEqual(report.result, expected.result, `合并结果不一致 ${ctx}`);
        assert.deepEqual(
          report.unusedResolutions.map((r) => `${r.project} ${r.field}`).sort(),
          resolutions
            .filter((r) => !expected.usedKeys.has(`${r.project} ${r.field}`))
            .map((r) => `${r.project} ${r.field}`)
            .sort(),
          `未使用决议不一致 ${ctx}`
        );

        for (const item of report.items) {
          assert.equal(item.status, expected.itemStatus.get(item.project), `项目状态不一致 ${ctx} ${item.project}`);
          const finals = expected.itemFinals.get(item.project)!;
          for (const d of item.decisions) {
            assert.deepEqual(cellOf(d.final), finals.get(d.field), `字段终值不一致 ${ctx} ${item.project}.${d.field}`);
          }
        }

        if (!report.applied) {
          assert.equal(report.result, undefined, `未应用批次不得产出结果 ${ctx}`);
          assert.ok(report.unresolvedConflicts.length > 0, `未应用必须有未解冲突 ${ctx}`);
        }
        if (report.applied && report.result !== undefined) {
          for (const p of Object.keys(target)) {
            if (!Object.prototype.hasOwnProperty.call(source, p)) {
              assert.deepEqual(report.result[p], target[p], `源外项目必须保留 ${ctx} ${p}`);
            }
          }
          for (const [p, fields] of Object.entries(source)) {
            for (const [f, v] of Object.entries(fields)) {
              const b = ocell(base[p], f);
              const t = ocell(target[p], f);
              if (oeq(t, b)) {
                assert.deepEqual(
                  report.result[p]?.[f],
                  v,
                  `目标未改动的字段必须采用源值 ${ctx} ${p}.${f}`
                );
              }
            }
          }
        }
      }
    });
  }

  test("补齐全部未解冲突的决议后批次必然应用", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const rng = mulberry32(seed * 31337);
      const base = randomSnapshot(rng);
      const source = randomEdits(rng, base);
      const target = randomEdits(rng, base);

      const first = syncImport(base, source, target, { mode: "strict" });
      const fixes: FieldResolution[] = first.unresolvedConflicts.map((c) => ({
        project: c.project,
        field: c.field,
        pick: "target",
      }));
      const second = syncImport(base, source, target, { mode: "strict", resolutions: fixes });
      assert.equal(second.applied, true, `seed=${seed} 补齐决议后必须应用`);
      assert.deepEqual(second.unresolvedConflicts, []);
    }
  });

  test("目标等于基线时任何源快照都整批应用且无冲突", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const rng = mulberry32(seed * 104729);
      const base = randomSnapshot(rng);
      const source = randomEdits(rng, base);
      const report = syncImport(base, source, structuredClone(base), { mode: "strict" });
      assert.equal(report.applied, true, `seed=${seed}`);
      assert.equal(report.targetDiverged, false);
      assert.deepEqual(report.unresolvedConflicts, []);
    }
  });
});
