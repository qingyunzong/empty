import { fieldsEqual, MergedFile, Snapshot } from './model.js';

export type PlanOp =
  | { op: 'create'; id: string; path: string; fields: Record<string, string> }
  | { op: 'update'; id: string; path: string; fields: Record<string, string> }
  | { op: 'move'; id: string; path: string }
  | { op: 'delete'; id: string };

/** 原子变更计划：要么整体通过校验并应用，要么不产出。 */
export interface ChangePlan {
  ops: PlanOp[];
}

const TMP_PREFIX = '.__sync_tmp__/';

/**
 * 由 base -> merged 的差异生成计划。
 * 顺序保证应用全程路径唯一：先删除，再把所有改名文件移到临时路径，最后落位最终路径。
 */
export function buildPlan(base: Snapshot, merged: Record<string, MergedFile>): ChangePlan {
  const deletes: PlanOp[] = [];
  const tempMoves: PlanOp[] = [];
  const finals: PlanOp[] = [];

  for (const id of Object.keys(base).sort()) {
    if (!(id in merged)) deletes.push({ op: 'delete', id });
  }
  for (const id of Object.keys(merged).sort()) {
    const m = merged[id] as MergedFile;
    const b = base[id];
    if (!b) {
      finals.push({ op: 'create', id, path: m.path, fields: { ...m.fields } });
      continue;
    }
    if (b.path === m.path && fieldsEqual(b.fields, m.fields)) continue;
    if (b.path !== m.path) tempMoves.push({ op: 'move', id, path: TMP_PREFIX + id });
    finals.push({ op: 'update', id, path: m.path, fields: { ...m.fields } });
  }
  return { ops: [...deletes, ...tempMoves, ...finals] };
}

/** 在 base 的副本上顺序应用计划；任一步骤违反约束即抛错（整体失败，不留半成品）。 */
export function applyPlan(base: Snapshot, plan: ChangePlan): Record<string, MergedFile> {
  const work = new Map<string, MergedFile>();
  for (const [id, e] of Object.entries(base)) {
    work.set(id, { id, path: e.path, fields: { ...e.fields } });
  }

  const assertUniquePaths = (): void => {
    const seen = new Map<string, string>();
    for (const f of work.values()) {
      const owner = seen.get(f.path);
      if (owner !== undefined) {
        throw new Error(`路径冲突: "${f.path}" 同时被 ${owner} 与 ${f.id} 占用`);
      }
      seen.set(f.path, f.id);
    }
  };

  assertUniquePaths();
  for (const op of plan.ops) {
    switch (op.op) {
      case 'delete':
        if (!work.delete(op.id)) throw new Error(`delete: 文件不存在 ${op.id}`);
        break;
      case 'move': {
        const f = work.get(op.id);
        if (!f) throw new Error(`move: 文件不存在 ${op.id}`);
        f.path = op.path;
        break;
      }
      case 'create':
        if (work.has(op.id)) throw new Error(`create: 文件已存在 ${op.id}`);
        work.set(op.id, { id: op.id, path: op.path, fields: { ...op.fields } });
        break;
      case 'update': {
        const f = work.get(op.id);
        if (!f) throw new Error(`update: 文件不存在 ${op.id}`);
        f.path = op.path;
        f.fields = { ...op.fields };
        break;
      }
    }
    assertUniquePaths();
  }
  for (const f of work.values()) {
    if (f.path.startsWith(TMP_PREFIX)) throw new Error(`临时路径未回收: ${f.id}`);
  }
  return Object.fromEntries(work);
}

/** 核对计划：应用到 base 后必须与 merged 完全一致，否则抛错。 */
export function verifyPlan(base: Snapshot, merged: Record<string, MergedFile>, plan: ChangePlan): void {
  const got = applyPlan(base, plan);
  const wantIds = Object.keys(merged).sort();
  const gotIds = Object.keys(got).sort();
  if (JSON.stringify(wantIds) !== JSON.stringify(gotIds)) {
    throw new Error(`计划结果文件集不一致: 期望 [${wantIds}] 实际 [${gotIds}]`);
  }
  for (const id of wantIds) {
    const g = got[id] as MergedFile;
    const m = merged[id] as MergedFile;
    if (g.path !== m.path || !fieldsEqual(g.fields, m.fields)) {
      throw new Error(`计划结果与合并结果不一致: ${id}`);
    }
  }
}
