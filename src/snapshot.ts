import type { Row } from './conditions.js';
import { evalFieldPolicy, evalPolicy, type Policy } from './policy.js';
import type { TV } from './trivalent.js';

export interface RowDecision {
  id: Row['id'];
  access: TV;
  fields: Record<string, TV>;
}

export interface Snapshot {
  decisions: RowDecision[];
}

export function buildSnapshot(table: Row[], policy: Policy): Snapshot {
  const decisions: RowDecision[] = table.map((row) => {
    const fields: Record<string, TV> = {};
    for (const fp of policy.fields ?? []) {
      fields[fp.field] = evalFieldPolicy(fp, row);
    }
    return { id: row.id, access: evalPolicy(policy, row), fields };
  });
  return { decisions };
}
