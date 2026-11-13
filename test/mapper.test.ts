import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeKeyGroupRange,
  checkExactOnceCoverage,
} from "../src/keyGroups.js";
import { SavepointMappingError } from "../src/errors.js";
import {
  mapSavepoint,
  type OperatorState,
  type Savepoint,
  type StateSchema,
} from "../src/mapper.js";

const SCHEMA: StateSchema = { kind: "keyed-value", serializer: "kryo", version: 2 };

function makeOperator(
  uid: string,
  parallelism: number,
  maxParallelism: number,
  schema: StateSchema = SCHEMA,
): OperatorState {
  return {
    uid,
    parallelism,
    maxParallelism,
    schema,
    subtasks: Array.from({ length: parallelism }, (_, i) => ({
      subtaskIndex: i,
      keyGroups: computeKeyGroupRange(maxParallelism, parallelism, i),
      handle: `${uid}/subtask-${i}`,
    })),
  };
}

function makeSavepoint(...operators: OperatorState[]): Savepoint {
  return { operators };
}

function assertExactOnce(subtasks: { keyGroups: { start: number; end: number } }[], max: number) {
  assert.equal(
    checkExactOnceCoverage(subtasks.map((s) => s.keyGroups), max),
    null,
  );
}

test("scale out 2 -> 4：状态拆分且每个 key-group 恰好归属一次", () => {
  const sp = makeSavepoint(makeOperator("map", 2, 8));
  const result = mapSavepoint(sp, {
    operators: [{ uid: "map", parallelism: 4, schema: SCHEMA }],
  });
  const op = result.operators[0];
  assert.equal(op.parallelism, 4);
  assertExactOnce(op.subtasks, 8);
  // 旧 subtask-0 拥有 kg [0,3]，被拆到新 subtask-0 [0,1] 与 subtask-1 [2,3]
  assert.deepEqual(op.subtasks[0].sourceHandles, ["map/subtask-0"]);
  assert.deepEqual(op.subtasks[1].sourceHandles, ["map/subtask-0"]);
  assert.equal(op.subtasks[0].split, true);
  assert.deepEqual(result.report.rescales, [{ uid: "map", from: 2, to: 4 }]);
});

test("scale in 4 -> 2：状态合并且每个 key-group 恰好归属一次", () => {
  const sp = makeSavepoint(makeOperator("map", 4, 8));
  const result = mapSavepoint(sp, {
    operators: [{ uid: "map", parallelism: 2, schema: SCHEMA }],
  });
  const op = result.operators[0];
  assertExactOnce(op.subtasks, 8);
  assert.deepEqual(op.subtasks[0].sourceHandles, ["map/subtask-0", "map/subtask-1"]);
  assert.deepEqual(op.subtasks[1].sourceHandles, ["map/subtask-2", "map/subtask-3"]);
  assert.equal(op.subtasks[0].split, false);
});

test("并行度不变：句柄一一对应", () => {
  const sp = makeSavepoint(makeOperator("map", 3, 12));
  const result = mapSavepoint(sp, {
    operators: [{ uid: "map", parallelism: 3, schema: SCHEMA }],
  });
  const op = result.operators[0];
  assertExactOnce(op.subtasks, 12);
  op.subtasks.forEach((st, i) => {
    assert.deepEqual(st.sourceHandles, [`map/subtask-${i}`]);
    assert.equal(st.split, false);
  });
  assert.deepEqual(result.report.rescales, []);
});

test("非整除 maxParallelism 下 scale out 仍恰好覆盖一次", () => {
  const sp = makeSavepoint(makeOperator("map", 2, 7));
  const result = mapSavepoint(sp, {
    operators: [{ uid: "map", parallelism: 5, schema: SCHEMA }],
  });
  assertExactOnce(result.operators[0].subtasks, 7);
});

test("UID 缺失：savepoint 侧阻断", () => {
  const sp = makeSavepoint(makeOperator("", 2, 8));
  assert.throws(
    () => mapSavepoint(sp, { operators: [{ uid: "x", parallelism: 2, schema: SCHEMA }] }),
    (e: unknown) => e instanceof SavepointMappingError && e.code === "MISSING_UID",
  );
});

test("UID 缺失：映射请求侧阻断", () => {
  const sp = makeSavepoint(makeOperator("map", 2, 8));
  assert.throws(
    () => mapSavepoint(sp, { operators: [{ uid: "", parallelism: 2, schema: SCHEMA }] }),
    (e: unknown) => e instanceof SavepointMappingError && e.code === "MISSING_UID",
  );
});

test("UID 重复：savepoint 与请求两侧均阻断", () => {
  const dup = makeSavepoint(makeOperator("map", 2, 8), makeOperator("map", 1, 8));
  assert.throws(
    () => mapSavepoint(dup, { operators: [{ uid: "map", parallelism: 2, schema: SCHEMA }] }),
    (e: unknown) => e instanceof SavepointMappingError && e.code === "DUPLICATE_UID",
  );
  const sp = makeSavepoint(makeOperator("map", 2, 8));
  assert.throws(
    () =>
      mapSavepoint(sp, {
        operators: [
          { uid: "map", parallelism: 2, schema: SCHEMA },
          { uid: "map", parallelism: 4, schema: SCHEMA },
        ],
      }),
    (e: unknown) => e instanceof SavepointMappingError && e.code === "DUPLICATE_UID",
  );
});

test("目标 UID 在 savepoint 中不存在：阻断", () => {
  const sp = makeSavepoint(makeOperator("map", 2, 8));
  assert.throws(
    () => mapSavepoint(sp, { operators: [{ uid: "renamed", parallelism: 2, schema: SCHEMA }] }),
    (e: unknown) => e instanceof SavepointMappingError && e.code === "UNMATCHED_UID",
  );
});

test("schema 不兼容：serializer / kind / version 分别给出具体阻断", () => {
  const sp = makeSavepoint(makeOperator("map", 2, 8));
  const badSerializer = { ...SCHEMA, serializer: "avro" };
  assert.throws(
    () => mapSavepoint(sp, { operators: [{ uid: "map", parallelism: 2, schema: badSerializer }] }),
    (e: unknown) =>
      e instanceof SavepointMappingError &&
      e.code === "INCOMPATIBLE_SCHEMA" &&
      e.message.includes("serializer") &&
      e.message.includes("kryo") &&
      e.message.includes("avro"),
  );
  const badVersion = { ...SCHEMA, version: 3 };
  assert.throws(
    () => mapSavepoint(sp, { operators: [{ uid: "map", parallelism: 2, schema: badVersion }] }),
    (e: unknown) => e instanceof SavepointMappingError && e.code === "INCOMPATIBLE_SCHEMA",
  );
  // 声明 acceptedVersions 后放行
  const ok = mapSavepoint(sp, {
    operators: [
      { uid: "map", parallelism: 2, schema: badVersion, acceptedVersions: [2] },
    ],
  });
  assert.equal(ok.operators[0].uid, "map");
});

test("maxParallelism 变更：阻断", () => {
  const sp = makeSavepoint(makeOperator("map", 2, 8));
  assert.throws(
    () =>
      mapSavepoint(sp, {
        operators: [{ uid: "map", parallelism: 2, maxParallelism: 16, schema: SCHEMA }],
      }),
    (e: unknown) =>
      e instanceof SavepointMappingError && e.code === "MAX_PARALLELISM_MISMATCH",
  );
});

test("目标并行度超过 maxParallelism：阻断", () => {
  const sp = makeSavepoint(makeOperator("map", 2, 8));
  assert.throws(
    () => mapSavepoint(sp, { operators: [{ uid: "map", parallelism: 9, schema: SCHEMA }] }),
    (e: unknown) => e instanceof SavepointMappingError && e.code === "INVALID_PARALLELISM",
  );
});

test("savepoint 中未被引用的算子：默认阻断，可显式丢弃", () => {
  const sp = makeSavepoint(makeOperator("map", 2, 8), makeOperator("sink", 1, 8));
  assert.throws(
    () => mapSavepoint(sp, { operators: [{ uid: "map", parallelism: 2, schema: SCHEMA }] }),
    (e: unknown) => e instanceof SavepointMappingError && e.code === "UNMATCHED_UID",
  );
  const result = mapSavepoint(sp, {
    operators: [{ uid: "map", parallelism: 2, schema: SCHEMA }],
    allowNonRestoredState: true,
  });
  assert.deepEqual(result.report.droppedOperators, ["sink"]);
});

test("旧 savepoint 自身 key-group 覆盖异常：阻断", () => {
  const broken = makeOperator("map", 2, 8);
  broken.subtasks[1].keyGroups = { start: 3, end: 7 }; // 与 subtask-0 的 [0,3] 重叠
  assert.throws(
    () =>
      mapSavepoint(makeSavepoint(broken), {
        operators: [{ uid: "map", parallelism: 2, schema: SCHEMA }],
      }),
    (e: unknown) =>
      e instanceof SavepointMappingError &&
      e.code === "INVALID_SAVEPOINT" &&
      e.message.includes("key-group 3"),
  );
});

test("多算子混合 scale：互不影响且各自恰好覆盖一次", () => {
  const sp = makeSavepoint(makeOperator("a", 2, 8), makeOperator("b", 4, 16));
  const result = mapSavepoint(sp, {
    operators: [
      { uid: "a", parallelism: 4, schema: SCHEMA },
      { uid: "b", parallelism: 2, schema: SCHEMA },
    ],
  });
  assertExactOnce(result.operators[0].subtasks, 8);
  assertExactOnce(result.operators[1].subtasks, 16);
  assert.deepEqual(result.report.rescales, [
    { uid: "a", from: 2, to: 4 },
    { uid: "b", from: 4, to: 2 },
  ]);
});
