/**
 * 分层配置合并核心。
 *
 * 合并规则：
 *  1. 对象：按键递归合并。
 *  2. 数组：元素按稳定 id（默认键名 "id"）匹配合并；无 id 元素整组由高层替换。
 *  3. 显式删除：{ $delete: true } 生成墓碑；删除不存在的项同样保留墓碑以遮蔽祖先层。
 *  4. 类型变化：整项替换（高层类型与低层不同时，低层子树整体丢弃）。
 *  5. 标量：高层覆盖低层。
 *
 * 内部节点携带墓碑（tomb）与遮蔽盾（shield），使合并满足结合律：
 *   merge(merge(a, b), c) ≡ merge(a, merge(b, c))
 * 因此可以先合并高层、再与祖先层合并，删除语义依然正确。
 */

export const DELETE_KEY = "$delete";

export interface DeleteMarker {
  $delete: true;
}

/** 生成显式删除标记。对象键上直接用；数组中须与稳定 id 同放：{ id: "x", ...del() }。 */
export function del(): DeleteMarker {
  return { $delete: true };
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function isDeleteMarker(v: unknown): v is DeleteMarker {
  return isPlainObject(v) && v[DELETE_KEY] === true;
}

export function joinPath(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}

// ---------------------------------------------------------------------------
// 内部节点
// ---------------------------------------------------------------------------

export type Slot = { kind: "id"; id: unknown } | { kind: "u"; i: number };

export interface LeafNode { t: "leaf"; v: unknown; src: string }
export interface ObjNode { t: "obj"; src: string; keys: Map<string, Node> }
export interface ArrNode {
  t: "arr";
  src: string;
  keyed: Map<unknown, Node>; // 全部已知 id（含墓碑）→ 节点
  order: Slot[];             // 只增顺序：已知 id 槽位 + 无 id 元素槽位
  unkeyed: Node[];           // 当前生效的无 id 元素
}
export interface TombNode { t: "tomb"; src: string }
/** 遮蔽盾：子树整体遮蔽所有祖先层（删除后重新引入、类型变化替换、标量覆盖时产生）。 */
export interface ShieldNode { t: "shield"; node: Node; src: string }

export type Node = LeafNode | ObjNode | ArrNode | TombNode | ShieldNode;

function shieldOf(node: Node, src: string): Node {
  return node.t === "shield" ? node : { t: "shield", node, src };
}

// ---------------------------------------------------------------------------
// 原始配置 → 内部节点
// ---------------------------------------------------------------------------

export function fromRaw(v: unknown, src: string, idKey: string): Node {
  if (isDeleteMarker(v)) return { t: "tomb", src };
  if (isPlainObject(v)) {
    const keys = new Map<string, Node>();
    for (const [k, val] of Object.entries(v)) keys.set(k, fromRaw(val, src, idKey));
    return { t: "obj", src, keys };
  }
  if (Array.isArray(v)) {
    const keyed = new Map<unknown, Node>();
    const order: Slot[] = [];
    const unkeyed: Node[] = [];
    for (const el of v) {
      if (isPlainObject(el) && Object.prototype.hasOwnProperty.call(el, idKey)) {
        const id = el[idKey];
        const node = fromRaw(el, src, idKey);
        if (!keyed.has(id)) {
          keyed.set(id, node);
          order.push({ kind: "id", id });
        } else {
          keyed.set(id, node); // 同层重复 id：后者整体替换前者
        }
      } else if (!isDeleteMarker(el)) {
        // 无稳定 id 的元素；裸删除标记无法定位目标，忽略
        unkeyed.push(fromRaw(el, src, idKey));
        order.push({ kind: "u", i: unkeyed.length - 1 });
      }
    }
    return { t: "arr", src, keyed, order, unkeyed };
  }
  return { t: "leaf", v, src };
}

// ---------------------------------------------------------------------------
// 合并（b 为更高层）
// ---------------------------------------------------------------------------

export function mergeNode(a: Node, b: Node): Node {
  if (b.t === "tomb") return b; // 高层删除：墓碑遮蔽一切低层
  if (b.t === "shield") {
    // 高层遮蔽盾：非盾低层整体被遮蔽；盾对盾则内部正常合并
    return a.t === "shield" ? shieldOf(mergeNode(a.node, b.node), b.src) : b;
  }
  if (a.t === "tomb") return shieldOf(b, b.src); // 删除后重新引入：遮蔽祖先
  if (a.t === "shield") return shieldOf(mergeNode(a.node, b), b.src);
  if (a.t === "obj" && b.t === "obj") return mergeObject(a, b);
  if (a.t === "arr" && b.t === "arr") return mergeArray(a, b);
  // 标量覆盖 / 类型变化整项替换：遮蔽祖先，保证结合律
  // （否则高层再次变为对象时，被替换的祖先子树会在右折叠中复活）
  return shieldOf(b, b.src);
}

function mergeObject(a: ObjNode, b: ObjNode): ObjNode {
  const keys = new Map(a.keys);
  for (const [k, nb] of b.keys) {
    const na = keys.get(k);
    keys.set(k, na === undefined ? nb : mergeNode(na, nb));
  }
  return { t: "obj", src: b.src, keys };
}

function mergeArray(a: ArrNode, b: ArrNode): ArrNode {
  const keyed = new Map(a.keyed);
  for (const [id, nb] of b.keyed) {
    const na = keyed.get(id);
    keyed.set(id, na === undefined ? nb : mergeNode(na, nb));
  }
  // 顺序只增：保留 a 的全部槽位（墓碑槽位也保留，重新引入时回到原位）；
  // b 的新槽位按 b 的原顺序内联追加；若 b 含无 id 元素，a 的无 id 槽位被整组替换。
  const order: Slot[] = [];
  for (const s of a.order) {
    if (s.kind === "u" && b.unkeyed.length > 0) continue;
    order.push(s);
  }
  for (const s of b.order) {
    if (s.kind === "id") {
      if (!a.keyed.has(s.id)) order.push(s);
    } else {
      order.push(s); // b 含无 id 元素时才有 u 槽位
    }
  }
  const unkeyed = b.unkeyed.length > 0 ? b.unkeyed : a.unkeyed;
  return { t: "arr", src: b.src, keyed, order, unkeyed };
}

// ---------------------------------------------------------------------------
// 物化为普通值
// ---------------------------------------------------------------------------

export const OMIT: unique symbol = Symbol("omit");

export function materialize(n: Node): unknown {
  switch (n.t) {
    case "leaf":
      return n.v;
    case "tomb":
      return OMIT;
    case "shield":
      return materialize(n.node);
    case "obj": {
      const out: Record<string, unknown> = {};
      for (const [k, c] of n.keys) {
        const v = materialize(c);
        if (v !== OMIT) out[k] = v;
      }
      return out;
    }
    case "arr": {
      const out: unknown[] = [];
      for (const s of n.order) {
        const node = s.kind === "id" ? n.keyed.get(s.id)! : n.unkeyed[s.i]!;
        const v = materialize(node);
        if (v !== OMIT) out.push(v);
      }
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// 逐项来源
// ---------------------------------------------------------------------------

export type ProvKind = "value" | "delete";

export interface ProvEntry {
  path: string;
  source: string;
  kind: ProvKind;
}

export function collectProvenance(
  n: Node,
  idKey: string,
  path = "",
  out: ProvEntry[] = [],
): ProvEntry[] {
  switch (n.t) {
    case "leaf":
      out.push({ path, source: n.src, kind: "value" });
      break;
    case "tomb":
      out.push({ path, source: n.src, kind: "delete" });
      break;
    case "shield":
      collectProvenance(n.node, idKey, path, out);
      break;
    case "obj":
      for (const [k, c] of n.keys) collectProvenance(c, idKey, joinPath(path, k), out);
      break;
    case "arr": {
      let u = 0;
      for (const s of n.order) {
        if (s.kind === "id") {
          collectProvenance(n.keyed.get(s.id)!, idKey, `${path}[${idKey}=${String(s.id)}]`, out);
        } else {
          collectProvenance(n.unkeyed[s.i]!, idKey, `${path}[#${u++}]`, out);
        }
      }
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 对外主入口：按层顺序合并
// ---------------------------------------------------------------------------

export interface NamedLayer {
  name: string;
  config: unknown;
}

export interface MergeOptions {
  /** 数组元素的稳定 id 键名，默认 "id"。 */
  idKey?: string;
}

export interface MergeResult {
  value: unknown;
  provenance: ProvEntry[];
}

export function mergeLayers(layers: NamedLayer[], opts: MergeOptions = {}): MergeResult {
  const idKey = opts.idKey ?? "id";
  let acc: Node = { t: "obj", src: "(base)", keys: new Map() };
  for (const layer of layers) {
    acc = mergeNode(acc, fromRaw(layer.config, layer.name, idKey));
  }
  const v = materialize(acc);
  return { value: v === OMIT ? undefined : v, provenance: collectProvenance(acc, idKey) };
}
