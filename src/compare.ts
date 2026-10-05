import { allocate } from './allocator.ts';
import { unitModelAllocate } from './unit-model.ts';
import type { AllocationResult, UserInput } from './allocator.ts';

export interface ComparisonRow {
  id: string;
  /** 逐轮模型整数分配 */
  roundModel: number;
  /** 逐单位模型整数分配 */
  unitModel: number;
  /** roundModel - unitModel */
  diff: number;
  /** 逐轮模型的精确分数应得 */
  fractional: string;
}

export interface ComparisonReport {
  rows: ComparisonRow[];
  maxAbsDiff: number;
  roundModelTotal: number;
  unitModelTotal: number;
}

/** 逐轮模型与逐单位小容量模型的逐户对照。 */
export function compareWithUnitModel(
  capacity: number,
  users: UserInput[],
  result?: AllocationResult,
): ComparisonReport {
  const res = result ?? allocate(capacity, users);
  const unit = unitModelAllocate(capacity, users);
  const ids = users.map((u) => u.id).sort();
  const rows: ComparisonRow[] = ids.map((id) => {
    const roundModel = res.allocation[id] ?? 0;
    const unitModel = unit[id] ?? 0;
    return {
      id,
      roundModel,
      unitModel,
      diff: roundModel - unitModel,
      fractional: res.fractional[id] ?? '0',
    };
  });
  return {
    rows,
    maxAbsDiff: rows.reduce((acc, r) => Math.max(acc, Math.abs(r.diff)), 0),
    roundModelTotal: rows.reduce((acc, r) => acc + r.roundModel, 0),
    unitModelTotal: rows.reduce((acc, r) => acc + r.unitModel, 0),
  };
}
