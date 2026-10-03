# RESULTS

环境：Node.js v22.22.1，仅标准库 + `node:test`，单机离线，无网络访问。
日期：2026-10-03（Asia/Shanghai）。

## 测试运行（真实输出）

命令：`node --test test/*.test.js`

```
# Subtest: concurrent same-id different-amount conflict is deterministic both ways
# Subtest: identical concurrent posts dedupe to a single credit
# Subtest: unknown cause exits with code 3
# Subtest: cyclic causality exits with code 3
# Subtest: non-integer amount exits with code 3
# Subtest: merge is order-independent (library, seed 17, 200 events per node)
# Subtest: merge is order-independent (cli output files)
# Subtest: re-running merge on a completed out dir is a no-op
# Subtest: void visibility and revive semantics
# Subtest: crash before writing conflict certificate, resume completes without duplicates
# Subtest: crash after writing conflict certificate, resume does not duplicate certificates
# Subtest: all topological orders agree on the effective set (n=2)
# Subtest: all topological orders agree on the effective set (n=3)
# Subtest: all topological orders agree on the effective set (n=4)
# Subtest: all topological orders agree on the effective set (n=5)
# Subtest: all topological orders agree on the effective set (n=6)
# Subtest: all topological orders agree on the effective set (n=7)
# Subtest: all topological orders agree on the effective set (n=8)
# Subtest: all topological orders agree on the effective set (n=9)
# Subtest: all topological orders agree on the effective set (n=10)
# tests 5
# pass 5
# fail 0
```

结果：5 个测试文件、20 个子测试，全部通过，0 失败。

## 验收对照

1. **固定种子双源、交换顺序哈希相同** — `test/merge.test.js` 前两个子测试通过；
   CLI 实证：
   ```
   $ node cli.js gen --seed 17 --count 200 --dir .
   $ node cli.js merge a.ndjson b.ndjson --out out
   {"events":400,"balance":93661,"conflicts":9,"hash":"dd91814bc2cd690f556fc2c834a8f2e6230fc682711841c4aaaf3f3cb594351d"}
   $ node cli.js merge b.ndjson a.ndjson --out out-rev
   {"events":400,"balance":93661,"conflicts":9,"hash":"dd91814bc2cd690f556fc2c834a8f2e6230fc682711841c4aaaf3f3cb594351d"}
   $ diff -r out out-rev   # 无差异（log.ndjson / balance.json / conflict.json 逐字节一致）
   ```
2. **断点恢复不重复证书** — `test/resume.test.js` 两个子测试通过。
   断点经环境变量注入：`SYNC_CRASH=pre-conflicts`（写证书前）与
   `SYNC_CRASH=post-conflicts`（写证书后、记日志前），恢复后 `conflict.json`
   证书 id 无重复，且与从未崩溃的干净运行逐字节一致。
3. **n≤10 全拓扑序对照** — `test/topo.test.js` 九个子测试（n=2..10）通过：
   对每个随机因果 DAG 枚举全部合法拓扑序，逐一用独立参考求值器计算有效集，
   与 `sync.js` 的结果完全一致。
4. **并发同 id 双向导入** — `test/conflict.test.js` 通过：
   `tx-shared`（A=100, B=999）双向合并产生逐字节相同的 `conflict.json`
   （`{"id":"tx-shared","amounts":[100,999],"nodes":["A","B"],"concurrent":true}`），
   冲突交易不计入余额（1450 = 500+250+700，不含冲突额）。

## 错误码（code=3，真实验证）

- 未知 cause：`error: unknown cause "ghost" referenced by tx2 (B#1)` → exit 3
- 环状因果：`error: cyclic causality detected` → exit 3
- 金额非整数：`error: amount must be an integer, got 10.5` → exit 3

## 产物

- `sync.js` — 库：ndjson 解析/校验、确定性因果拓扑排序、有效集/余额/冲突证书求值。
- `cli.js` — `merge`（含 `.journal` 断点恢复 + 原子写）与 `gen`（固定种子生成器）。
- `gen.js` — mulberry32 种子 PRNG，生成两个因果一致的 200 事件源。
- `a.ndjson` / `b.ndjson` — 种子 17 的真实生成源；`out/` — 真实合并输出。

## 备注

- 本沙箱中子进程的异步 `process.stdout.write` 在退出时会丢失，
  因此 CLI 的所有输出均使用同步 `fs.writeSync(1|2, …)`。
