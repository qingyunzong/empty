# bucket-sync

整数键空间上的分桶摘要同步库。TypeScript 编写，仅依赖 Node.js 内置模块
（`node:crypto`、`node:test`、`node:assert`），无任何第三方依赖。

## 设计

- **分桶摘要比较**：整数键空间（安全整数）按 `key mod 16` 分桶，每桶摘要为
  `sha256(桶序号 ‖ 逐条记录序列化)`，并附带存活/墓碑计数。同步时只交换摘要，
  仅拉取摘要不一致的桶的记录（`syncStore` 的 `fetchedBuckets`）。
- **墓碑与空桶的区别**：删除留下墓碑，墓碑参与桶摘要序列化且单独计数，
  因此"只剩墓碑的桶"与"从未有数据的空桶"摘要不同；删除可随同步传播。
  拉取差异桶时用源端桶内容整体替换目标端（多余键清除而非合并）。
- **全程绑定源版本**：客户端在每轮开始时读取源版本 `v`，之后每个请求都
  携带 `v`；源端版本一旦前进即拒绝（`VersionMismatchError`）。轮末还有
  一道屏障再次校验版本。任何漂移都会从头重试该轮（`maxRetries` 上限）。
- **碰撞注入时逐条字节确认**：哈希函数可注入。开启 `byteVerify` 后，
  摘要一致的桶也会逐条记录、逐字节地与源端比对，发现不一致即替换，
  可揭穿碰撞掩盖的分歧。
- **最终与全量集合比较**：`verifyFullSet` 拉取源端全量存活集合，与目标端
  逐键逐字节比较，作为同步正确性的最终判定。

## 结构

- `src/store.ts` — 版本化存储：整数键、墓碑、每次写自增 `version`
- `src/digest.ts` — 桶序列化与摘要（哈希函数可注入，默认 SHA-256）
- `src/server.ts` — 源端：所有读取绑定期望版本，漂移即抛 `VersionMismatchError`
- `src/sync.ts` — 客户端：`syncStore`（分桶同步 + 重试 + 字节确认）、`verifyFullSet`
- `test/sync.test.ts` — 7 个测试，覆盖上述全部行为
- `types/node-shim.d.ts` — Node 内置模块的最小类型声明（离线环境，无需 @types/node）

## 运行

```sh
npm test   # = tsc 构建 + node --test "dist/test/*.test.js"
```

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 全局安装。2026-10-05 实跑：

`npm test` 输出（构建 + 测试运行器汇总）：

```
> bucket-sync@0.1.0 test
> npm run build && node --test "dist/test/*.test.js"

> bucket-sync@0.1.0 build
> tsc -p tsconfig.json

TAP version 13
# Subtest: dist/test/sync.test.js
ok 1 - dist/test/sync.test.js
1..1
# tests 1
# pass 1
# fail 0
# duration_ms 462.654151
```

逐条子测试明细（`node dist/test/sync.test.js`，进程内直跑）：

```
ok 1 - bucket digests: only differing buckets are fetched
ok 2 - tombstones are distinguishable from empty buckets and propagate deletes
ok 3 - version pinned round: mid-round mutation triggers retry
ok 4 - version pinned round: end-of-round barrier catches late mutation
ok 5 - version pinned round: retries are bounded
ok 6 - injected collision: per-record byte confirmation unmasks divergence
ok 7 - final comparison against the full set after randomized divergence
1..7
# tests 7
# pass 7
# fail 0
# duration_ms 65.724596
```

注：本沙箱会吞掉 `--test` 子进程的内部 TAP 流，故明细用进程内直跑获取；
两种方式的退出码均为 0，7/7 通过。
