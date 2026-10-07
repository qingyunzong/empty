# leaderboard-ledger

基于事件账本的整数分排行榜库。TypeScript 编写，仅依赖 Node.js 内置模块
（`node:buffer` / `node:test` / `node:assert`），无第三方运行时依赖。

## 规则

- **整数分**：`delta` 必须为整数，允许负数，净分可以为负。
- **事件账本**：所有事件按到达顺序存入账本（append-only）。
- **重复 ID**：同 ID 同内容为幂等重放（不计分、无 TopK 变化）；
  同 ID 异内容拒绝并抛 `LeaderboardError`。
- **撤销只能一次**：`revoke(id)` 使事件失效且不可再次撤销、不可重新应用；
  未知 ID 拒绝。已撤销事件保留在账本中但不再计分。
- **排名**：分数降序；并列时按用户名字符串的 UTF-8 字节序升序
  （与 JS 默认 UTF-16 码元序在非 BMP 字符上不同，见 `compareUtf8`）。
- **TopK 净变化**：每次 `apply` / `revoke` 返回 `{ k, entered, left, changed }`，
  分别表示新进 TopK、掉出 TopK、以及窗口内名次/分数发生变化的条目。
- **完整账本重算核对**：`verify()` 从完整账本重算所有净分（跳过已撤销事件），
  与增量维护的状态逐一比对（含负分与并列），不一致即抛错。

## API

```ts
import { Leaderboard } from "./src/leaderboard.js";

const lb = new Leaderboard(2);                 // TopK 窗口 k=2
lb.apply({ id: "e1", user: "alice", delta: 5 });   // => { k, entered, left, changed }
lb.apply({ id: "e2", user: "bob", delta: -3 });    // 负分合法
lb.revoke("e1");                               // 撤销，仅一次
lb.topK();                                     // RankedEntry[]（rank 从 1 开始）
lb.ranking();                                  // 完整排名
lb.scoreOf("bob");                             // -3
lb.verify();                                   // 全账本重算核对，不一致抛错
```

## 构建与测试

```sh
npm test   # tsc 编译到 dist/ 后运行 node:test 测试
```

说明：本环境 Node v22.22.1 未启用 TypeScript 类型剥离，故先以 `tsc` 编译；
该构建的 `node --test <file>` 会把文件折叠为单条结果，因此测试脚本直接
`node dist/test/leaderboard.test.js` 执行（`node:test` 运行器仍生效，
逐条输出 TAP 且失败时退出码非零）。

## 实际测试结果（npm test，2026-10-08，Node v22.22.1，tsc 7.0.2）

```
> leaderboard-ledger@1.0.0 test
> tsc -p tsconfig.json && node dist/test/leaderboard.test.js

TAP version 13
# Subtest: 整数分累计，支持负 delta 与负净分
ok 1 - 整数分累计，支持负 delta 与负净分
# Subtest: 重复 ID 同内容幂等，不计分也不产生 TopK 变化
ok 2 - 重复 ID 同内容幂等，不计分也不产生 TopK 变化
# Subtest: 重复 ID 异内容拒绝，且状态不变
ok 3 - 重复 ID 异内容拒绝，且状态不变
# Subtest: 撤销只能一次：未知 ID、二次撤销、撤销后重放均拒绝
ok 4 - 撤销只能一次：未知 ID、二次撤销、撤销后重放均拒绝
# Subtest: 撤销可产生负净分
ok 5 - 撤销可产生负净分
# Subtest: 排名：分高优先，并列按用户名 UTF-8 字节序
ok 6 - 排名：分高优先，并列按用户名 UTF-8 字节序
# Subtest: TopK 净变化：entered / left / changed
ok 7 - TopK 净变化：entered / left / changed
# Subtest: 完整账本重算核对：负分与并列
ok 8 - 完整账本重算核对：负分与并列
# Subtest: verify 能发现增量状态与账本不一致
ok 9 - verify 能发现增量状态与账本不一致
# Subtest: 参数校验：非整数 delta、空 id/user、非法 k
ok 10 - 参数校验：非整数 delta、空 id/user、非法 k
1..10
# tests 10
# pass 10
# fail 0
```

## 文件结构

- `src/leaderboard.ts` — 库实现（`Leaderboard` / `TopKChange` / `compareUtf8`）
- `test/leaderboard.test.ts` — `node:test` + `node:assert/strict` 测试
- `types/node-shims.d.ts` — Node 内置模块的最小类型声明（离线环境替代 `@types/node`）
