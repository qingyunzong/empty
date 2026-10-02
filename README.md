# param-sync

离线参数同步库与 CLI：工程师把参数包下发到离线控制器，回采实际值，
校验联锁、裁决冲突，危险时可回滚到安全集。仅依赖 Node.js 22 标准库，
测试使用 `node:test`，单机离线运行。

## 概念

- **参数定义**：`{ key, type, min, max, interlock, safety }`
  - `type`: `number | boolean | string`；`min/max` 仅用于 number。
  - `interlock`: 安全表达式（无 `eval`），如 `heater == false || temp < 80`，
    每次 `set` 后必须成立，否则报 `VALIDATION`。
  - `safety: true`: 安全关键参数。
- **变更捕获**：`set / lock / unlock` 均记录为 delta（含每 key 版本向量）。
- **校验**：范围、类型、联锁表达式；非法一律报 `VALIDATION`（退出码 2）。
- **双向同步**：下发库与回采库按每 key 版本向量合并：
  - 一方主导 → 主导方胜，版本向量取逐位 max；
  - 并发且非安全关键 → 确定性规则（计数和 → 最大 nodeId → 值序），与合并顺序无关；
  - 并发且安全关键 → 绝不自动裁决，进入 `pending`（退出码 11）。
- **回滚层级**：`unlock → revert → cert-clear`，顺序错报 `ROLLBACK`（退出码 3）。
- **持久化故障点**：
  - `before-delta-append` / `after-delta-append`（delta 追加前后）
  - `before-active-rename`（active.json 原子 rename 前）
  - `after-manifest-commit`（safe-set manifest 提交后）
  恢复时：未 rename 的 tmp 丢弃、校验和失败的 delta 尾部丢弃、
  未提交的脏 delta 触发安全集覆盖——危险值绝不半应用。
- **安全集**：`safe-set/manifest.json` + `COMMITTED` 标记；恢复时若存在
  未提交 delta（崩溃发生在 apply 中途），安全关键 key 被覆盖为安全值。

## CLI

```
param-sync pack     --def defs.json --values values.json [--safe-set safe.json] [--out pack.json]
param-sync apply    --db DIR --pack pack.json
param-sync feedback --db DIR [--def defs.json] --key K --value JSON
param-sync sync     --dispatch DIR --feedback DIR [--out result.json]
param-sync rollback --db DIR [--snapshot snap.json] (--all | --phase unlock|revert|cert-clear)
param-sync cert     --db DIR (issue --id X [--subject S] | revoke --id X | clear | list)
```

错误以 JSON 写 stderr：`{"error":{"code":...,"message":...}}`。
退出码：`2` VALIDATION，`3` ROLLBACK，`11` SYNC_PENDING。

故障注入（测试/演练）：环境变量 `PARAM_SYNC_FAULT=<fault-point>`。

## 库

```js
import { compileSchema, ParamStore, PersistentStore,
         mergeSnapshots, RollbackEngine, enumerateSafeConvergence } from 'param-sync';
```

## 测试

```
node --test
```

验收覆盖：越界与联锁（VALIDATION）、回滚顺序（ROLLBACK）、三个故障点恢复、
n≤7 枚举安全收敛对照（每 n 枚举 2^n 子集 × 4 故障点，与参考安全态逐一比对）。
真实结果见 [RESULTS.md](RESULTS.md)。
