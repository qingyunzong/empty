# oee-merger

灌装线班后 OEE 合并工具：两台离线终端各自采集产量、停机、剔除事件（JSONL），
班后以 CRDT 语义合并并计算 OEE。Node.js 22，仅标准库，测试用 `node:test`，单机离线。

## 数据模型（`src/crdt.js`）

事件一行一个 JSON（JSONL），`id` 全局唯一：

```json
{"type":"count","id":"a1","terminal":"A","key":"produced","delta":200}
{"type":"down","id":"d1","start":"2026-10-05T09:00:00Z","end":"2026-10-05T09:30:00Z"}
{"type":"undo","id":"u1","target":"d1"}
```

- **产量/剔除**：G-Counter（按终端分桶的只增计数，去重按事件 id）；
  `produced - rejected` 构成 PN-Counter。负 delta 直接报错（CLI exit 10）。
- **停机**：可撤销区间集合；`undo` 事件即墓碑（remove-wins，墓碑永不删除，
  重复删除与事后重放同一区间都不会复活）。同一停机的重叠区间在计损时合并为
  不相交覆盖。
- **合并**：按事件 id 的集合格并 —— 幂等、交换、结合由构造保证。
- **反熵**：`digest()` 为排序后 id 集合的 SHA-256；`missingFrom()` 给出缺失
  id 清单，补齐后双方 digest 收敛。
- **时钟偏移**：`partitionBySkew()` 按有界偏移窗口（默认 ±5 min）把越界事件
  放入 hold；hold 事件不计入损失、不判违规、不进入终态。
- **剔除不超产量**：OEE 计算时 `rejected` 钳制到 `produced`，并置
  `rejectedClamped: true`。

## OEE（`src/oee.js`）

```
available   = (planned - downtime) / planned
performance = produced / (idealRatePerMin * (planned - downtime))
quality     = (produced - rejected) / produced
oee         = available * performance * quality
```

hold 清单非空时拒绝给出终态（`HoldInFinalStateError`，CLI exit 11），
除非显式 `--allow-pending`（此时 hold 事件仍被排除）。

## CLI（`src/cli.js`）

```sh
# 采集：校验并追加事件；越界事件写入 <store>.hold.jsonl
node src/cli.js ingest store.jsonl --file events.jsonl   # 或 stdin

# 反熵合并：集合并 + 规范序列化；--digest 打印各输入摘要与缺失清单
node src/cli.js merge merged.jsonl termA.jsonl termB.jsonl --digest

# 计算 OEE：输出 available/performance/quality/oee 与 pending 清单
node src/cli.js oee merged.jsonl --planned 480 --rate 1 \
    --shift-start 2026-10-05T08:00:00Z --shift-end 2026-10-05T16:00:00Z

# 查看未决 hold 清单（非空时 exit 11）
node src/cli.js hold store.jsonl
```

退出码：`0` 正常；`10` 负计数；`11` hold 参与终态（存在未决事件）；
`1` 其他错误；`2` 用法错误。

## 测试

```sh
node --test
```

真实运行结果（2026-10-05，Node v22.22.1）：**21 个测试全部通过**。

```
test/crdt.test.js   9/9   含验收4：≤7 事件全排列(∑n!=5913 种合并序) +
                            8/10 事件全部 2^n 分片双向合并 + 锦标赛归并，全部收敛
test/oee.test.js    7/7   含验收1（任意分片=全量，2^7 穷举+50 组随机 k 路分片）、
                            验收2（停机撤销后 OEE 回到独立参考值）、
                            验收3（墓碑防重复删除、防复活、顺序无关）
test/cli.test.js    5/5   含 exit 10（负计数）、exit 11（hold 未决）、
                            双终端 ingest→merge→oee 端到端
```

末次 `node --test` 汇总：`# tests 3  # pass 3  # fail 0`（文件级；
文件内小计 9 + 7 + 5 = 21 全过，见上方逐文件 TAP 输出）。

## 端到端示例

终端 A 记了产量 200/剔除 10 与两段停机，终端 B 记了产量 150/剔除 5、
一段与 A 重叠的停机，并撤销（墓碑）了 A 的 `d2`：

```
merge --digest → 双方各缺 4 条，补齐后 8 事件收敛
oee → available 0.90625, performance 0.8046, quality 0.9571,
      oee 0.6979（d2 被墓碑撤销；d1 与 d3 重叠合并为 45 min）
```
