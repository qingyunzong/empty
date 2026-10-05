import { createHash } from 'node:crypto';
import { entriesEqual, fieldsEqual, FileEntry, MergedFile, Snapshot } from './model.js';

export type ConflictKind = 'field' | 'rename' | 'delete-modify' | 'path-occupation';

export interface Conflict {
  /** 稳定冲突 ID：同一冲突情形跨多次合并保持一致，用于匹配已登记的解决方案。 */
  id: string;
  kind: ConflictKind;
  fileIds: string[];
  /** 冲突所涉 base/local/remote 条目（含版本号）的摘要；源版本变化则指纹变化。 */
  fingerprint: string;
  detail: Record<string, unknown>;
}

export interface ResolutionChoice {
  /** field/rename 冲突：选用某一侧的值。 */
  side?: 'local' | 'remote';
  /** field 冲突：显式取值。 */
  value?: string;
  /** rename 冲突：显式取路径。 */
  path?: string;
  /** delete-modify 冲突：删除，或保留修改侧。 */
  action?: 'delete' | 'keep';
  /** path-occupation 冲突：为涉及的每个文件显式指定最终路径。 */
  paths?: Record<string, string>;
}

export interface Resolution {
  conflictId: string;
  /** 做出选择时所基于的冲突指纹。 */
  fingerprint: string;
  choice: ResolutionChoice;
}

export interface MergeInput {
  base: Snapshot;
  local: Snapshot;
  remote: Snapshot;
  resolutions?: Resolution[];
}

export interface MergeResult {
  /** 合并后的文件状态（已应用有效解决方案；未解决冲突处为临时取值）。 */
  state: Record<string, MergedFile>;
  /** 仍未解决的冲突。 */
  conflicts: Conflict[];
  /** 本次被应用的解决方案。 */
  applied: Resolution[];
  /** 因源版本变化、指纹不再匹配而被撤销的过时解决方案。 */
  stale: Resolution[];
}

function fingerprintOf(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

export function merge(input: MergeInput): MergeResult {
  const { base, local, remote } = input;
  const conflicts: Conflict[] = [];
  const applied: Resolution[] = [];
  const stale: Resolution[] = [];
  const resById = new Map<string, Resolution>();
  for (const r of input.resolutions ?? []) resById.set(r.conflictId, r);
  const consumed = new Set<string>();
  const state: Record<string, MergedFile> = {};
  const pathUndecided = new Set<string>();

  const takeResolution = (c: Conflict): Resolution | undefined => {
    const res = resById.get(c.id);
    if (!res || consumed.has(c.id)) return undefined;
    consumed.add(c.id);
    if (res.fingerprint !== c.fingerprint) {
      stale.push(res);
      return undefined;
    }
    applied.push(res);
    return res;
  };

  const ids = [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])].sort();

  for (const id of ids) {
    const b = base[id];
    const l = local[id];
    const r = remote[id];

    if (!l && !r) continue; // 双侧均已删除（或从未存在）

    if (!l || !r) {
      const survivor = (l ?? r) as FileEntry;
      if (!b) {
        state[id] = { id, path: survivor.path, fields: { ...survivor.fields } };
        continue;
      }
      if (entriesEqual(b, survivor)) continue; // 一侧删除、另一侧未改动 -> 删除
      const c: Conflict = {
        id: `delete-modify:${id}`,
        kind: 'delete-modify',
        fileIds: [id],
        fingerprint: fingerprintOf(b, l ?? null, r ?? null),
        detail: {
          deletedOn: l ? 'remote' : 'local',
          modifiedOn: l ? 'local' : 'remote',
          survivor,
        },
      };
      const res = takeResolution(c);
      if (res) {
        if (res.choice.action === 'keep') {
          state[id] = { id, path: survivor.path, fields: { ...survivor.fields } };
        } // action === 'delete' -> 不放入结果
      } else {
        conflicts.push(c);
        state[id] = { id, path: survivor.path, fields: { ...survivor.fields } }; // 临时保留
      }
      continue;
    }

    // 双侧均存在：逐文件三方模型
    const fp = fingerprintOf(b ?? null, l, r);
    const out: MergedFile = { id, path: '', fields: {} };

    // 路径三方合并
    if (l.path === r.path) {
      out.path = l.path;
    } else if (b && l.path === b.path) {
      out.path = r.path;
    } else if (b && r.path === b.path) {
      out.path = l.path;
    } else {
      const c: Conflict = {
        id: `rename:${id}`,
        kind: 'rename',
        fileIds: [id],
        fingerprint: fp,
        detail: { basePath: b?.path ?? null, localPath: l.path, remotePath: r.path },
      };
      const res = takeResolution(c);
      if (res) {
        out.path = res.choice.path ?? (res.choice.side === 'remote' ? r.path : l.path);
      } else {
        conflicts.push(c);
        pathUndecided.add(id);
        out.path = b?.path ?? l.path; // 临时取值
      }
    }

    // 字段级三方合并：不同字段的修改可自动合并
    const keys = new Set([
      ...Object.keys(b?.fields ?? {}),
      ...Object.keys(l.fields),
      ...Object.keys(r.fields),
    ]);
    for (const key of [...keys].sort()) {
      const bv = b?.fields[key];
      const lv = l.fields[key];
      const rv = r.fields[key];
      if (lv === rv) {
        if (lv !== undefined) out.fields[key] = lv;
        continue;
      }
      if (lv === bv) {
        if (rv !== undefined) out.fields[key] = rv;
        continue;
      }
      if (rv === bv) {
        if (lv !== undefined) out.fields[key] = lv;
        continue;
      }
      const c: Conflict = {
        id: `field:${id}:${key}`,
        kind: 'field',
        fileIds: [id],
        fingerprint: fp,
        detail: { field: key, base: bv ?? null, local: lv ?? null, remote: rv ?? null },
      };
      const res = takeResolution(c);
      if (res) {
        const v = res.choice.value !== undefined ? res.choice.value : res.choice.side === 'remote' ? rv : lv;
        if (v !== undefined) out.fields[key] = v;
      } else {
        conflicts.push(c);
        if (lv !== undefined) out.fields[key] = lv; // 临时取值
      }
    }

    state[id] = out;
  }

  // 同目标路径占用检测（路径未定的文件不参与，避免误报）
  const reported = new Set<string>();
  const dupGroups = (): string[][] => {
    const byPath = new Map<string, string[]>();
    for (const f of Object.values(state)) {
      if (pathUndecided.has(f.id)) continue;
      const list = byPath.get(f.path) ?? [];
      list.push(f.id);
      byPath.set(f.path, list);
    }
    return [...byPath.values()].filter((g) => g.length > 1).map((g) => [...g].sort());
  };

  for (const group of dupGroups()) {
    const c: Conflict = {
      id: `paths:${group.join('+')}`,
      kind: 'path-occupation',
      fileIds: group,
      fingerprint: fingerprintOf(group.map((id) => [base[id] ?? null, local[id] ?? null, remote[id] ?? null])),
      detail: { path: state[group[0] as string]?.path, occupants: group },
    };
    const res = takeResolution(c);
    if (res && res.choice.paths) {
      for (const [fid, p] of Object.entries(res.choice.paths)) {
        const f = state[fid];
        if (f) f.path = p;
      }
      // 应用后仍可能与他者冲突，交由第二轮检测
    } else {
      conflicts.push(c);
      reported.add(c.id);
    }
  }
  // 第二轮：解决方案应用后重新核对路径唯一性
  for (const group of dupGroups()) {
    const id = `paths:${group.join('+')}`;
    if (reported.has(id)) continue;
    conflicts.push({
      id,
      kind: 'path-occupation',
      fileIds: group,
      fingerprint: fingerprintOf(group.map((fid) => [base[fid] ?? null, local[fid] ?? null, remote[fid] ?? null])),
      detail: { path: state[group[0] as string]?.path, occupants: group },
    });
  }

  return { state, conflicts, applied, stale };
}
