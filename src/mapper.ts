import {
  checkExactOnceCoverage,
  computeKeyGroupRange,
  intersection,
  type KeyGroupRange,
} from "./keyGroups.js";
import {
  SavepointMappingError,
  duplicateUid,
  incompatibleSchema,
  invalidParallelism,
  invalidSavepoint,
  keyGroupCoverage,
  maxParallelismMismatch,
  missingUid,
  unmatchedUid,
  type SchemaMismatchDetail,
} from "./errors.js";

/** 状态 schema 描述：kind/serializer 必须一致，version 默认要求一致。 */
export interface StateSchema {
  kind: string;
  serializer: string;
  version: number;
}

export interface SubtaskState {
  subtaskIndex: number;
  keyGroups: KeyGroupRange;
  /** 状态句柄（如 RocksDB checkpoint 路径），原样透传到映射结果 */
  handle: string;
}

export interface OperatorState {
  uid: string;
  parallelism: number;
  maxParallelism: number;
  schema: StateSchema;
  subtasks: SubtaskState[];
}

export interface Savepoint {
  operators: OperatorState[];
}

export interface OperatorMappingRequest {
  uid: string;
  /** 目标并行度（scale in/out） */
  parallelism: number;
  /** 可选；一旦声明必须与 savepoint 中的 maxParallelism 一致 */
  maxParallelism?: number;
  schema: StateSchema;
  /** 额外接受的 savepoint schema 版本（默认仅接受同版本） */
  acceptedVersions?: number[];
}

export interface MappingRequest {
  operators: OperatorMappingRequest[];
  /**
   * savepoint 中存在、但目标拓扑未引用的算子状态：
   * false（默认）→ 阻断；true → 丢弃并在报告中列出。
   */
  allowNonRestoredState?: boolean;
}

export interface MappedSubtaskState {
  subtaskIndex: number;
  keyGroups: KeyGroupRange;
  /** 贡献到该 subtask 的旧状态句柄（按 subtaskIndex 升序） */
  sourceHandles: string[];
  /** 旧状态被拆分（仅部分 key-group 落入本 subtask）时为 true */
  split: boolean;
}

export interface MappedOperatorState {
  uid: string;
  parallelism: number;
  maxParallelism: number;
  schema: StateSchema;
  subtasks: MappedSubtaskState[];
}

export interface MappingReport {
  /** 目标拓扑未引用、被丢弃状态的 savepoint 算子 UID */
  droppedOperators: string[];
  /** 每个算子的 scale 变化描述 */
  rescales: { uid: string; from: number; to: number }[];
}

export interface MappingResult {
  operators: MappedOperatorState[];
  report: MappingReport;
}

export function mapSavepoint(
  savepoint: Savepoint,
  request: MappingRequest,
): MappingResult {
  const allowNonRestored = request.allowNonRestoredState ?? false;
  const byUid = indexSavepoint(savepoint);
  indexRequest(request);

  const operators: MappedOperatorState[] = [];
  const rescales: MappingReport["rescales"] = [];
  const consumed = new Set<string>();

  for (const spec of request.operators) {
    const old = byUid.get(spec.uid);
    if (!old) throw unmatchedUid(spec.uid);
    consumed.add(spec.uid);

    validateOldOperator(old);
    checkSchema(old, spec);
    const maxParallelism = resolveMaxParallelism(old, spec);
    checkTargetParallelism(spec, maxParallelism);

    const mapped = remapOperator(old, spec.parallelism, maxParallelism);
    operators.push(mapped);
    if (old.parallelism !== spec.parallelism) {
      rescales.push({ uid: old.uid, from: old.parallelism, to: spec.parallelism });
    }
  }

  const dropped = savepoint.operators
    .map((op) => op.uid)
    .filter((uid) => uid && !consumed.has(uid));
  if (dropped.length > 0 && !allowNonRestored) {
    throw new SavepointMappingError(
      "UNMATCHED_UID",
      `savepoint 中的算子 [${dropped.join(", ")}] 未在目标拓扑中声明，` +
        `其状态将被丢弃；确认丢弃请设置 allowNonRestoredState: true`,
    );
  }

  return { operators, report: { droppedOperators: dropped, rescales } };
}

function indexSavepoint(savepoint: Savepoint): Map<string, OperatorState> {
  const byUid = new Map<string, OperatorState>();
  savepoint.operators.forEach((op, i) => {
    if (!op.uid) throw missingUid(`savepoint 第 ${i} 个算子`);
    if (byUid.has(op.uid)) throw duplicateUid(op.uid, "savepoint");
    byUid.set(op.uid, op);
  });
  return byUid;
}

function indexRequest(request: MappingRequest): void {
  const seen = new Set<string>();
  request.operators.forEach((spec, i) => {
    if (!spec.uid) throw missingUid(`映射请求第 ${i} 个算子`);
    if (seen.has(spec.uid)) throw duplicateUid(spec.uid, "映射请求");
    seen.add(spec.uid);
  });
}

function validateOldOperator(op: OperatorState): void {
  if (
    !Number.isInteger(op.parallelism) ||
    op.parallelism < 1 ||
    op.parallelism > op.maxParallelism
  ) {
    throw invalidSavepoint(
      op.uid,
      `parallelism=${op.parallelism} 与 maxParallelism=${op.maxParallelism} 不合法`,
    );
  }
  if (op.subtasks.length !== op.parallelism) {
    throw invalidSavepoint(
      op.uid,
      `subtask 状态数 ${op.subtasks.length} 与 parallelism ${op.parallelism} 不一致`,
    );
  }
  const seen = new Set<number>();
  for (const st of op.subtasks) {
    if (seen.has(st.subtaskIndex)) {
      throw invalidSavepoint(op.uid, `subtaskIndex ${st.subtaskIndex} 重复`);
    }
    seen.add(st.subtaskIndex);
  }
  const violation = checkExactOnceCoverage(
    op.subtasks.map((st) => st.keyGroups),
    op.maxParallelism,
  );
  if (violation) {
    throw invalidSavepoint(op.uid, `旧状态 key-group 覆盖异常：${violation}`);
  }
}

function checkSchema(old: OperatorState, spec: OperatorMappingRequest): void {
  const mismatches: SchemaMismatchDetail[] = [];
  if (old.schema.kind !== spec.schema.kind) {
    mismatches.push({
      field: "kind",
      savepointValue: old.schema.kind,
      jobValue: spec.schema.kind,
    });
  }
  if (old.schema.serializer !== spec.schema.serializer) {
    mismatches.push({
      field: "serializer",
      savepointValue: old.schema.serializer,
      jobValue: spec.schema.serializer,
    });
  }
  const accepted = new Set([spec.schema.version, ...(spec.acceptedVersions ?? [])]);
  if (!accepted.has(old.schema.version)) {
    mismatches.push({
      field: "version",
      savepointValue: String(old.schema.version),
      jobValue: `${spec.schema.version}（额外接受: ${(spec.acceptedVersions ?? []).join(", ") || "无"}）`,
    });
  }
  if (mismatches.length > 0) throw incompatibleSchema(old.uid, mismatches);
}

function resolveMaxParallelism(
  old: OperatorState,
  spec: OperatorMappingRequest,
): number {
  if (spec.maxParallelism !== undefined && spec.maxParallelism !== old.maxParallelism) {
    throw maxParallelismMismatch(old.uid, old.maxParallelism, spec.maxParallelism);
  }
  return old.maxParallelism;
}

function checkTargetParallelism(
  spec: OperatorMappingRequest,
  maxParallelism: number,
): void {
  if (
    !Number.isInteger(spec.parallelism) ||
    spec.parallelism < 1 ||
    spec.parallelism > maxParallelism
  ) {
    throw invalidParallelism(spec.uid, spec.parallelism, maxParallelism);
  }
}

function remapOperator(
  old: OperatorState,
  newParallelism: number,
  maxParallelism: number,
): MappedOperatorState {
  const sorted = [...old.subtasks].sort((a, b) => a.subtaskIndex - b.subtaskIndex);
  const subtasks: MappedSubtaskState[] = [];

  for (let i = 0; i < newParallelism; i++) {
    const target = computeKeyGroupRange(maxParallelism, newParallelism, i);
    const sourceHandles: string[] = [];
    let split = false;
    for (const st of sorted) {
      const common = intersection(target, st.keyGroups);
      if (!common) continue;
      sourceHandles.push(st.handle);
      if (common.start !== st.keyGroups.start || common.end !== st.keyGroups.end) {
        split = true;
      }
    }
    subtasks.push({ subtaskIndex: i, keyGroups: target, sourceHandles, split });
  }

  const violation = checkExactOnceCoverage(
    subtasks.map((st) => st.keyGroups),
    maxParallelism,
  );
  if (violation) {
    throw keyGroupCoverage(
      old.uid,
      subtasks.map((st) => st.keyGroups),
      maxParallelism,
      violation,
    );
  }

  return {
    uid: old.uid,
    parallelism: newParallelism,
    maxParallelism,
    schema: old.schema,
    subtasks,
  };
}
