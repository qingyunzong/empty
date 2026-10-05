/**
 * 制品清单三向合并库。
 *
 * 输入：共同祖先 base 与两个分支 ours / theirs。
 * 对象身份由 id 决定，路径只是属性，因此“移动”通过同一 id 的路径变化识别。
 * 输出：合并结果、冲突列表，以及一份可逆计划（可把 base 变为 merged，并可逆向回滚）。
 */

export interface ArtifactEntry {
  /** 对象 ID，跨清单稳定，是识别同一制品（含移动）的唯一依据。 */
  id: string;
  /** 制品所在路径，可被任一分支修改（移动/改名）。 */
  path: string;
  /** 内容摘要（ digest ），代表制品内容版本。 */
  digest: string;
}

export type Manifest = readonly ArtifactEntry[];

export interface MergeInput {
  base: Manifest;
  ours: Manifest;
  theirs: Manifest;
}

export type ConflictType =
  | "digest-conflict" // 双侧把同一对象改成不同摘要
  | "move-conflict" // 双侧把同一对象移到不同路径
  | "delete-modify" // 一侧删除、另一侧修改（摘要或路径）
  | "add-add" // 双侧新增同一 id 但内容不一致
  | "path-collision"; // 移动/新增撞名：多个对象抢占同一路径，不自动覆盖

export interface Conflict {
  type: ConflictType;
  id: string;
  /** path-collision 时被争抢的路径。 */
  path?: string;
  /** path-collision 时与本对象抢名的其他对象 id。 */
  collidesWith?: string[];
  base?: ArtifactEntry;
  ours?: ArtifactEntry;
  theirs?: ArtifactEntry;
  message: string;
}

/** 计划操作：把 base 逐步变为 merged。每个操作都携带逆操作所需的全部信息。 */
export type PlanOp =
  | { op: "add"; entry: ArtifactEntry }
  | { op: "remove"; entry: ArtifactEntry } // entry 为被移除前的完整记录
  | { op: "update"; id: string; before: ArtifactEntry; after: ArtifactEntry };

export interface MergeResult {
  /** 合并成功的条目（按 id 排序）；冲突条目不出现在这里。 */
  merged: ArtifactEntry[];
  /** 全部冲突，含三侧快照，便于人工裁决。 */
  conflicts: Conflict[];
  /** 可逆计划：applyPlan(base, plan) === merged。 */
  plan: PlanOp[];
}

type FieldOutcome = { kind: "value"; value: string } | { kind: "conflict" };

/** 单字段三向合并：双侧相同取其一；仅一侧改动取该侧；双侧不同改动则冲突。 */
function mergeField(base: string, ours: string, theirs: string): FieldOutcome {
  if (ours === theirs) return { kind: "value", value: ours };
  if (ours === base) return { kind: "value", value: theirs };
  if (theirs === base) return { kind: "value", value: ours };
  return { kind: "conflict" };
}

function indexById(manifest: Manifest, label: string): Map<string, ArtifactEntry> {
  const map = new Map<string, ArtifactEntry>();
  for (const entry of manifest) {
    if (map.has(entry.id)) {
      throw new Error(`${label}: duplicate object id "${entry.id}"`);
    }
    map.set(entry.id, entry);
  }
  return map;
}

function sameEntry(a: ArtifactEntry, b: ArtifactEntry): boolean {
  return a.path === b.path && a.digest === b.digest;
}

function byId(a: ArtifactEntry, b: ArtifactEntry): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function opId(op: PlanOp): string {
  return op.op === "update" ? op.id : op.entry.id;
}

export function mergeManifests(input: MergeInput): MergeResult {
  const baseById = indexById(input.base, "base");
  const oursById = indexById(input.ours, "ours");
  const theirsById = indexById(input.theirs, "theirs");

  const conflicts: Conflict[] = [];
  const plan: PlanOp[] = [];
  const survivors = new Map<string, ArtifactEntry>();

  const ids = [...new Set([...baseById.keys(), ...oursById.keys(), ...theirsById.keys()])].sort();

  // 第一阶段：逐 ID 独立裁决，不依赖其他对象。
  for (const id of ids) {
    const b = baseById.get(id);
    const o = oursById.get(id);
    const t = theirsById.get(id);

    if (b && o && t) {
      // 三侧都在：摘要与路径分别按三向规则合并。
      const digest = mergeField(b.digest, o.digest, t.digest);
      const path = mergeField(b.path, o.path, t.path);
      let failed = false;
      if (digest.kind === "conflict") {
        conflicts.push({
          type: "digest-conflict",
          id,
          base: b,
          ours: o,
          theirs: t,
          message: `object "${id}": both sides changed digest to different values`,
        });
        failed = true;
      }
      if (path.kind === "conflict") {
        conflicts.push({
          type: "move-conflict",
          id,
          base: b,
          ours: o,
          theirs: t,
          message: `object "${id}": both sides moved it to different paths`,
        });
        failed = true;
      }
      if (failed) continue;
      const entry: ArtifactEntry = {
        id,
        path: (path as { kind: "value"; value: string }).value,
        digest: (digest as { kind: "value"; value: string }).value,
      };
      survivors.set(id, entry);
      if (!sameEntry(entry, b)) {
        plan.push({ op: "update", id, before: b, after: entry });
      }
    } else if (b && !o && !t) {
      // 双侧都删除。
      plan.push({ op: "remove", entry: b });
    } else if (b && o && !t) {
      // theirs 删除：ours 未动则接受删除，否则删除-修改冲突。
      if (sameEntry(o, b)) {
        plan.push({ op: "remove", entry: b });
      } else {
        conflicts.push({
          type: "delete-modify",
          id,
          base: b,
          ours: o,
          message: `object "${id}": deleted by theirs but modified by ours`,
        });
      }
    } else if (b && !o && t) {
      // ours 删除：对称处理。
      if (sameEntry(t, b)) {
        plan.push({ op: "remove", entry: b });
      } else {
        conflicts.push({
          type: "delete-modify",
          id,
          base: b,
          theirs: t,
          message: `object "${id}": deleted by ours but modified by theirs`,
        });
      }
    } else if (!b && o && !t) {
      // 仅 ours 新增。
      survivors.set(id, o);
      plan.push({ op: "add", entry: o });
    } else if (!b && !o && t) {
      // 仅 theirs 新增。
      survivors.set(id, t);
      plan.push({ op: "add", entry: t });
    } else if (!b && o && t) {
      // 双侧新增同一 id：完全一致才合并，否则冲突。
      if (sameEntry(o, t)) {
        survivors.set(id, o);
        plan.push({ op: "add", entry: o });
      } else {
        conflicts.push({
          type: "add-add",
          id,
          ours: o,
          theirs: t,
          message: `object "${id}": added on both sides with different content`,
        });
      }
    }
  }

  // 第二阶段：跨 ID 撞名检查。移动/新增落到已被占用的路径时不自动覆盖，
  // 涉及的全部对象都记为冲突并移出合并结果与计划。
  const idsByPath = new Map<string, string[]>();
  for (const entry of survivors.values()) {
    const list = idsByPath.get(entry.path);
    if (list) list.push(entry.id);
    else idsByPath.set(entry.path, [entry.id]);
  }
  const collided = new Set<string>();
  for (const path of [...idsByPath.keys()].sort()) {
    const owners = idsByPath.get(path)!;
    if (owners.length < 2) continue;
    owners.sort();
    for (const id of owners) {
      collided.add(id);
      conflicts.push({
        type: "path-collision",
        id,
        path,
        collidesWith: owners.filter((other) => other !== id),
        base: baseById.get(id),
        ours: oursById.get(id),
        theirs: theirsById.get(id),
        message: `path "${path}" claimed by ${owners.join(", ")}; refusing to overwrite`,
      });
    }
  }
  for (const id of collided) survivors.delete(id);
  const finalPlan = collided.size === 0 ? plan : plan.filter((op) => !collided.has(opId(op)));

  return {
    merged: [...survivors.values()].sort(byId),
    conflicts,
    plan: finalPlan,
  };
}

/** 应用计划：把一份清单变为另一份。按 id 寻址，与路径无关。 */
export function applyPlan(manifest: Manifest, plan: readonly PlanOp[]): ArtifactEntry[] {
  const byIdMap = indexById(manifest, "manifest");
  for (const op of plan) {
    switch (op.op) {
      case "add":
        byIdMap.set(op.entry.id, op.entry);
        break;
      case "remove":
        byIdMap.delete(op.entry.id);
        break;
      case "update":
        byIdMap.set(op.id, op.after);
        break;
    }
  }
  return [...byIdMap.values()].sort(byId);
}

/** 生成逆计划：applyPlan(merged, invertPlan(plan)) 可还原 base。 */
export function invertPlan(plan: readonly PlanOp[]): PlanOp[] {
  const inverse: PlanOp[] = [];
  for (let i = plan.length - 1; i >= 0; i--) {
    const op = plan[i];
    switch (op.op) {
      case "add":
        inverse.push({ op: "remove", entry: op.entry });
        break;
      case "remove":
        inverse.push({ op: "add", entry: op.entry });
        break;
      case "update":
        inverse.push({ op: "update", id: op.id, before: op.after, after: op.before });
        break;
    }
  }
  return inverse;
}
