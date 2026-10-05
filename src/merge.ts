import { canonical, equal } from './canonical.js';
import { buildPlan } from './plan.js';
import type { ResolutionStore } from './resolution.js';
import type {
  AppliedResolution,
  Conflict,
  DocFile,
  FieldValue,
  MergeResult,
  Resolution,
  ResolutionChoice,
  Snapshot,
} from './types.js';

function cloneFile(file: DocFile): DocFile {
  return { id: file.id, path: file.path, fields: { ...file.fields } };
}

function validateSnapshot(snapshot: Snapshot, name: string): void {
  const ownerByPath = new Map<string, string>();
  for (const file of Object.values(snapshot.files)) {
    const owner = ownerByPath.get(file.path);
    if (owner !== undefined) {
      throw new Error(`${name}: path "${file.path}" is occupied by both "${owner}" and "${file.id}"`);
    }
    ownerByPath.set(file.path, file.id);
  }
}

function hasField(file: DocFile | undefined, key: string): boolean {
  return file !== undefined && Object.prototype.hasOwnProperty.call(file.fields, key);
}

function fieldEqual(a: DocFile | undefined, key: string, b: DocFile | undefined): boolean {
  const hasA = hasField(a, key);
  const hasB = hasField(b, key);
  if (hasA !== hasB) return false;
  if (!hasA) return true;
  return equal(a!.fields[key], b!.fields[key]);
}

function fieldSignaturePart(file: DocFile | undefined, key: string): unknown {
  return hasField(file, key) ? { present: true, value: file!.fields[key] } : { present: false };
}

interface Ctx {
  store: ResolutionStore;
  conflicts: Conflict[];
  resolved: AppliedResolution[];
  revoked: Resolution[];
  usedKeys: Set<string>;
}

function decide(ctx: Ctx, conflict: Conflict): ResolutionChoice | null {
  ctx.usedKeys.add(conflict.key);
  const resolution = ctx.store.get(conflict.key);
  if (!resolution) {
    ctx.conflicts.push(conflict);
    return null;
  }
  if (resolution.signature !== conflict.signature) {
    ctx.store.revoke(conflict.key);
    ctx.revoked.push(resolution);
    ctx.conflicts.push(conflict);
    return null;
  }
  ctx.resolved.push({ conflict, choice: resolution.choice });
  return resolution.choice;
}

type FileOutcome = { kind: 'ok'; file: DocFile | null } | { kind: 'omit' };

function mergeFile(
  ctx: Ctx,
  id: string,
  base: DocFile | undefined,
  local: DocFile | undefined,
  remote: DocFile | undefined,
): FileOutcome {
  const localChanged = !equal(base ?? null, local ?? null);
  const remoteChanged = !equal(base ?? null, remote ?? null);

  if (!localChanged && !remoteChanged) return { kind: 'ok', file: base ? cloneFile(base) : null };
  if (!remoteChanged) return { kind: 'ok', file: local ? cloneFile(local) : null };
  if (!localChanged) return { kind: 'ok', file: remote ? cloneFile(remote) : null };
  if (equal(local ?? null, remote ?? null)) {
    return { kind: 'ok', file: local ? cloneFile(local) : null };
  }

  // Both sides changed the same file in different ways.
  if (!local || !remote) {
    const conflict: Conflict = {
      key: `${id}:delete-vs-modify`,
      kind: 'delete-vs-modify',
      fileIds: [id],
      signature: canonical({ base: base ?? null, local: local ?? null, remote: remote ?? null }),
      message: `file "${id}": deleted on ${local ? 'remote' : 'local'} but modified on ${local ? 'local' : 'remote'}`,
      base: base ?? null,
      local: local ?? null,
      remote: remote ?? null,
    };
    const choice = decide(ctx, conflict);
    if (choice === null) return { kind: 'omit' };
    const winner = choice === 'local' ? local : remote;
    return { kind: 'ok', file: winner ? cloneFile(winner) : null };
  }

  let conflicted = false;

  // Path merge.
  let path: string;
  if (local.path === remote.path) {
    path = local.path;
  } else if (base && local.path === base.path) {
    path = remote.path;
  } else if (base && remote.path === base.path) {
    path = local.path;
  } else {
    const conflict: Conflict = {
      key: `${id}:path`,
      kind: 'path',
      fileIds: [id],
      signature: canonical({
        base: base ? base.path : null,
        local: local.path,
        remote: remote.path,
      }),
      message: `file "${id}": renamed to "${local.path}" on local and "${remote.path}" on remote`,
      base: base ? base.path : null,
      local: local.path,
      remote: remote.path,
    };
    const choice = decide(ctx, conflict);
    if (choice === null) {
      conflicted = true;
      path = base ? base.path : local.path;
    } else {
      path = choice === 'local' ? local.path : remote.path;
    }
  }

  // Field-level merge.
  const fields: Record<string, FieldValue> = {};
  const keys = new Set<string>([
    ...Object.keys(base?.fields ?? {}),
    ...Object.keys(local.fields),
    ...Object.keys(remote.fields),
  ]);
  for (const key of [...keys].sort()) {
    const localFieldChanged = !fieldEqual(base, key, local);
    const remoteFieldChanged = !fieldEqual(base, key, remote);
    if (!localFieldChanged && !remoteFieldChanged) {
      if (hasField(base, key)) fields[key] = base!.fields[key]!;
      continue;
    }
    if (!remoteFieldChanged) {
      if (hasField(local, key)) fields[key] = local.fields[key]!;
      continue;
    }
    if (!localFieldChanged) {
      if (hasField(remote, key)) fields[key] = remote.fields[key]!;
      continue;
    }
    if (fieldEqual(local, key, remote)) {
      if (hasField(local, key)) fields[key] = local.fields[key]!;
      continue;
    }
    const conflict: Conflict = {
      key: `${id}:field:${key}`,
      kind: 'field',
      fileIds: [id],
      signature: canonical({
        field: key,
        base: fieldSignaturePart(base, key),
        local: fieldSignaturePart(local, key),
        remote: fieldSignaturePart(remote, key),
      }),
      message: `file "${id}": field "${key}" changed on both sides`,
      base: fieldSignaturePart(base, key),
      local: fieldSignaturePart(local, key),
      remote: fieldSignaturePart(remote, key),
    };
    const choice = decide(ctx, conflict);
    if (choice === null) {
      conflicted = true;
      continue;
    }
    const winner = choice === 'local' ? local : remote;
    if (hasField(winner, key)) fields[key] = winner.fields[key]!;
  }

  if (conflicted) return { kind: 'omit' };
  return { kind: 'ok', file: { id, path, fields } };
}

function findOccupancy(files: Record<string, DocFile>): Map<string, string[]> {
  const idsByPath = new Map<string, string[]>();
  for (const file of Object.values(files)) {
    const list = idsByPath.get(file.path);
    if (list) list.push(file.id);
    else idsByPath.set(file.path, [file.id]);
  }
  const occupied = new Map<string, string[]>();
  for (const [path, ids] of idsByPath) {
    if (ids.length > 1) occupied.set(path, ids.sort());
  }
  return occupied;
}

export function merge(
  base: Snapshot,
  local: Snapshot,
  remote: Snapshot,
  store: ResolutionStore,
): MergeResult {
  validateSnapshot(base, 'base');
  validateSnapshot(local, 'local');
  validateSnapshot(remote, 'remote');

  const ctx: Ctx = { store, conflicts: [], resolved: [], revoked: [], usedKeys: new Set() };
  const mergedFiles: Record<string, DocFile> = {};

  const ids = [
    ...new Set([...Object.keys(base.files), ...Object.keys(local.files), ...Object.keys(remote.files)]),
  ].sort();
  for (const id of ids) {
    const outcome = mergeFile(ctx, id, base.files[id], local.files[id], remote.files[id]);
    if (outcome.kind === 'ok' && outcome.file) {
      mergedFiles[id] = outcome.file;
    }
  }

  // Resolve same-target-path occupancy across files.
  for (let iteration = 0; iteration < 8; iteration++) {
    const occupied = findOccupancy(mergedFiles);
    if (occupied.size === 0) break;
    let progress = false;
    for (const [path, fileIds] of [...occupied.entries()].sort()) {
      const conflict: Conflict = {
        key: `occupancy:${path}`,
        kind: 'path-occupancy',
        fileIds,
        signature: canonical({
          path,
          files: fileIds.map((id) => ({
            id,
            base: base.files[id]?.path ?? null,
            local: local.files[id]?.path ?? null,
            remote: remote.files[id]?.path ?? null,
          })),
        }),
        message: `path "${path}" is claimed by files ${fileIds.map((id) => `"${id}"`).join(', ')}`,
        base: fileIds.map((id) => base.files[id]?.path ?? null),
        local: fileIds.map((id) => local.files[id]?.path ?? null),
        remote: fileIds.map((id) => remote.files[id]?.path ?? null),
      };
      const choice = decide(ctx, conflict);
      if (choice === null) {
        for (const id of fileIds) {
          delete mergedFiles[id];
        }
        continue;
      }
      for (const id of fileIds) {
        const preferred = choice === 'local' ? local.files[id] : remote.files[id];
        const fallback = choice === 'local' ? remote.files[id] : local.files[id];
        const current = mergedFiles[id]!;
        mergedFiles[id] = { ...current, path: (preferred ?? fallback ?? current).path };
      }
      progress = true;
    }
    if (!progress) break;
  }

  // Revoke resolutions whose conflict no longer reproduces (source versions changed).
  for (const resolution of store.all()) {
    if (!ctx.usedKeys.has(resolution.key)) {
      store.revoke(resolution.key);
      ctx.revoked.push(resolution);
    }
  }

  const merged: Snapshot = { files: mergedFiles };
  const plan = ctx.conflicts.length === 0 ? buildPlan(local, merged) : null;
  return { merged, conflicts: ctx.conflicts, resolved: ctx.resolved, revoked: ctx.revoked, plan };
}
