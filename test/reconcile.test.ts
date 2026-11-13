import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  floatsEqual,
  reconcile,
  shouldSample,
  stableHash,
  type FeatureDefinition,
  type OfflineRow,
  type OnlineRecord,
} from "../src/reconcile.ts";

const DEFS: FeatureDefinition[] = [
  { name: "click_cnt", version: "v3", valueType: "int" },
  { name: "ctr", version: "v2", valueType: "float", tolerance: { abs: 1e-6, rel: 1e-4 } },
  { name: "region", version: "v1", valueType: "string" },
  { name: "score", version: "v1", valueType: "float", tolerance: { abs: 1e-6 }, ttlMs: 60_000 },
];

function row(partial: Partial<OfflineRow>): OfflineRow {
  return {
    entityId: "u1",
    feature: "click_cnt",
    featureVersion: "v3",
    eventTimeMs: 1_000_000,
    value: 42,
    partition: "dt=2026-11-13/hr=10",
    ...partial,
  };
}

function rec(partial: Partial<OnlineRecord>): OnlineRecord {
  return {
    entityId: "u1",
    feature: "click_cnt",
    featureVersion: "v3",
    eventTimeMs: 1_000_000,
    value: 42,
    key: "feat:click_cnt:u1",
    ...partial,
  };
}

describe("stableHash / shouldSample", () => {
  it("hash 稳定且可复现", () => {
    assert.equal(stableHash("entity-1"), stableHash("entity-1"));
    assert.notEqual(stableHash("entity-1"), stableHash("entity-2"));
  });

  it("采样决定是确定性的", () => {
    const first = shouldSample("u1", "ctr", 0.3, "s");
    for (let i = 0; i < 10; i++) {
      assert.equal(shouldSample("u1", "ctr", 0.3, "s"), first);
    }
  });

  it("采样率边界：0 全不采，1 全采", () => {
    assert.equal(shouldSample("u1", "ctr", 0), false);
    assert.equal(shouldSample("u1", "ctr", 1), true);
  });

  it("采样率 0.5 时部分实体命中", () => {
    const hits = Array.from({ length: 200 }, (_, i) =>
      shouldSample(`u${i}`, "ctr", 0.5),
    ).filter(Boolean).length;
    assert.ok(hits > 50 && hits < 150, `hits=${hits}`);
  });
});

describe("floatsEqual", () => {
  it("绝对容差内相等", () => {
    assert.equal(floatsEqual(1.0, 1.0 + 5e-7, { abs: 1e-6 }), true);
    assert.equal(floatsEqual(1.0, 1.0 + 2e-6, { abs: 1e-6 }), false);
  });

  it("相对容差按较大值缩放", () => {
    assert.equal(floatsEqual(10_000, 10_000.5, { rel: 1e-4 }), true);
    assert.equal(floatsEqual(10_000, 10_002, { rel: 1e-4 }), false);
  });

  it("非有限值仅与自身相等", () => {
    assert.equal(floatsEqual(NaN, NaN, { abs: 1 }), false);
    assert.equal(floatsEqual(Infinity, Infinity, {}), true);
  });
});

describe("reconcile", () => {
  const opts = { definitions: DEFS, nowMs: 1_000_000 };

  it("两侧一致时无差异", () => {
    const report = reconcile([row({})], [rec({})], opts);
    assert.equal(report.diffs.length, 0);
    assert.equal(report.sampledEntities, 1);
  });

  it("浮点在字段容差内不算差异", () => {
    const offline = [row({ feature: "ctr", featureVersion: "v2", value: 0.123456 })];
    const online = [rec({ feature: "ctr", featureVersion: "v2", value: 0.1234565 })];
    const report = reconcile(offline, online, opts);
    assert.equal(report.diffs.length, 0);
  });

  it("浮点超出容差记为 value_mismatch，并附两侧证据", () => {
    const offline = [row({ feature: "ctr", featureVersion: "v2", value: 0.12 })];
    const online = [rec({ feature: "ctr", featureVersion: "v2", value: 0.5 })];
    const report = reconcile(offline, online, opts);
    assert.equal(report.diffs.length, 1);
    const diff = report.diffs[0];
    assert.equal(diff.kind, "value_mismatch");
    assert.equal(diff.offlineEvidence?.source, "offline_partition");
    assert.equal(diff.offlineEvidence?.location, "dt=2026-11-13/hr=10");
    assert.equal(diff.onlineEvidence?.source, "online_kv");
    assert.equal(diff.onlineEvidence?.location, "feat:click_cnt:u1");
    assert.equal(report.summary.value_mismatch, 1);
  });

  it("在线事件时间落后且取值不同记为 stale_online 而非 value_mismatch", () => {
    const offline = [row({ eventTimeMs: 2_000_000, value: 100 })];
    const online = [rec({ eventTimeMs: 1_000_000, value: 42 })];
    const report = reconcile(offline, online, opts);
    assert.equal(report.diffs.length, 1);
    assert.equal(report.diffs[0].kind, "stale_online");
    assert.equal(report.summary.value_mismatch, 0);
  });

  it("在线值超 TTL 且取值不同记为 stale_online", () => {
    const offline = [row({ feature: "score", featureVersion: "v1", eventTimeMs: 999_000, value: 9 })];
    const online = [rec({ feature: "score", featureVersion: "v1", eventTimeMs: 900_000, value: 8 })];
    const report = reconcile(offline, online, opts);
    assert.equal(report.diffs[0].kind, "stale_online");
  });

  it("在线过期但取值碰巧一致时不产生差异", () => {
    const offline = [row({ eventTimeMs: 2_000_000, value: 42 })];
    const online = [rec({ eventTimeMs: 1_000_000, value: 42 })];
    const report = reconcile(offline, online, opts);
    assert.equal(report.diffs.length, 0);
  });

  it("版本不一致单独分类", () => {
    const offline = [row({ featureVersion: "v3" })];
    const online = [rec({ featureVersion: "v2" })];
    const report = reconcile(offline, online, opts);
    assert.equal(report.diffs[0].kind, "version_mismatch");
  });

  it("离线有在线无记为 missing_online", () => {
    const report = reconcile([row({})], [], opts);
    assert.equal(report.diffs[0].kind, "missing_online");
    assert.equal(report.diffs[0].onlineEvidence, undefined);
  });

  it("在线有离线无记为 unexpected_online", () => {
    const report = reconcile([], [rec({})], opts);
    assert.equal(report.diffs[0].kind, "unexpected_online");
    assert.equal(report.diffs[0].offlineEvidence, undefined);
  });

  it("sampleRate=0 时不检查任何行", () => {
    const report = reconcile([row({})], [rec({ value: 999 })], {
      ...opts,
      sampleRate: 0,
    });
    assert.equal(report.diffs.length, 0);
    assert.equal(report.sampledEntities, 0);
  });

  it("采样集合在相同输入下可复现", () => {
    const offline = Array.from({ length: 50 }, (_, i) =>
      row({ entityId: `u${i}`, value: i }),
    );
    const online = offline.map((r) =>
      rec({ entityId: r.entityId, value: (r.value as number) + 1000 }),
    );
    const a = reconcile(offline, online, { ...opts, sampleRate: 0.4, sampleSalt: "x" });
    const b = reconcile(offline, online, { ...opts, sampleRate: 0.4, sampleSalt: "x" });
    assert.deepEqual(a.diffs, b.diffs);
    assert.ok(a.diffs.length > 0);
    assert.ok(a.diffs.length < 50);
  });

  it("summary 覆盖所有差异类别", () => {
    const report = reconcile([row({})], [], opts);
    assert.deepEqual(Object.keys(report.summary).sort(), [
      "missing_online",
      "stale_online",
      "unexpected_online",
      "value_mismatch",
      "version_mismatch",
    ]);
  });
});
