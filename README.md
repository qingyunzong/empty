# observer-merge

单机离线环境下的观测记录分支合并库与 CLI（Node.js 22，仅标准库）。

每条记录含 `value`、`quality`、`reviewed` 三个字段。每个分支修改携带
向量时间戳（`vectorClock`）、来源等级（`sourceLevel`）、作者（`author`）
以及字段级旧值（`changes.<field>.old`）。

## 合并规则（逐字段三方合并）

1. 仅一侧修改且旧值与 base 一致 → 采用该侧。
2. 双侧新值相同 → 合并，不冲突。
3. `reviewed` 被双侧置为不同布尔值 → 冲突。
4. 任一侧旧值与 base 不一致（过时写入）→ 冲突。
5. 来源等级高者覆盖低者。
6. 同等级：向量时间戳较新者胜；完全同时间 → 冲突。
7. 时钟并发不可比：按作者字典序确定性决胜。

无法自动决定时生成冲突证书（字段、base 值、双侧修改、原因、sha256 校验哈希）。

## CLI

```sh
node src/cli.js merge --base base.json --a branch-a.json --b branch-b.json --out-dir .
```

- 成功：写出 `merged.json` 与 `decision-log.json`，退出码 0。
- 冲突：写出 `decision-log.json` 与 `conflicts.json`（证书列表），退出码 2。
- 用法/IO 错误：退出码 1。

分支文件格式：

```json
{
  "author": "observer-id",
  "sourceLevel": 2,
  "vectorClock": { "observer-id": 3 },
  "changes": { "value": { "old": 10, "new": 12 } }
}
```

## 库 API

```js
import { mergeBranches, decideField } from './src/merge.js';
const result = mergeBranches({ base, branchA, branchB });
// result.status: 'merged' | 'conflict'
// result.merged / result.decisions / result.conflicts
```

## 测试

```sh
node --test
```

测试包含自动胜出（等级/时间戳/作者字典序）、完全同时间冲突、
双侧 reviewed 布尔分歧冲突、旧值不匹配的过时写入冲突，并对单字段
有限取值做全组合枚举（base × A × B × 等级 × 时钟关系），
用独立实现的 oracle 逐例核对期望决策。真实测试结果见 `test-result.txt`。
