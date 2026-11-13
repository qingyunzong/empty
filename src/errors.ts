import type { KeyGroupRange } from "./keyGroups.js";

export type SavepointMappingErrorCode =
  | "MISSING_UID"
  | "DUPLICATE_UID"
  | "UNMATCHED_UID"
  | "INCOMPATIBLE_SCHEMA"
  | "MAX_PARALLELISM_MISMATCH"
  | "INVALID_PARALLELISM"
  | "INVALID_SAVEPOINT"
  | "KEY_GROUP_COVERAGE";

/** 映射被阻断时抛出，message 中携带具体原因与定位信息。 */
export class SavepointMappingError extends Error {
  readonly code: SavepointMappingErrorCode;
  constructor(code: SavepointMappingErrorCode, message: string) {
    super(message);
    this.name = "SavepointMappingError";
    this.code = code;
  }
}

export function missingUid(context: string): SavepointMappingError {
  return new SavepointMappingError(
    "MISSING_UID",
    `${context}：operator 缺少稳定 UID，无法把 savepoint 状态对应到作业拓扑；` +
      `请为算子设置 uid() 后重新生成 savepoint`,
  );
}

export function duplicateUid(uid: string, context: string): SavepointMappingError {
  return new SavepointMappingError(
    "DUPLICATE_UID",
    `${context}：operator UID "${uid}" 出现多次，状态归属存在歧义；` +
      `请保证 UID 在拓扑内唯一`,
  );
}

export function unmatchedUid(uid: string): SavepointMappingError {
  return new SavepointMappingError(
    "UNMATCHED_UID",
    `目标作业声明的 UID "${uid}" 在 savepoint 中不存在；` +
      `若是新增算子请从映射请求中移除，若 UID 被改动请恢复稳定 UID`,
  );
}

export interface SchemaMismatchDetail {
  field: string;
  savepointValue: string;
  jobValue: string;
}

export function incompatibleSchema(
  uid: string,
  mismatches: readonly SchemaMismatchDetail[],
): SavepointMappingError {
  const detail = mismatches
    .map((m) => `${m.field}: savepoint=${m.savepointValue} vs job=${m.jobValue}`)
    .join("; ");
  return new SavepointMappingError(
    "INCOMPATIBLE_SCHEMA",
    `operator "${uid}" 状态 schema 不兼容（${detail}）；` +
      `请提供状态迁移或回退到兼容的 schema`,
  );
}

export function maxParallelismMismatch(
  uid: string,
  savepointMax: number,
  jobMax: number,
): SavepointMappingError {
  return new SavepointMappingError(
    "MAX_PARALLELISM_MISMATCH",
    `operator "${uid}" 的 maxParallelism 不可变更：savepoint=${savepointMax}，` +
      `目标作业=${jobMax}；key-group 空间必须保持一致才能恢复`,
  );
}

export function invalidParallelism(
  uid: string,
  parallelism: number,
  maxParallelism: number,
): SavepointMappingError {
  return new SavepointMappingError(
    "INVALID_PARALLELISM",
    `operator "${uid}" 目标并行度 ${parallelism} 非法：` +
      `必须为 [1, maxParallelism=${maxParallelism}] 内的整数`,
  );
}

export function invalidSavepoint(uid: string, reason: string): SavepointMappingError {
  return new SavepointMappingError(
    "INVALID_SAVEPOINT",
    `operator "${uid}" 的 savepoint 状态非法：${reason}`,
  );
}

export function keyGroupCoverage(
  uid: string,
  ranges: readonly KeyGroupRange[],
  maxParallelism: number,
  violation: string,
): SavepointMappingError {
  const desc = ranges.map((r) => `[${r.start}, ${r.end}]`).join(", ");
  return new SavepointMappingError(
    "KEY_GROUP_COVERAGE",
    `operator "${uid}" 重分配后 key-group 未满足“恰好一次”：${violation}；` +
      `区间=${desc}，key-group 空间=[0, ${maxParallelism - 1}]`,
  );
}
