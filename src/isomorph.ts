import { Buffer } from "node:buffer";
import { SnapshotError } from "./errors.js";
import { Heap, type HeapObject } from "./heap.js";
import { deserialize, serialize } from "./snapshot.js";

/** 非引用字段的字面量指纹 + 引用字段名集合,用于候选剪枝。 */
function fingerprint(obj: HeapObject): string {
  const literals: string[] = [];
  const refNames: string[] = [];
  for (const [name, value] of obj.fields) {
    switch (value.kind) {
      case "int":
        literals.push(`${name}=int:${value.value}`);
        break;
      case "bytes":
        literals.push(`${name}=bytes:${Buffer.from(value.value).toString("hex")}`);
        break;
      case "ref":
        refNames.push(name);
        break;
    }
  }
  literals.sort();
  refNames.sort();
  return `${literals.join("|")}#refs:${refNames.join(",")}`;
}

/**
 * 判断两个堆是否图同构:存在保持字段名、字面量与引用结构的双射。
 * 采用指纹剪枝的回溯搜索;每次指派时与已映射节点做双向边一致性检查,
 * 因此共享引用、环与自环都会被严格比对。
 */
export function areIsomorphic(a: Heap, b: Heap): boolean {
  if (a.size !== b.size) return false;
  if (a.size === 0) return true;

  const byFingerprint = new Map<string, HeapObject[]>();
  for (const obj of b.objects()) {
    const fp = fingerprint(obj);
    const bucket = byFingerprint.get(fp);
    if (bucket) bucket.push(obj);
    else byFingerprint.set(fp, [obj]);
  }

  const workList: HeapObject[] = [];
  const candidates = new Map<number, number[]>();
  for (const objA of a.objects()) {
    const bucket = byFingerprint.get(fingerprint(objA));
    if (!bucket || bucket.length === 0) return false;
    candidates.set(objA.id, bucket.map((obj) => obj.id));
    workList.push(objA);
  }
  workList.sort((x, y) => candidates.get(x.id)!.length - candidates.get(y.id)!.length);

  const mapping = new Map<number, number>();
  const used = new Set<number>();

  const consistent = (objA: HeapObject, idB: number): boolean => {
    const objB = b.require(idB);
    for (const [name, value] of objA.fields) {
      if (value.kind === "ref" && value.id === objA.id) {
        const other = objB.fields.get(name);
        if (!other || other.kind !== "ref" || other.id !== objB.id) return false;
      }
    }
    for (const [name, value] of objB.fields) {
      if (value.kind === "ref" && value.id === objB.id) {
        const other = objA.fields.get(name);
        if (!other || other.kind !== "ref" || other.id !== objA.id) return false;
      }
    }
    for (const [idA2, idB2] of mapping) {
      const objA2 = a.require(idA2);
      const objB2 = b.require(idB2);
      for (const [name, value] of objA.fields) {
        if (value.kind === "ref" && value.id === idA2) {
          const other = objB.fields.get(name);
          if (!other || other.kind !== "ref" || other.id !== idB2) return false;
        }
      }
      for (const [name, value] of objB.fields) {
        if (value.kind === "ref" && value.id === idB2) {
          const other = objA.fields.get(name);
          if (!other || other.kind !== "ref" || other.id !== idA2) return false;
        }
      }
      for (const [name, value] of objA2.fields) {
        if (value.kind === "ref" && value.id === objA.id) {
          const other = objB2.fields.get(name);
          if (!other || other.kind !== "ref" || other.id !== objB.id) return false;
        }
      }
      for (const [name, value] of objB2.fields) {
        if (value.kind === "ref" && value.id === objB.id) {
          const other = objA2.fields.get(name);
          if (!other || other.kind !== "ref" || other.id !== objA.id) return false;
        }
      }
    }
    return true;
  };

  const search = (index: number): boolean => {
    if (index === workList.length) return true;
    const objA = workList[index]!;
    for (const idB of candidates.get(objA.id)!) {
      if (used.has(idB) || !consistent(objA, idB)) continue;
      mapping.set(objA.id, idB);
      used.add(idB);
      if (search(index + 1)) return true;
      mapping.delete(objA.id);
      used.delete(idB);
    }
    return false;
  };
  return search(0);
}

export function assertIsomorphic(a: Heap, b: Heap, message?: string): void {
  if (!areIsomorphic(a, b)) {
    throw new SnapshotError(message ?? "heaps are not graph-isomorphic");
  }
}

/** 往返核验:序列化 → 两阶段加载 → 与原始堆做图同构断言。返回还原出的堆。 */
export function verifyRoundTrip(heap: Heap): Heap {
  const restored = deserialize(serialize(heap));
  assertIsomorphic(heap, restored, "round trip broke graph isomorphism");
  return restored;
}
