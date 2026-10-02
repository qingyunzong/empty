# 验收结果（组 17）

运行环境：Node.js v22.22.1（仅标准库 + node:test，单机离线，无第三方依赖）。
所有结果均为真实运行输出，运行时间 2026-10-03（Asia/Shanghai）。

## 测试总览：`node --test test/*.test.js`

```
# tests 5
# pass 5
# fail 0
# duration_ms 9321.858318
```

| 验收项 | 测试文件 | 结果 |
| --- | --- | --- |
| 1) 固定种子两个 200 事件源，交换顺序合并哈希相同 | test/order-hash.test.js | ok |
| 2) 断点在写冲突证书前/后，恢复不重复证书 | test/resume.test.js | ok |
| 3) n≤10 枚举所有合法拓扑序对照有效集 | test/topology.test.js | ok |
| 4) 并发同 id 双向导入产生同一 conflict.json 且余额不变 | test/conflict.test.js | ok |
| 错误：未知 cause / 环状因果 / 金额非整数均 code=3 | test/errors.test.js | ok |

## 各项细节

1. **顺序无关哈希**：种子 `group17` 生成 A/B 各 200 事件（A: 123 post / 53 void / 24 revive），
   对原始序与多种确定性打乱序（共 4 种文件顺序组合）分别合并，统一日志 SHA-256 全部一致：
   `311185ad39ea0f5cae0a3aca681fd6fb2818b6fe450144380c7dc1794b37c649`，余额 885303，有效集与冲突集完全一致。
   机制：拓扑遍历的起点与 causes 均按 `(lamport, node, id)` 规范键排序，结果只依赖事件集合。
2. **断点恢复**：`log.ndjson` / `state.json` / `conflict.json` 均为「写临时文件 + rename」原子提交；
   在写 conflict.json 前留部分输出、在写后重复运行两种断点场景下，`conflict.json` 始终恰好 1 条证书、
   内容字节级稳定，无 `.tmp-*` 残留。
3. **拓扑序枚举**：7 个场景（链、菱形、双 void、noop 边、8 链、5 宽、双链交错、5 并发等，n≤10），
   共枚举 200+ 个合法拓扑序，每个场景的有效集在所有序下唯一（链式场景验证 void→revive 显式复活）。
4. **并发冲突**：A 与 B 对同 id `shared` 分别 post 100 / 999，双向导入产生的 `conflict.json`
   逐字节相同（金额按 `[min, max]` 规范化，与方向无关），冲突 post 双方均被排除，
   余额两个方向均为 30（= 10 + 20），合并日志哈希一致。

## 错误码验证（CLI 实测）

```
$ node cli.js merge bad.ndjson b.ndjson --out out3
error: bad.ndjson:1: amount must be an integer, got 1.5
exit=3
```

未知 cause、环状因果、金额非整数（浮点/字符串/NaN）在库层与 CLI 层均返回 code=3（见 test/errors.test.js）。

## CLI 冒烟

```
$ node cli.js gen /tmp/g17b --count 200 --seed group17
generated 200 events per node -> /tmp/g17b
$ node cli.js merge /tmp/g17b/a.ndjson /tmp/g17b/b.ndjson --out /tmp/g17b/out
merged 400 events, balance=885303, conflicts=0 -> /tmp/g17b/out
```
