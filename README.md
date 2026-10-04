# bucket-sync

整数键空间的分桶增量同步库。TypeScript 编写，运行时仅依赖 Node.js 内置模块
（`node:test` / `node:assert`），无第三方依赖。

## 设计

- **分桶摘要**：整数键空间 `[0, keySpaceSize)` 均分为 `bucketCount` 个连续区间桶。
  每桶摘要为 `{ count, digest }`，digest 按 key 有序对
  `(key, 墓碑标志/值摘要)` 逐项混合（`src/store.ts` 的 `Store.summaries`）。
- **只拉不同桶**：客户端比对本地与源端摘要，仅对摘要不同的桶请求记录
  （`src/sync.ts` 的 `SyncClient.sync`）。
- **墓碑 ≠ 空桶**：删除写入墓碑（`value = null`），仍计入 `count` 并参与 digest；
  空桶 digest 恒为 `EMPTY_BUCKET_DIGEST` 且 `count = 0`，二者摘要不可能会相等。
  墓碑随桶记录复制到对端，删除因此可传播。
- **版本绑定**：每轮同步先取 `{ version, summaries }` 检查点，整轮所有桶请求都
  携带该版本；源端版本已变则抛 `VersionChangedError`，客户端重试整轮
  （重新取检查点），直到一轮完整跑完或超过 `maxRounds`。
- **碰撞字节确认**：摘要函数可注入（`DigestFn`）。开启 `confirmBytes` 后，即使摘要
  相同也逐条记录、逐字节比对桶内容，发现碰撞导致的伪相等则应用远端记录修复。
- **最终全量比较**：测试辅助 `assertStoresEqual` 对两端做全量集合比较
  （全部存活记录逐字节 + 墓碑集合）。

## 运行

```sh
npm test   # tsc 编译到 dist/ 后用 node --test 运行
```

## 实际测试结果

`npm test`（Node v22.22.1，tsc 7.0.2）：

```
# tests 1
# pass 1
# fail 0
```

本环境 `node --test` 对子进程测试文件只汇总到文件级；直接运行测试文件可见
全部 5 个用例（`node dist/test/sync.test.js`）：

```
ok 1 - 墓碑桶与空桶的摘要不同
ok 2 - 增量同步只请求摘要不同的桶，最终全量一致
ok 3 - 删除通过墓碑传播，且墓碑集合一致
ok 4 - 同步全程绑定源版本：源变化则重试该轮并最终收敛
ok 5 - 注入摘要碰撞：不确认则漏同步，逐条字节确认后全量一致
# tests 5
# pass 5
# fail 0
```

用例 2 断言 100 个键（1024 键空间 / 16 桶）首次同步只拉取 2 个桶；
用例 4 注入轮中写源端，断言 `retries >= 1` 后全量收敛；
用例 5 注入常量摘要函数制造碰撞，断言不确认时漏同步、确认后
`byteConfirmationMismatches === 1` 且全量一致。
