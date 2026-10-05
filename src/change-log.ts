/**
 * 变更库：记录对键值状态的 insert / delete / replace 操作，
 * 支持同键连续操作压缩、逆批次撤销，以及"需要基线"报告。
 */

export type Value = unknown;

export interface InsertOp {
  type: "insert";
  key: string;
  value: Value;
}

export interface DeleteOp {
  type: "delete";
  key: string;
  /** 删除前的原值；缺失时需要从基线解析 */
  oldValue?: Value;
}

export interface ReplaceOp {
  type: "replace";
  key: string;
  newValue: Value;
  /** 替换前的原值；缺失时需要从基线解析 */
  oldValue?: Value;
}

export type Op = InsertOp | DeleteOp | ReplaceOp;

export interface CompressResult {
  /** 压缩后的操作序列 */
  ops: Op[];
  /** 无法确定原值、需要基线才能补全的键（已排序、去重） */
  needsBaseline: string[];
}

export interface InvertResult {
  /** 逆批次：批次顺序与批内操作顺序均已反转，依次应用即可撤销 */
  batches: Op[][];
  /** 因原值未知而无法生成逆操作、需要基线的键（已排序、去重） */
  needsBaseline: string[];
}

interface ResolvedOld {
  found: boolean;
  value?: Value;
}

function resolveOldValue(
  op: DeleteOp | ReplaceOp,
  baseline: ReadonlyMap<string, Value> | undefined,
): ResolvedOld {
  if ("oldValue" in op) return { found: true, value: op.oldValue };
  if (baseline !== undefined && baseline.has(op.key)) {
    return { found: true, value: baseline.get(op.key) };
  }
  return { found: false };
}

/**
 * 合并同键的两个连续操作，返回 0 或 1 个操作。
 * 规则：
 *  - insert 后 delete：两者消失；
 *  - delete 后 insert：成为 replace 并保存原值；
 *  - replace 后 delete：成为 delete，保留最早原值；
 *  - replace 后 replace：合并，保留最早原值；
 *  - insert 后 replace：仍是 insert（键原本不存在）；
 *  - delete 幂等，重复 delete 只留第一个。
 */
function mergePair(
  prev: Op,
  next: Op,
  baseline: ReadonlyMap<string, Value> | undefined,
  missing: Set<string>,
): Op[] {
  if (prev.type === "insert") {
    if (next.type === "insert") return [next];
    if (next.type === "delete") return [];
    return [{ type: "insert", key: prev.key, value: next.newValue }];
  }

  const old = resolveOldValue(prev, baseline);
  if (!old.found) missing.add(prev.key);

  if (next.type === "insert") {
    const rep: ReplaceOp = { type: "replace", key: prev.key, newValue: next.value };
    return [old.found ? { ...rep, oldValue: old.value } : rep];
  }
  if (next.type === "delete") {
    if (prev.type === "delete") return [prev];
    const del: DeleteOp = { type: "delete", key: prev.key };
    return [old.found ? { ...del, oldValue: old.value } : del];
  }
  const rep: ReplaceOp = { type: "replace", key: prev.key, newValue: next.newValue };
  return [old.found ? { ...rep, oldValue: old.value } : rep];
}

/**
 * 压缩操作序列中同键的连续操作。
 * 若某 delete/replace 的原值既未随操作记录、也不在 baseline 中，
 * 则把该键记入 needsBaseline（需要基线）。
 */
export function compress(
  ops: readonly Op[],
  baseline?: ReadonlyMap<string, Value>,
): CompressResult {
  const out: Op[] = [];
  const missing = new Set<string>();
  for (const op of ops) {
    const last = out.length > 0 ? out[out.length - 1] : undefined;
    if (last !== undefined && last.key === op.key) {
      const merged = mergePair(last, op, baseline, missing);
      out.splice(out.length - 1, 1, ...merged);
    } else {
      if (
        op.type !== "insert" &&
        !("oldValue" in op) &&
        !(baseline !== undefined && baseline.has(op.key))
      ) {
        missing.add(op.key);
      }
      out.push(op);
    }
  }
  return { ops: out, needsBaseline: [...missing].sort() };
}

/** 把操作序列应用到状态上。 */
export function applyOps(state: Map<string, Value>, ops: Iterable<Op>): void {
  for (const op of ops) {
    switch (op.type) {
      case "insert":
        state.set(op.key, op.value);
        break;
      case "delete":
        state.delete(op.key);
        break;
      case "replace":
        state.set(op.key, op.newValue);
        break;
    }
  }
}

/** 求单个操作的逆操作；原值未知且基线无法提供时返回 null。 */
export function invertOp(
  op: Op,
  baseline?: ReadonlyMap<string, Value>,
): Op | null {
  switch (op.type) {
    case "insert":
      return { type: "delete", key: op.key, oldValue: op.value };
    case "delete": {
      const old = resolveOldValue(op, baseline);
      return old.found
        ? { type: "insert", key: op.key, value: old.value }
        : null;
    }
    case "replace": {
      const old = resolveOldValue(op, baseline);
      if (!old.found) return null;
      return {
        type: "replace",
        key: op.key,
        oldValue: op.newValue,
        newValue: old.value,
      };
    }
  }
}

/**
 * 输出逆批次：批次倒序、批内操作倒序并逐个取逆。
 * 依次应用返回的批次即可撤销全部变更。
 * 无法取逆（原值未知）的操作被跳过，并把键记入 needsBaseline。
 */
export function invertBatches(
  batches: readonly (readonly Op[])[],
  baseline?: ReadonlyMap<string, Value>,
): InvertResult {
  const missing = new Set<string>();
  const out: Op[][] = [];
  for (let i = batches.length - 1; i >= 0; i--) {
    const batch = batches[i];
    const inverted: Op[] = [];
    if (batch !== undefined) {
      for (let j = batch.length - 1; j >= 0; j--) {
        const op = batch[j];
        if (op === undefined) continue;
        const inv = invertOp(op, baseline);
        if (inv === null) missing.add(op.key);
        else inverted.push(inv);
      }
    }
    out.push(inverted);
  }
  return { batches: out, needsBaseline: [...missing].sort() };
}

/** 把操作序列切分为固定大小的批次。 */
export function batchOps(ops: readonly Op[], size: number): Op[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError("batch size must be a positive integer");
  }
  const batches: Op[][] = [];
  for (let i = 0; i < ops.length; i += size) {
    batches.push(ops.slice(i, i + size));
  }
  return batches;
}
