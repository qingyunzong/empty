# oee-crdt

灌装线离线 OEE 采集与班后合并。Node.js 22，仅标准库，测试用 `node:test`。

两台离线终端各自采集产量（produced）、剔除（rejected）、停机（downtime），
班后通过 CRDT 合并计算 OEE。合并满足幂等、交换、结合律。

## 数据模型（`src/state.js`）

- **产量/剔除**：PN-Counter（`counters[name][node] = {p, n}`），正 delta 计 `p`，负 delta 计 `n`。
- **停机**：可撤销区间 `downtime`，`revoke` 事件产生**墓碑**（remove-wins），重复删除是 no-op，迟到的事件不能复活已删区间。
- **hold**：时钟偏移有界（`--window-start/--window-end/--max-skew`），越界事件进入 `holds`，不计入损失也不判违规。
- **journal**：全量事件日志（G-Set），所有视图（计数器/停机/墓碑）都是 journal 的确定性折叠，因此合并 = 集合并 + 确定性推导，天然满足三条合并律。
- **反熵**（`src/antientropy.js`）：按时间桶对 journal 做摘要（`digest`），比对差异桶，仅交换缺失事件（`repair`）。

## OEE（`src/oee.js`）

- `available = (planned - downtime) / planned`，停机区间先合并重叠再求并集长度
- `performance = produced / (idealRate * (planned - downtime))`
- `quality = (produced - rejected) / produced`，剔除钳制不超过产量（超出记入 `violations`）
- 输出含 `available/performance/quality/oee` 与 `pending`（未决 hold 清单）

## CLI（`src/cli.js`）

```sh
node src/cli.js ingest --state t1.json events.jsonl --window-start 0 --window-end 28800 --max-skew 300
node src/cli.js merge  --state merged.json t1.json t2.json
node src/cli.js oee    --state merged.json --planned 28800 --ideal-rate 2
node src/cli.js hold   --state merged.json
node src/cli.js digest --state t1.json --bucket 60000
node src/cli.js repair --state t1.json --peer t2.json --bucket 60000
```

事件为 JSONL，三种类型：

```json
{"id":"a1","type":"count","counter":"produced","node":"t1","delta":100,"ts":1000}
{"id":"d1","type":"downtime","node":"t1","start":3600,"end":5400,"ts":3600}
{"id":"v1","type":"revoke","target":"d1","node":"t1","ts":8000}
```

退出码：`0` 正常；`2` 用法/校验错误；`10` 负计数；`11` 终态仍有 hold 未决（OEE 照常输出并附 pending 清单）。

## 测试

```sh
node --test
```

覆盖验收：任意分片合并等于全量；停机撤销后 OEE 回到独立参考值；墓碑防重复删除与复活；
≤10 事件枚举全部合并序对照（7 事件 5040 排列 + 6 事件 720 排列双折）；反熵补齐；CLI 退出码 10/11。
真实结果见 `test-results.txt`。
