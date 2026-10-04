export type FieldValue = string | number | boolean | null;
export type ProjectFields = Record<string, FieldValue>;
export type Snapshot = Record<string, ProjectFields>;

export type MergeMode = "strict" | "auto";
export type ResolutionPick = "source" | "target" | "value";

export interface FieldResolution {
  project: string;
  field: string;
  pick: ResolutionPick;
  value?: FieldValue;
}

export interface SyncOptions {
  mode?: MergeMode;
  resolutions?: FieldResolution[];
}

export type Cell = { present: true; value: FieldValue } | { present: false };

export type FieldAction =
  | "unchanged"
  | "take-source"
  | "keep-target"
  | "agreed"
  | "resolved-source"
  | "resolved-target"
  | "resolved-value"
  | "unresolved";

export interface FieldDecision {
  field: string;
  action: FieldAction;
  base: Cell;
  source: Cell;
  target: Cell;
  final: Cell;
  note: string;
}

export type ItemStatus = "added" | "updated" | "merged" | "unchanged" | "conflict";

export interface ItemResult {
  project: string;
  status: ItemStatus;
  decisions: FieldDecision[];
  unresolved: string[];
}

export interface ConflictInfo {
  project: string;
  field: string;
  base: Cell;
  source: Cell;
  target: Cell;
}

export interface SyncSummary {
  total: number;
  added: number;
  updated: number;
  merged: number;
  unchanged: number;
  conflict: number;
}

export interface SyncReport {
  mode: MergeMode;
  applied: boolean;
  targetDiverged: boolean;
  items: ItemResult[];
  unresolvedConflicts: ConflictInfo[];
  unusedResolutions: FieldResolution[];
  result?: Snapshot;
  summary: SyncSummary;
}

const KEY_SEP = "\u001f";

const hasOwn = (obj: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

function isFieldValue(value: unknown): value is FieldValue {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "boolean") return true;
  return t === "number" && Number.isFinite(value as number);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertSnapshot(snapshot: unknown, name: string): asserts snapshot is Snapshot {
  if (!isPlainObject(snapshot)) {
    throw new TypeError(`${name} 快照必须是对象（项目 id -> 字段表）`);
  }
  for (const [project, fields] of Object.entries(snapshot)) {
    if (!isPlainObject(fields)) {
      throw new TypeError(`${name}.${project} 必须是字段表对象`);
    }
    for (const [field, value] of Object.entries(fields)) {
      if (!isFieldValue(value)) {
        throw new TypeError(
          `${name}.${project}.${field} 不是合法字段值（仅支持 string/number/boolean/null）`
        );
      }
    }
  }
}

function cellOf(fields: ProjectFields | undefined, key: string): Cell {
  if (fields !== undefined && hasOwn(fields, key)) {
    return { present: true, value: fields[key]! };
  }
  return { present: false };
}

export function cellEq(a: Cell, b: Cell): boolean {
  if (a.present !== b.present) return false;
  return !a.present || a.value === (b as { present: true; value: FieldValue }).value;
}

function snapshotEq(a: Snapshot, b: Snapshot): boolean {
  const projects = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const project of projects) {
    const fa = a[project];
    const fb = b[project];
    const fields = new Set([...Object.keys(fa ?? {}), ...Object.keys(fb ?? {})]);
    for (const field of fields) {
      if (!cellEq(cellOf(fa, field), cellOf(fb, field))) return false;
    }
  }
  return true;
}

function validateResolutions(resolutions: FieldResolution[]): Map<string, FieldResolution> {
  const map = new Map<string, FieldResolution>();
  for (const res of resolutions) {
    if (!isPlainObject(res) || typeof res.project !== "string" || typeof res.field !== "string") {
      throw new TypeError("决议必须包含字符串类型的 project 与 field");
    }
    if (res.pick !== "source" && res.pick !== "target" && res.pick !== "value") {
      throw new TypeError(`决议 ${res.project}.${res.field} 的 pick 必须是 source/target/value`);
    }
    if (res.pick === "value" && !isFieldValue(res.value)) {
      throw new TypeError(`决议 ${res.project}.${res.field} 选择 value 时必须提供合法 value`);
    }
    const key = `${res.project}${KEY_SEP}${res.field}`;
    if (map.has(key)) {
      throw new TypeError(`决议重复: ${res.project}.${res.field}`);
    }
    map.set(key, res);
  }
  return map;
}

const NOTE_UNCHANGED = "三方一致，无需变更";
const NOTE_AGREED = "源与目标改为一致，采用该值";
const NOTE_TAKE_SOURCE = "目标未偏离基线，采用源值";
const NOTE_KEEP_TARGET = "源未改动该字段，保留目标本地修改";
const NOTE_RES_SOURCE = "显式决议：采用源值";
const NOTE_RES_TARGET = "显式决议：保留目标值";
const NOTE_RES_VALUE = "显式决议：采用指定值";
const NOTE_UNRESOLVED_BOTH = "源与目标均偏离基线且不一致，缺少显式决议";
const NOTE_UNRESOLVED_TARGET = "目标本地修改与源不一致，缺少显式决议";

export function syncImport(
  base: Snapshot,
  source: Snapshot,
  target: Snapshot,
  options: SyncOptions = {}
): SyncReport {
  const mode: MergeMode = options.mode ?? "strict";
  if (mode !== "strict" && mode !== "auto") {
    throw new TypeError(`未知合并模式: ${String(mode)}`);
  }
  assertSnapshot(base, "base");
  assertSnapshot(source, "source");
  assertSnapshot(target, "target");
  const resolutions = options.resolutions ?? [];
  const resMap = validateResolutions(resolutions);

  const targetDiverged = !snapshotEq(base, target);

  const items: ItemResult[] = [];
  const unresolvedConflicts: ConflictInfo[] = [];
  const usedKeys = new Set<string>();
  const finals: Array<{ project: string; field: string; cell: Cell }> = [];

  for (const project of Object.keys(source).sort()) {
    const baseFields = base[project];
    const sourceFields = source[project]!;
    const targetFields = target[project];
    const fieldNames = Array.from(
      new Set([...Object.keys(baseFields ?? {}), ...Object.keys(sourceFields)])
    ).sort();

    const decisions: FieldDecision[] = [];
    const unresolved: string[] = [];

    for (const field of fieldNames) {
      const b = cellOf(baseFields, field);
      const s = cellOf(sourceFields, field);
      const t = cellOf(targetFields, field);
      const key = `${project}${KEY_SEP}${field}`;
      const res = resMap.get(key);

      let action: FieldAction;
      let final: Cell;
      let note: string;

      if (cellEq(s, t)) {
        final = s;
        if (cellEq(s, b)) {
          action = "unchanged";
          note = NOTE_UNCHANGED;
        } else {
          action = "agreed";
          note = NOTE_AGREED;
        }
      } else if (cellEq(t, b)) {
        final = s;
        action = "take-source";
        note = NOTE_TAKE_SOURCE;
      } else {
        if (res !== undefined) {
          usedKeys.add(key);
          if (res.pick === "source") {
            final = s;
            action = "resolved-source";
            note = NOTE_RES_SOURCE;
          } else if (res.pick === "target") {
            final = t;
            action = "resolved-target";
            note = NOTE_RES_TARGET;
          } else {
            final = { present: true, value: res.value! };
            action = "resolved-value";
            note = NOTE_RES_VALUE;
          }
        } else if (mode === "auto" && cellEq(s, b)) {
          final = t;
          action = "keep-target";
          note = NOTE_KEEP_TARGET;
        } else {
          final = { present: false };
          action = "unresolved";
          note = cellEq(s, b) ? NOTE_UNRESOLVED_TARGET : NOTE_UNRESOLVED_BOTH;
          unresolved.push(field);
          unresolvedConflicts.push({ project, field, base: b, source: s, target: t });
        }
      }

      decisions.push({ field, action, base: b, source: s, target: t, final, note });
      finals.push({ project, field, cell: final });
    }

    const changed = decisions.some(
      (d) => d.action !== "unresolved" && !cellEq(d.final, d.base)
    );
    const mergedVia = decisions.some(
      (d) =>
        d.action === "resolved-source" ||
        d.action === "resolved-target" ||
        d.action === "resolved-value" ||
        d.action === "keep-target"
    );
    const status: ItemStatus =
      unresolved.length > 0
        ? "conflict"
        : !hasOwn(base, project)
          ? "added"
          : mergedVia
            ? "merged"
            : changed
              ? "updated"
              : "unchanged";

    items.push({ project, status, decisions, unresolved });
  }

  const applied = unresolvedConflicts.length === 0;
  let result: Snapshot | undefined;
  if (applied) {
    result = structuredClone(target);
    for (const { project, field, cell } of finals) {
      if (cell.present) {
        (result[project] ??= {})[field] = cell.value;
      } else {
        const fields = result[project];
        if (fields !== undefined) delete fields[field];
      }
    }
  }

  const summary: SyncSummary = {
    total: items.length,
    added: 0,
    updated: 0,
    merged: 0,
    unchanged: 0,
    conflict: 0,
  };
  for (const item of items) summary[item.status] += 1;

  const unusedResolutions = resolutions.filter(
    (res) => !usedKeys.has(`${res.project}${KEY_SEP}${res.field}`)
  );

  return {
    mode,
    applied,
    targetDiverged,
    items,
    unresolvedConflicts,
    unusedResolutions,
    result,
    summary,
  };
}

const STATUS_LABEL: Record<ItemStatus, string> = {
  added: "新增",
  updated: "更新",
  merged: "合并",
  unchanged: "未变",
  conflict: "冲突",
};

const ACTION_LABEL: Record<FieldAction, string> = {
  unchanged: "保持不变",
  "take-source": "采用源值",
  "keep-target": "保留目标本地修改",
  agreed: "双方一致",
  "resolved-source": "显式决议→源值",
  "resolved-target": "显式决议→目标值",
  "resolved-value": "显式决议→指定值",
  unresolved: "未解决",
};

function fmtCell(cell: Cell): string {
  return cell.present ? JSON.stringify(cell.value) : "(缺失)";
}

export function formatReport(report: SyncReport): string {
  const lines: string[] = [];
  const s = report.summary;
  lines.push(`同步导入报告（模式: ${report.mode}）`);
  lines.push(
    `目标偏离基线: ${report.targetDiverged ? "是" : "否"}；批次已应用: ${report.applied ? "是" : "否"}`
  );
  lines.push(
    `项目共 ${s.total} 项：新增 ${s.added}，更新 ${s.updated}，合并 ${s.merged}，未变 ${s.unchanged}，冲突 ${s.conflict}`
  );
  lines.push("逐项决议:");
  for (const item of report.items) {
    lines.push(`  [${STATUS_LABEL[item.status]}] ${item.project}`);
    for (const d of item.decisions) {
      const finalPart =
        d.action === "unresolved"
          ? ""
          : `；最终=${d.final.present ? JSON.stringify(d.final.value) : "(删除)"}`;
      lines.push(
        `    ${d.field}: 基线=${fmtCell(d.base)} 源=${fmtCell(d.source)} 目标=${fmtCell(d.target)} -> ${ACTION_LABEL[d.action]}${finalPart}（${d.note}）`
      );
    }
  }
  if (report.unresolvedConflicts.length > 0) {
    lines.push(`未解冲突 (${report.unresolvedConflicts.length}):`);
    for (const c of report.unresolvedConflicts) {
      lines.push(
        `  ${c.project}.${c.field}: 基线=${fmtCell(c.base)} 源=${fmtCell(c.source)} 目标=${fmtCell(c.target)}（需要显式字段决议）`
      );
    }
  } else {
    lines.push("未解冲突: 无");
  }
  if (report.unusedResolutions.length > 0) {
    lines.push(`未使用的决议 (${report.unusedResolutions.length}):`);
    for (const r of report.unusedResolutions) {
      lines.push(`  ${r.project}.${r.field}（该字段无需决议）`);
    }
  }
  return lines.join("\n");
}
