# rowauth-query

行级授权查询库：按行属性求值三值策略，过滤与字段遮盖共享同一策略快照，
聚合严格发生在授权之后，并附带一个独立的"先授权再查询"参考模型用于核对。
仅使用 TypeScript 与 Node.js 内置模块（`node:test` / `node:assert`），无运行时依赖。

## 运行

```sh
npm test        # tsc 编译到 dist/ 后用 node --test 运行全部测试
npm run typecheck
```

环境要求：Node.js（开发验证版本 v22.22.1）与可用的 `tsc`（开发验证版本 7.0.2）。

## 核心语义

### 三值逻辑（`src/threeval.ts`）

每个谓词求值为 `T` / `F` / `U`（UNKNOWN）之一，遵循 SQL 风格三值真值表：

- `AND`：任一为 `F` 则 `F`；全 `T` 则 `T`；否则 `U`
- `OR`：任一为 `T` 则 `T`；全 `F` 则 `F`；否则 `U`
- `NOT U = U`

### 缺字段未知（`src/expr.ts`）

行中不存在被引用的字段（或字段值为 `null`）时，比较谓词（`eq/neq/lt/lte/gt/gte/in`）
一律求值为 `U`，而不是报错或当作 `F`。排序比较的操作数类型不匹配同样为 `U`。

### 策略快照（`src/policy.ts`）

`createPolicySnapshot(policy)` 对策略做深拷贝并深度冻结，返回不可变快照。
行过滤（`rowFilter`）与字段遮盖（`masks`）必须来自同一个快照对象，
因此二者永远使用同一份策略版本；快照创建后再修改原策略对象不影响查询结果。

- 行过滤：`rowFilter` 求值为 `T` 才授权该行；`F` 与 `U` 一律拒绝（fail-closed）。
- 字段遮盖：遮盖条件求值为 `T` **或 `U`** 时遮盖该字段（fail-closed），
  为 `F` 时原样展示；缺省替换值为 `***`。

### 先授权后聚合（`src/engine.ts`）

查询管线顺序固定为：行授权 → 查询级 `where`（同样三值，仅 `T` 通过）→
投影/分组聚合 → 输出字段遮盖。聚合器在结构上只接收已授权行，
未授权行的值不可能进入任何聚合结果。`select` 与 `groupBy/aggregates` 互斥。

聚合跳过缺失/`null` 的字段值；无可用值时 `sum/avg/min/max` 输出 `null`，`count` 输出 `0`。
分组键上的遮盖按组内首条已授权行（代表行）求值。

### 有限表与来源行 ID（`src/table.ts`）

输入必须是有限行数组，每行含唯一的字符串/数字 `id`（建表时校验并冻结）。
每个输出行都带 `sourceRowIds`：普通查询为单元素数组，聚合查询为该组全部来源行 ID。

### 独立模型核对（`src/model.ts`、`src/verify.ts`）

`runAuthorizeThenQuery` 是与主引擎不共享运行时代码的独立参考实现，
按最直白的"先授权、再查询"分阶段方式书写（自带三值求值器）。
`verifyAgainstModel` 对同一（表, 快照, 查询）同时运行两套实现并逐行规范化比较，
`test/equivalence.test.ts` 用固定种子的伪随机表/策略/查询做 300 例差分核对。

## 实际测试结果

见 `TEST_RESULTS.md`（最近一次 `npm test` 的真实输出记录）。
