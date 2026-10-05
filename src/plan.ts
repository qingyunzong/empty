import { equal } from './canonical.js';
import type { ChangePlan, DocFile, FieldValue, Snapshot } from './types.js';

function cloneFile(file: DocFile): DocFile {
  return { id: file.id, path: file.path, fields: { ...file.fields } };
}

export function buildPlan(local: Snapshot, merged: Snapshot): ChangePlan {
  const plan: ChangePlan = { atomic: true, ops: [] };

  for (const id of Object.keys(merged.files).sort()) {
    const target = merged.files[id]!;
    const current = local.files[id];
    if (!current) {
      plan.ops.push({ op: 'create', file: cloneFile(target) });
      continue;
    }
    if (current.path !== target.path) {
      plan.ops.push({ op: 'move', id, from: current.path, to: target.path });
    }
    const set: Record<string, FieldValue> = {};
    const unset: string[] = [];
    for (const key of Object.keys(target.fields).sort()) {
      if (
        !Object.prototype.hasOwnProperty.call(current.fields, key) ||
        !equal(current.fields[key], target.fields[key])
      ) {
        set[key] = target.fields[key]!;
      }
    }
    for (const key of Object.keys(current.fields).sort()) {
      if (!Object.prototype.hasOwnProperty.call(target.fields, key)) {
        unset.push(key);
      }
    }
    if (Object.keys(set).length > 0 || unset.length > 0) {
      plan.ops.push({ op: 'update', id, set, unset });
    }
  }

  for (const id of Object.keys(local.files).sort()) {
    if (!merged.files[id]) {
      plan.ops.push({ op: 'delete', id });
    }
  }

  return plan;
}

export function applyPlan(local: Snapshot, plan: ChangePlan): Snapshot {
  const files: Record<string, DocFile> = {};
  for (const [id, file] of Object.entries(local.files)) {
    files[id] = cloneFile(file);
  }

  for (const op of plan.ops) {
    switch (op.op) {
      case 'create': {
        if (files[op.file.id]) {
          throw new Error(`plan precondition failed: file "${op.file.id}" already exists`);
        }
        files[op.file.id] = cloneFile(op.file);
        break;
      }
      case 'delete': {
        if (!files[op.id]) {
          throw new Error(`plan precondition failed: file "${op.id}" does not exist`);
        }
        delete files[op.id];
        break;
      }
      case 'move': {
        const file = files[op.id];
        if (!file) {
          throw new Error(`plan precondition failed: file "${op.id}" does not exist`);
        }
        if (file.path !== op.from) {
          throw new Error(
            `plan precondition failed: file "${op.id}" is at "${file.path}", expected "${op.from}"`,
          );
        }
        file.path = op.to;
        break;
      }
      case 'update': {
        const file = files[op.id];
        if (!file) {
          throw new Error(`plan precondition failed: file "${op.id}" does not exist`);
        }
        for (const key of op.unset) {
          delete file.fields[key];
        }
        for (const [key, value] of Object.entries(op.set)) {
          file.fields[key] = value;
        }
        break;
      }
    }
  }

  const ownerByPath = new Map<string, string>();
  for (const file of Object.values(files)) {
    const owner = ownerByPath.get(file.path);
    if (owner !== undefined) {
      throw new Error(
        `plan postcondition failed: path "${file.path}" occupied by both "${owner}" and "${file.id}"`,
      );
    }
    ownerByPath.set(file.path, file.id);
  }

  return { files };
}
