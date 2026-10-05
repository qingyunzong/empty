# Generational Round Runtime

运行库按“轮”划分独立代际（generation）。每轮拥有独立状态与生命周期，
跨轮到达的迟到消息只归属其原始轮，关闭后的代际句柄无法再写入新轮，
轮次结束必须等待流排空或由显式截断完成。全程仅使用 TypeScript 与
Node.js 内置模块（`node:test`、`node:assert`），无第三方运行时依赖。

## 核心规则

- **独立代际**：`runtime.beginRound()` 开启新一轮（`round-N`，代际号 N），
  前一轮必须已进入终态，否则抛错。
- **迟到消息只归原轮**：消息携带不可变的 `roundId`/`generation`/`messageId`
  （如 `r1:stdout:3`）。轮次进入终态后到达的 stdout/断言/退出消息，
  仅以 `late-attributed` 证据记入原始轮，不改变该轮结果，也绝不计入新轮。
- **关闭后不能写新轮**：`RoundHandle` 绑定代际，仅在本轮 `open` 时可写；
  关闭后写入被拒绝并记录 `rejected-stale-handle` 证据（引用被保护的新轮）。
- **结束须等流排空或明确截断**：`endRound()` 使轮次进入 `closing`，
  只有收到 stdout 末块（`final`）与 exit 消息（排空条件）才转为
  `completed`；否则保持等待，直到 `truncate(reason)` 显式截断为 `truncated`。
- **唯一轮终态**：`finalize` 内置唯一性守卫，每轮仅允许一次终态迁移；
  重复终止被记录为 `rejected-duplicate-terminal`。

## 引用证据

所有事件进入全局只增证据日志（`src/evidence.ts`），每条证据带可引用的
`eid`（E1..En）、逻辑时钟、所属轮、代际、消息 id、处置方式
（`accepted` / `late-attributed` / `rejected-stale-handle` /
`dropped-unknown-round` / `rejected-duplicate-terminal` / `state-transition`）。

## 目录

- `src/runtime.ts` — 轮次状态机、代际句柄、归属与终态守卫
- `src/messages.ts` — stdout / assertion / exit 消息类型
- `src/transport.ts` — 乱序传输模拟（种子化 mulberry32 洗牌，确定性复现）
- `src/evidence.ts` — 引用证据日志
- `src/simulate.ts` — 乱序场景模拟，输出完整证据与各轮唯一终态
- `test/runtime.test.ts` — 6 个 `node:test` 测试
- `types/node-shims.d.ts` — 环境无法安装 `@types/node`，声明所用最小类型面

## 使用

```sh
npm test          # tsc 编译 + node --test（需 PATH 中有 tsc，本环境为全局 typescript@7.0.2）
npm run simulate  # 打印完整引用证据与各轮唯一终态
```

实际测试结果见 `TEST-RESULTS.md`。
