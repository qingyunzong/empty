import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
  formatReport,
  syncImport,
  type Snapshot,
} from "../src/index.js";

const base: Snapshot = {
  alpha: { name: "Alpha", status: "open", priority: 1 },
  beta: { owner: "lin", active: true },
};

describe("干净导入（目标未偏离基线）", () => {
  test("目标等于基线时整批应用，源改动全部导入", () => {
    const source: Snapshot = {
      alpha: { name: "Alpha-2", status: "open", priority: 2 },
      beta: { owner: "lin", active: true },
      gamma: { name: "Gamma" },
    };
    const target = structuredClone(base);
    const report = syncImport(base, source, target);

    assert.equal(report.applied, true);
    assert.equal(report.targetDiverged, false);
    assert.deepEqual(report.unresolvedConflicts, []);
    assert.deepEqual(report.result, {
      alpha: { name: "Alpha-2", status: "open", priority: 2 },
      beta: { owner: "lin", active: true },
      gamma: { name: "Gamma" },
    });
    const gamma = report.items.find((i) => i.project === "gamma");
    assert.equal(gamma?.status, "added");
    assert.equal(report.summary.added, 1);
    assert.equal(report.summary.updated, 1);
    assert.equal(report.summary.unchanged, 1);
  });

  test("源删除字段会传播删除；源快照之外的目标项目保持不动", () => {
    const source: Snapshot = {
      alpha: { name: "Alpha", status: "open" },
    };
    const target = structuredClone(base);
    const report = syncImport(base, source, target);

    assert.equal(report.applied, true);
    assert.deepEqual(report.result, {
      alpha: { name: "Alpha", status: "open" },
      beta: { owner: "lin", active: true },
    });
    const decision = report.items[0]?.decisions.find((d) => d.field === "priority");
    assert.equal(decision?.action, "take-source");
    assert.equal(decision?.final.present, false);
  });
});

describe("严格模式：目标改动导致全批冲突", () => {
  const source: Snapshot = {
    alpha: { name: "Alpha-2", status: "open", priority: 1 },
    beta: { owner: "lin", active: true },
  };

  test("单个字段的本地改动使整批不应用，其他项目不被部分覆盖", () => {
    const target = structuredClone(base);
    target["beta"]!["owner"] = "local-edit";
    const report = syncImport(base, source, target);

    assert.equal(report.targetDiverged, true);
    assert.equal(report.applied, false);
    assert.equal(report.result, undefined);
    assert.deepEqual(
      report.unresolvedConflicts.map((c) => `${c.project}.${c.field}`),
      ["beta.owner"]
    );
    const beta = report.items.find((i) => i.project === "beta");
    assert.equal(beta?.status, "conflict");
    assert.deepEqual(beta?.unresolved, ["owner"]);
  });

  test("源未改动的字段被目标本地修改时同样需要显式决议", () => {
    const target = structuredClone(base);
    target["alpha"]!["status"] = "done";
    const report = syncImport(base, source, target);

    assert.equal(report.applied, false);
    assert.deepEqual(
      report.unresolvedConflicts.map((c) => `${c.project}.${c.field}`),
      ["alpha.status"]
    );
  });

  test("显式决议 pick=target 保留本地修改后整批应用", () => {
    const target = structuredClone(base);
    target["beta"]!["owner"] = "local-edit";
    const report = syncImport(base, source, target, {
      resolutions: [{ project: "beta", field: "owner", pick: "target" }],
    });

    assert.equal(report.applied, true);
    assert.deepEqual(report.result, {
      alpha: { name: "Alpha-2", status: "open", priority: 1 },
      beta: { owner: "local-edit", active: true },
    });
    const beta = report.items.find((i) => i.project === "beta");
    assert.equal(beta?.status, "merged");
    const decision = beta?.decisions.find((d) => d.field === "owner");
    assert.equal(decision?.action, "resolved-target");
  });

  test("显式决议 pick=source 用源值覆盖本地修改", () => {
    const target = structuredClone(base);
    target["beta"]!["owner"] = "local-edit";
    const report = syncImport(base, source, target, {
      resolutions: [{ project: "beta", field: "owner", pick: "source" }],
    });

    assert.equal(report.applied, true);
    assert.equal(report.result?.["beta"]?.["owner"], "lin");
  });

  test("显式决议 pick=value 采用指定值", () => {
    const target = structuredClone(base);
    target["beta"]!["owner"] = "local-edit";
    const report = syncImport(base, source, target, {
      resolutions: [{ project: "beta", field: "owner", pick: "value", value: "merged-owner" }],
    });

    assert.equal(report.applied, true);
    assert.equal(report.result?.["beta"]?.["owner"], "merged-owner");
  });

  test("源与目标改为一致时不构成冲突", () => {
    const source2 = structuredClone(source);
    source2["beta"]!["owner"] = "same-value";
    const target = structuredClone(base);
    target["beta"]!["owner"] = "same-value";
    const report = syncImport(base, source2, target);

    assert.equal(report.applied, true);
    const decision = report.items
      .find((i) => i.project === "beta")
      ?.decisions.find((d) => d.field === "owner");
    assert.equal(decision?.action, "agreed");
  });
});

describe("自动模式：单边改动自动合并", () => {
  test("源未改动、目标本地修改的字段自动保留目标值", () => {
    const source: Snapshot = {
      alpha: { name: "Alpha-2", status: "open", priority: 1 },
      beta: { owner: "lin", active: true },
    };
    const target = structuredClone(base);
    target["beta"]!["owner"] = "local-edit";
    const report = syncImport(base, source, target, { mode: "auto" });

    assert.equal(report.applied, true);
    assert.equal(report.result?.["beta"]?.["owner"], "local-edit");
    assert.equal(report.result?.["alpha"]?.["name"], "Alpha-2");
    const decision = report.items
      .find((i) => i.project === "beta")
      ?.decisions.find((d) => d.field === "owner");
    assert.equal(decision?.action, "keep-target");
  });

  test("双方都改动且不一致时仍需显式决议", () => {
    const source: Snapshot = {
      alpha: { name: "Alpha-2", status: "closed", priority: 1 },
      beta: { owner: "lin", active: true },
    };
    const target = structuredClone(base);
    target["alpha"]!["status"] = "done";
    const report = syncImport(base, source, target, { mode: "auto" });

    assert.equal(report.applied, false);
    assert.deepEqual(
      report.unresolvedConflicts.map((c) => `${c.project}.${c.field}`),
      ["alpha.status"]
    );
  });
});

describe("删除与新增的三方冲突", () => {
  test("源删除字段而目标本地修改该字段时冲突，决议 pick=source 传播删除", () => {
    const source: Snapshot = {
      alpha: { name: "Alpha", status: "open" },
      beta: { owner: "lin", active: true },
    };
    const target = structuredClone(base);
    target["alpha"]!["priority"] = 99;
    const conflicted = syncImport(base, source, target);
    assert.equal(conflicted.applied, false);
    assert.deepEqual(
      conflicted.unresolvedConflicts.map((c) => `${c.project}.${c.field}`),
      ["alpha.priority"]
    );

    const resolved = syncImport(base, source, target, {
      resolutions: [{ project: "alpha", field: "priority", pick: "source" }],
    });
    assert.equal(resolved.applied, true);
    assert.deepEqual(resolved.result?.["alpha"], { name: "Alpha", status: "open" });
  });

  test("目标本地新增的项目字段被保留，源新增同名项目按三方规则合并", () => {
    const source: Snapshot = { gamma: { name: "G", level: 1 } };
    const target: Snapshot = { gamma: { name: "G-local", note: "keep me" } };
    const report = syncImport({}, source, target, { mode: "auto" });

    assert.equal(report.applied, false);
    const resolved = syncImport({}, source, target, {
      mode: "auto",
      resolutions: [{ project: "gamma", field: "name", pick: "source" }],
    });
    assert.equal(resolved.applied, true);
    assert.deepEqual(resolved.result?.["gamma"], { name: "G", note: "keep me", level: 1 });
  });
});

describe("输入校验与报告输出", () => {
  test("非法快照与非法决议抛出 TypeError", () => {
    assert.throws(() => syncImport({ a: { f: 1 } }, { a: { f: undefined as never } }, {}), TypeError);
    assert.throws(() => syncImport({}, {}, { a: { f: { nested: 1 } as never } }), TypeError);
    assert.throws(
      () => syncImport({}, {}, {}, { resolutions: [{ project: "a", field: "f", pick: "value" }] }),
      TypeError
    );
    assert.throws(
      () =>
        syncImport({}, {}, {}, {
          resolutions: [
            { project: "a", field: "f", pick: "source" },
            { project: "a", field: "f", pick: "target" },
          ],
        }),
      /决议重复/
    );
  });

  test("无需决议的字段上的决议被记入 unusedResolutions", () => {
    const report = syncImport(base, structuredClone(base), structuredClone(base), {
      resolutions: [{ project: "alpha", field: "name", pick: "source" }],
    });
    assert.equal(report.applied, true);
    assert.equal(report.unusedResolutions.length, 1);
  });

  test("formatReport 输出逐项决议与未解冲突", () => {
    const source: Snapshot = { alpha: { name: "A2", status: "open", priority: 1 } };
    const target = structuredClone(base);
    target["alpha"]!["status"] = "done";
    const text = formatReport(syncImport(base, source, target));

    assert.ok(text.includes("[冲突] alpha"));
    assert.ok(text.includes("未解冲突 (1)"));
    assert.ok(text.includes("alpha.status"));
    assert.ok(text.includes("采用源值"));

    const clean = formatReport(syncImport(base, structuredClone(base), structuredClone(base)));
    assert.ok(clean.includes("未解冲突: 无"));
    assert.ok(clean.includes("批次已应用: 是"));
  });
});
