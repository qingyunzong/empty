import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EvidenceGraph,
  Propagator,
  resolveConflicts,
  type FieldSet,
  type Label,
} from "../index.ts";

function makeLabel(partial: Partial<Label> & { id: string }): Label {
  return {
    category: "sensitivity",
    level: "confidential",
    scope: "record",
    source: { kind: "scanner", scanner: "pii-scanner" },
    confidence: 0.9,
    purposes: { allowed: [], denied: [] },
    declassify: [],
    ...partial,
  };
}

function field(name: string, labels: Label[]): FieldSet {
  return { name, labels };
}

test("resolveConflicts 按偏序保留多个极大元素", () => {
  const labels = [
    makeLabel({ id: "sec.low", category: "security", level: "internal" }),
    makeLabel({ id: "sec.high", category: "security", level: "restricted" }),
    makeLabel({ id: "priv.mid", category: "privacy", level: "confidential" }),
  ];
  const resolved = resolveConflicts(labels);
  const ids = resolved.map((l) => l.id).sort();
  assert.deepEqual(ids, ["priv.mid", "sec.high"]);
});

test("resolveConflicts 合并同 id 标签：置信度取 max，用途取交集", () => {
  const labels = [
    makeLabel({ id: "pii.email", confidence: 0.6, purposes: { allowed: ["analytics", "billing"], denied: [] } }),
    makeLabel({ id: "pii.email", confidence: 0.9, purposes: { allowed: ["analytics"], denied: ["ads"] } }),
  ];
  const [merged] = resolveConflicts(labels);
  assert.equal(merged.confidence, 0.9);
  assert.deepEqual(merged.purposes.allowed, ["analytics"]);
  assert.deepEqual(merged.purposes.denied, ["ads"]);
  assert.equal(merged.source.kind, "merged");
});

test("concat 保留所有输入标签并用 noisy-or 合并同 id 置信度", () => {
  const p = new Propagator();
  const a = p.register(field("first_name", [makeLabel({ id: "pii.name", confidence: 0.5 })]));
  const b = p.register(field("last_name", [makeLabel({ id: "pii.name", confidence: 0.5 })]));
  const c = p.register(field("city", [makeLabel({ id: "geo.city", category: "geo", level: "internal", scope: "cohort" })]));

  const out = p.concat("full_profile", [a, b, c]);
  const name = out.labels.find((l) => l.id === "pii.name")!;
  assert.equal(name.confidence, 0.75); // 1 - (1-0.5)^2
  assert.ok(out.labels.some((l) => l.id === "geo.city"));
});

test("hash 默认衰减置信度，且遵循 declassify 规则", () => {
  const p = new Propagator({ hashConfidenceFactor: 0.5 });
  const input = p.register(
    field("email", [
      makeLabel({ id: "pii.email", confidence: 0.8 }),
      makeLabel({
        id: "pii.device",
        declassify: [{ transform: "hash", action: "drop" }],
      }),
      makeLabel({
        id: "fin.account",
        category: "finance",
        level: "restricted",
        declassify: [{ transform: "hash", action: "downgrade", toLevel: "internal", confidenceFactor: 0.5 }],
      }),
    ]),
  );

  const out = p.hash("email_hash", input);
  const email = out.labels.find((l) => l.id === "pii.email")!;
  assert.equal(email.confidence, 0.4);
  assert.ok(!out.labels.some((l) => l.id === "pii.device"));

  const fin = out.labels.find((l) => l.id === "fin.account")!;
  assert.equal(fin.level, "internal");
  assert.equal(fin.confidence, 0.45);
});

test("tokenize 原样传播标签与置信度", () => {
  const p = new Propagator();
  const input = p.register(field("ssn", [makeLabel({ id: "pii.ssn", level: "restricted", confidence: 0.95 })]));
  const out = p.tokenize("ssn_token", input);
  assert.equal(out.labels.length, 1);
  assert.equal(out.labels[0].confidence, 0.95);
  assert.equal(out.labels[0].level, "restricted");
});

test("aggregate 丢弃 record 级标签，保留 cohort 级并取最弱置信度", () => {
  const p = new Propagator();
  const a = p.register(
    field("txns_a", [
      makeLabel({ id: "pii.user", confidence: 0.9 }),
      makeLabel({ id: "cohort.region", category: "geo", scope: "cohort", level: "internal", confidence: 0.8 }),
    ]),
  );
  const b = p.register(
    field("txns_b", [
      makeLabel({ id: "cohort.region", category: "geo", scope: "cohort", level: "internal", confidence: 0.6 }),
    ]),
  );

  const out = p.aggregate("region_stats", [a, b]);
  assert.ok(!out.labels.some((l) => l.id === "pii.user"));
  const cohort = out.labels.find((l) => l.id === "cohort.region")!;
  assert.equal(cohort.confidence, 0.6);
});

test("aggregate 遵循 keep 规则保留 record 级标签", () => {
  const p = new Propagator();
  const input = p.register(
    field("metrics", [
      makeLabel({
        id: "biz.kpi",
        declassify: [{ transform: "aggregate", action: "keep" }],
      }),
    ]),
  );
  const out = p.aggregate("kpi_daily", [input]);
  assert.ok(out.labels.some((l) => l.id === "biz.kpi"));
});

test("每个输出标签都有完整的推导证据图", () => {
  const p = new Propagator();
  const raw = p.register(field("email", [makeLabel({ id: "pii.email" })]));
  const hashed = p.hash("email_hash", raw);
  const joined = p.concat("joined", [hashed, p.register(field("age", [makeLabel({ id: "demo.age", category: "demo", level: "internal", scope: "cohort" })]))]);

  const evidence = p.evidenceFor("joined", "pii.email");
  assert.ok(evidence instanceof EvidenceGraph);
  const titles = [...evidence.nodes.values()].map((n) => n.title);
  assert.ok(titles.some((t) => t.startsWith("hash#")));
  assert.ok(titles.some((t) => t.startsWith("concat#")));
  assert.ok(titles.includes("email:pii.email"));
  assert.ok(titles.includes("joined:pii.email"));
  // 不相关标签的证据不应出现在子图中
  assert.ok(!titles.includes("age:demo.age"));

  const dot = evidence.toDot();
  assert.match(dot, /digraph evidence/);
  assert.match(dot, /derives/);
  assert.match(dot, /produces/);
});

test("被丢弃的标签在证据图中留下 drop 节点", () => {
  const p = new Propagator();
  const input = p.register(field("ssn", [makeLabel({ id: "pii.ssn" })]));
  p.aggregate("stats", [input]);
  const drops = [...p.evidence.nodes.values()].filter((n) => n.kind === "drop");
  assert.equal(drops.length, 1);
  assert.equal(drops[0].title, "drop:pii.ssn");
});
