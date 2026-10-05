# log-compaction

基于副本确认向量（acknowledgment vector）的日志压缩库。仅使用 TypeScript 与
Node.js 内置库（`node:fs`、`node:path`、`node:test`、`node:assert`），无外部依赖。

## 设计

核心实现在 `src/compaction.ts`，持久化三个文件（先写临时文件、fsync、再原子改名）：

- `epoch.json` — 纪元记录：当前纪元号、压缩前沿 `baseOffset`、日志末尾
  `nextOffset`、活副本确认向量、已注销副本及其注销所在纪元。
- `snapshot.json` — 已回收前缀折叠出的键值快照。
- `log.jsonl` — 尚未回收的日志条目（偏移 ≥ `baseOffset`）。

关键不变式：

- **按确认向量删除已全确认前缀**：`compact()` 取所有活副本确认偏移的最小值作为
  压缩前沿，仅回收每个活副本都已确认的前缀；无活副本时整段日志可回收（新副本
  一律经快照加入）。
- **副本注销持久记入纪元**：`deregister()` 先把注销写入纪元记录并 fsync 再返回，
  崩溃重启后已注销副本不会复活，其确认包也会被拒绝。
- **新副本须先加载快照**：`registerReplica()` 返回快照与起始偏移，确认向量初始化
  为压缩前沿而非零；低于前沿的确认（含零向量）会被拒绝，已回收历史不会被拖回。

## 测试

- `test/compaction.test.ts` — 单元测试：部分确认前缀回收、注销跨崩溃持久、
  新副本快照加入与零向量防护。
- `test/simulation.test.ts` — 事件模拟：5 个随机种子 × 600 个事件（追加、确认、
  注册、注销、压缩、崩溃重启），每次压缩与崩溃恢复后核对**剩余日志 + 快照可恢复
  全部活副本**的完整状态，并校验确认向量不低于压缩前沿。

运行：

```sh
npm test
```

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 编译器 tsc 7.0.2（全局安装；环境无网络，
`types/node.d.ts` 为手写的最小内置模块声明）。

```
$ npm test
> tsc -p tsconfig.json && node --test "dist/test/*.test.js"

TAP version 13
# Subtest: dist/test/compaction.test.js
ok 1 - dist/test/compaction.test.js
# Subtest: dist/test/simulation.test.js
ok 2 - dist/test/simulation.test.js
1..2
# tests 2
# pass 2
# fail 0
# duration_ms 23046.902516
```

逐文件核对（`node dist/test/compaction.test.js`）：

```
ok 1 - compaction deletes only the fully acknowledged prefix
ok 2 - deregistration is persisted in the epoch record across crashes
ok 3 - a new replica joins via snapshot and cannot drag back reclaimed history
# tests 3
# pass 3
# fail 0
```

模拟文件含 1 个测试（5 种子 × 600 事件），同样通过。全部用例通过，无失败。
