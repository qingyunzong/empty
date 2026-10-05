# 变更库（change-log）

TypeScript 实现的键值变更库：记录 `insert` / `delete` / `replace` 操作，
压缩同键连续操作，输出逆批次用于撤销，并在无法确定原值时报告"需要基线"。
仅使用 Node.js 内置库（`node:test`、`node:assert`），无任何运行时依赖。

## 压缩规则（同键连续操作）

| 连续操作 | 压缩结果 |
| --- | --- |
| `insert` 后 `delete` | 两者消失 |
| `delete` 后 `insert` | 成为 `replace`，保存原值 |
| `replace` 后 `delete` | 成为 `delete`，保留最早原值 |
| `replace` 后 `replace` | 合并为一次 `replace`，保留最早原值 |
| `insert` 后 `replace` | 仍是 `insert`（键原本不存在） |
| 重复 `delete` | 幂等，只留第一个 |

`delete` / `replace` 的原值未随操作记录且不在基线（`baseline`）中时，
`compress` / `invertBatches` 会把该键记入返回的 `needsBaseline`（需要基线）。

## API

- `compress(ops, baseline?)` → `{ ops, needsBaseline }`：压缩同键连续操作。
- `invertBatches(batches, baseline?)` → `{ batches, needsBaseline }`：
  输出逆批次（批次倒序、批内倒序、逐操作取逆），依次应用即可撤销。
- `applyOps(state, ops)`：把操作应用到 `Map` 状态上。
- `batchOps(ops, size)`：把操作序列切分为固定大小的批次。

```ts
import { compress, invertBatches, applyOps, batchOps } from "./src/change-log.js";

const { ops } = compress([
  { type: "delete", key: "k", oldValue: 1 },
  { type: "insert", key: "k", value: 2 },
]);
// ops = [{ type: "replace", key: "k", oldValue: 1, newValue: 2 }]
```

## 测试

```sh
npm test   # tsc 编译到 dist/ 后运行 node:test 测试
```

测试覆盖：上述全部压缩规则、需要基线报告、逆批次撤销，以及随机性质测试
（200 轮随机操作：压缩前后应用结果相同，且原始序列与压缩序列各自经逆批次
撤销后都回到初始状态）。

## 实际测试结果（2026-10-05，Node v22.22.1）

```
# Subtest: insert 后 delete：两者消失
ok 1 - insert 后 delete：两者消失
# Subtest: delete 后 insert：成为 replace 且保存原值
ok 2 - delete 后 insert：成为 replace 且保存原值
# Subtest: 无法知道原值时报需要基线；提供基线后可解析
ok 3 - 无法知道原值时报需要基线；提供基线后可解析
# Subtest: replace 后 delete 成为 delete、连续 replace 合并，均保留最早原值
ok 4 - replace 后 delete 成为 delete、连续 replace 合并，均保留最早原值
# Subtest: 逆批次：顺序相反且依次应用可撤销
ok 5 - 逆批次：顺序相反且依次应用可撤销
# Subtest: 随机操作：压缩前后结果及撤销相同
ok 6 - 随机操作：压缩前后结果及撤销相同
1..6
# tests 6
# pass 6
# fail 0
```
