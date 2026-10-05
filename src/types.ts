/** 单个有效样本：value 为采样值，weight 为输入权重（非负整数）。 */
export interface Sample {
  value: number;
  weight: number;
}

/** 时间位置上的单元：null 表示缺失样本（占时间位置但不计权重）。 */
export type Cell = Sample | null;

export function validateSample(sample: Sample): Sample {
  if (typeof sample.value !== "number" || !Number.isFinite(sample.value)) {
    throw new TypeError("sample value must be a finite number");
  }
  if (!Number.isInteger(sample.weight) || sample.weight < 0) {
    throw new TypeError("sample weight must be a non-negative integer");
  }
  return { value: sample.value, weight: sample.weight };
}

export function cloneCell(cell: Cell): Cell {
  return cell === null ? null : { value: cell.value, weight: cell.weight };
}
