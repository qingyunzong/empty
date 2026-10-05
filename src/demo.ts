/**
 * 演示：三层顺序合并 vs 直接规则求值，逐项来源对照。
 * 运行：npm run demo
 */
import {
  collectProvenance,
  fromRaw,
  materialize,
  mergeLayers,
  mergeNode,
  ProvEntry,
} from "./merge";
import { resolveDirect } from "./direct";
import { exampleLayers } from "./example";

// 终端列宽：CJK 字符按 2 列计
function dw(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0)! >= 0x2e80 ? 2 : 1;
  return w;
}
function pad(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - dw(s)));
}
function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(dw(h), ...rows.map((r) => dw(r[i] ?? ""))),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => pad(c, widths[i]!)).join(" │ ");
  const sep = widths.map((w) => "─".repeat(w)).join("─┼─");
  return [line(headers), sep, ...rows.map(line)].join("\n");
}

function toMap(entries: ProvEntry[]): Map<string, ProvEntry> {
  const m = new Map<string, ProvEntry>();
  for (const e of entries) m.set(e.path, e);
  return m;
}

const layers = exampleLayers;

console.log("=== 1. 三层顺序合并结果（mergeLayers）===\n");
const seq = mergeLayers(layers);
console.log(JSON.stringify(seq.value, null, 2));

console.log("\n=== 2. 逐项来源与规则对照（三层合并 vs 直接规则解释）===\n");
const direct = resolveDirect(layers);
const seqMap = toMap(seq.provenance);
const rows: string[][] = [];
let mismatch = 0;
for (const e of direct.provenance) {
  if (e.kind === "structure") {
    rows.push([e.path, "—", "—", e.rule]);
    continue;
  }
  const s = seqMap.get(e.path);
  const seqSrc = s ? s.source : "(缺失)";
  const okMark = s && s.source === e.source && s.kind === e.kind ? "✓" : "✗";
  if (okMark === "✗") mismatch++;
  rows.push([e.path, `${seqSrc} ${okMark}`, e.source, e.rule]);
}
console.log(table(["路径", "三层合并来源", "直接规则来源", "规则解释"], rows));

const seqOnly = seq.provenance.filter((e) => !direct.provenance.some((d) => d.path === e.path));
if (seqOnly.length > 0) {
  mismatch += seqOnly.length;
  console.log("顺序合并多出的条目：", seqOnly);
}

console.log("\n=== 3. 一致性结论 ===\n");
const valueEqual = JSON.stringify(seq.value) === JSON.stringify(direct.value);
console.log(`合并结果值一致：${valueEqual ? "✓" : "✗"}`);
console.log(`逐项来源一致：${mismatch === 0 ? "✓" : `✗（${mismatch} 处不一致）`}`);

console.log("\n=== 4. 结合律与墓碑演示 ===\n");
const [l1, l2, l3] = layers;
const idKey = "id";
const n1 = fromRaw(l1!.config, l1!.name, idKey);
const n2 = fromRaw(l2!.config, l2!.name, idKey);
const n3 = fromRaw(l3!.config, l3!.name, idKey);

const mid23 = mergeNode(n2, n3); // 先合并高层：L2+L3
const midProv = collectProvenance(mid23, idKey);
const phantomTomb = midProv.find((e) => e.path === "plugins[id=phantom]");
console.log("中间合并 L2+L3（此时 phantom 在两层中均不存在为实体）：");
console.log(
  `  墓碑保留：${phantomTomb ? `✓ ${phantomTomb.path}（来源 ${phantomTomb.source}）` : "✗"}`,
);

const leftFold = materialize(mergeNode(mergeNode(n1, n2), n3));
const rightFold = materialize(mergeNode(n1, mid23));
const assocOk = JSON.stringify(leftFold) === JSON.stringify(rightFold);
console.log(`结合律 merge(merge(L1,L2),L3) ≡ merge(L1,merge(L2,L3))：${assocOk ? "✓" : "✗"}`);
const phantomMasked =
  JSON.stringify((rightFold as Record<string, unknown>)["plugins"])?.includes("phantom") !== true;
console.log(`phantom 被墓碑遮蔽（未出现在最终结果）：${phantomMasked ? "✓" : "✗"}`);
const directOk = JSON.stringify(rightFold) === JSON.stringify(direct.value);
console.log(`右折叠结果 ≡ 直接规则求值：${directOk ? "✓" : "✗"}`);

if (!valueEqual || mismatch > 0 || !assocOk || !phantomMasked || !directOk) {
  process.exitCode = 1;
}
