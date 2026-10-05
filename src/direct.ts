/**
 * 直接规则求值：不做逐层折叠，直接对每个路径按规则取最终结果。
 * 与 merge.ts 的顺序合并互为独立实现，用于对照验证一致性。
 *
 * 规则（对任意路径 P，从最高层向下看）：
 *  - 最高层在 P 处是 { $delete: true } → P 被删除（墓碑遮蔽所有祖先层）。
 *  - 最高层在 P 处是对象 → 按键递归；只有"自最近一次删除/类型变化以上"的对象层参与贡献键。
 *  - 最高层在 P 处是数组 → 按稳定 id 折叠所有参与层的元素；无 id 元素整组取自最高参与层。
 *  - 最高层在 P 处是标量/null → 整项替换（类型变化时低层子树整体丢弃）。
 */

import {
  DELETE_KEY,
  isDeleteMarker,
  isPlainObject,
  joinPath,
  MergeOptions,
  NamedLayer,
} from "./merge";

const OMITD: unique symbol = Symbol("omit-direct");

export type ExplainKind = "value" | "delete" | "structure";

export interface ExplainEntry {
  path: string;
  source: string;
  kind: ExplainKind;
  rule: string;
}

export interface DirectResult {
  value: unknown;
  provenance: ExplainEntry[];
}

interface Ctx {
  idKey: string;
  names: string[];
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (isDeleteMarker(v)) return DELETE_KEY;
  return typeof v;
}

function topIndex(values: unknown[]): number {
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== undefined) return i;
  }
  return -1;
}

export function resolveDirect(layers: NamedLayer[], opts: MergeOptions = {}): DirectResult {
  const ctx: Ctx = { idKey: opts.idKey ?? "id", names: layers.map((l) => l.name) };
  const prov: ExplainEntry[] = [];
  const v = resolve(layers.map((l) => l.config), "", prov, ctx);
  return { value: v === OMITD ? undefined : v, provenance: prov };
}

function resolve(
  values: unknown[],
  path: string,
  prov: ExplainEntry[],
  ctx: Ctx,
  ruleOverride?: string,
): unknown {
  const top = topIndex(values);
  if (top < 0) return OMITD;
  const tv = values[top];
  const disp = path === "" ? "(root)" : path;

  if (isDeleteMarker(tv)) {
    prov.push({
      path: disp,
      source: ctx.names[top]!,
      kind: "delete",
      rule: "显式删除：$delete 生成墓碑，遮蔽所有祖先层（即使删除时该项不存在，墓碑也保留）",
    });
    return OMITD;
  }

  // 最近的低层定义（仅用于规则解释）
  let lower = -1;
  for (let i = top - 1; i >= 0; i--) {
    if (values[i] !== undefined) { lower = i; break; }
  }

  if (isPlainObject(tv)) {
    // cut：最近一次"非对象定义"（删除标记 / 标量 / 数组）的位置，其下被整体遮蔽
    let cut = -1;
    for (let i = top - 1; i >= 0; i--) {
      const v = values[i];
      if (v !== undefined && (isDeleteMarker(v) || !isPlainObject(v))) { cut = i; break; }
    }
    const note = cut >= 0 ? `类型变化整项替换（${typeName(values[cut])} → object）；` : "";
    prov.push({
      path: disp,
      source: ctx.names[top]!,
      kind: "structure",
      rule: `${note}对象递归合并：按键逐层合并`,
    });
    const out: Record<string, unknown> = {};
    const keys: string[] = [];
    for (let i = cut + 1; i <= top; i++) {
      const v = values[i];
      if (isPlainObject(v) && !isDeleteMarker(v)) {
        for (const k of Object.keys(v)) if (!keys.includes(k)) keys.push(k);
      }
    }
    for (const k of keys) {
      const childVals = values.map((v, i) =>
        i > cut && isPlainObject(v) && !isDeleteMarker(v) ? v[k] : undefined,
      );
      const child = resolve(childVals, joinPath(path, k), prov, ctx);
      if (child !== OMITD) out[k] = child;
    }
    return out;
  }

  if (Array.isArray(tv)) {
    let cut = -1;
    for (let i = top - 1; i >= 0; i--) {
      const v = values[i];
      if (v !== undefined && !Array.isArray(v)) { cut = i; break; }
    }
    const note = cut >= 0 ? `类型变化整项替换（${typeName(values[cut])} → array）；` : "";
    const contrib: string[] = [];
    for (let i = cut + 1; i <= top; i++) if (Array.isArray(values[i])) contrib.push(ctx.names[i]!);
    prov.push({
      path: disp,
      source: contrib.join(" + "),
      kind: "structure",
      rule: `${note}数组按稳定 id（${ctx.idKey}）匹配合并；无 id 元素整组取自最高参与层`,
    });

    const order: Array<{ kind: "id"; id: unknown } | { kind: "u" }> = [];
    const known = new Set<unknown>();
    const perId = new Map<unknown, unknown[]>();
    let unkeyed: unknown[] = [];
    let unkeyedSrc = -1;
    for (let i = cut + 1; i <= top; i++) {
      const v = values[i];
      if (!Array.isArray(v)) continue;
      const isKeyed = (el: unknown): boolean =>
        isPlainObject(el) && Object.prototype.hasOwnProperty.call(el, ctx.idKey);
      if (v.some((el) => !isKeyed(el) && !isDeleteMarker(el))) {
        // 该层含无 id 元素：上一生效层的无 id 槽位被整组替换
        for (let j = order.length - 1; j >= 0; j--) {
          if (order[j]!.kind === "u") order.splice(j, 1);
        }
        unkeyed = [];
        unkeyedSrc = i;
      }
      for (const el of v) {
        if (isKeyed(el)) {
          const id = el[ctx.idKey];
          if (!perId.has(id)) perId.set(id, new Array<unknown>(values.length).fill(undefined));
          perId.get(id)![i] = el; // 同层重复 id：后者整体替换前者
          if (!known.has(id)) { known.add(id); order.push({ kind: "id", id }); }
        } else if (!isDeleteMarker(el)) {
          unkeyed.push(el);
          order.push({ kind: "u" });
        }
      }
    }
    const out: unknown[] = [];
    let uIdx = 0;
    for (const s of order) {
      if (s.kind === "id") {
        const child = resolve(perId.get(s.id)!, `${path}[${ctx.idKey}=${String(s.id)}]`, prov, ctx);
        if (child !== OMITD) out.push(child);
      } else {
        const childVals = new Array<unknown>(values.length).fill(undefined);
        childVals[unkeyedSrc] = unkeyed[uIdx];
        const child = resolve(
          childVals,
          `${path}[#${uIdx}]`,
          prov,
          ctx,
          `无稳定 id 元素：整组取自最高参与层（${ctx.names[unkeyedSrc]!}）`,
        );
        uIdx++;
        if (child !== OMITD) out.push(child);
      }
    }
    return out;
  }

  // 标量 / null：整项替换
  let rule: string;
  if (ruleOverride !== undefined) {
    rule = ruleOverride;
  } else if (lower < 0) {
    rule = "单层定义：仅一层提供该值，直接采用";
  } else {
    const lv = values[lower];
    if (isDeleteMarker(lv)) rule = "删除后由更高层重新引入";
    else if (typeName(lv) !== typeName(tv)) rule = `类型变化整项替换（${typeName(lv)} → ${typeName(tv)}）`;
    else rule = "标量覆盖：高层值替换低层值";
  }
  prov.push({ path: disp, source: ctx.names[top]!, kind: "value", rule });
  return tv;
}
